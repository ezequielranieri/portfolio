---
title: El único camino entre tu aplicación y el modelo — agent-gateway, un Gateway/Control Plane multi-tenant para agentes LLM
slug: agent-gateway
project: agent-gateway
status: published
date: 2026-08-31T00:00:00.000Z
lang: es
tags:
  - Go
  - PostgreSQL
  - Redis
  - JWT
  - RLS
  - Rate Limiting
  - Audit Log
  - Human-in-the-Loop
  - Guardrails
  - Model Routing
  - Tool Sandbox
  - WebAssembly
  - Clean Architecture
  - Hexagonal Architecture
  - Observability
translationOf: agent-gateway-en
cover: ''
---

Cuando empecé agent-gateway, el problema era concreto: cualquier sistema que opere agentes LLM a escala termina enfrentando tres preguntas incómodas.

> **Estado actual: MVP complete** — Fases 0-8 implementadas (Foundation, Rate Limiting, Audit Log, HITL, Guardrails, **Model Routing**, **Tool Sandbox**, **External Guardrail Classifier**, **CI/CD + Observability**). **Tablas de pricing (migración 0014) sembradas con costos de modelos OpenAI, Anthropic y Ollama**.

1. **¿Cómo garantizás que ninguna llamada saltee el gateway?** Sin una capa de intercepción obligatoria, un `http.Post` directo a un endpoint LLM filtra datos, quema presupuesto y evade todo control.
2. **¿Cómo los datos, presupuesto y comportamiento de un tenant quedan aislados de otro?** Un `WHERE tenant_id = ?` olvidado en una query, un bucket de rate limit compartido, o un contexto de ejecución de tool filtrado es un incidente cross-tenant — no un bug, una brecha.
3. **¿Cómo probás qué pasó cuando algo falla?** "Lo hizo el modelo" no es un audit trail. Necesitás logs inmutables de cada llamada al modelo, ejecución de tool, decisión de guardrail y aprobación humana — queryables, reejecutables, a prueba de manipulación.

La tentación era la de siempre: poner un proxy sencillo delante del modelo y confiar en que "nadie va a hacer trampa". Ese enfoque ya me había fallado. La respuesta fue combinar **arquitectura zero-bypass** (cadena de middleware inquebrantable), **aislamiento de tenant enforzado en la base de datos** (RLS FORCE + PK compuesta), **audit log con hash-chaining por tenant**, **HITL como servicio reutilizable** (state machine + SSE), **guardrails como interfaz de dominio** (local + external classifier), **model routing con fallback y pricing**, y **tool sandbox con WebAssembly** — todo en un solo binario Go con Clean/Hexagonal Architecture.

## El problema de confiar en "nadie va a hacer trampa"

En un sistema multi-tenant con agentes LLM, el error clásico no es un ataque sofisticado: es una llamada directa que saltea los controles. Un desarrollador con prisa hace `openai.ChatCompletion.Create(...)` desde un handler y ya — saltó auth, tenant, rate limit, audit, guardrails. Una query sin `tenant_id` lee datos de otro tenant. Un rate limit global deja que un usuario ruidoso agote la cuota de todos.

agent-gateway ataca eso con **zero-bypass por construcción**: la cadena de middleware chi (`auth → tenant → ratelimit → audit → guardrails → model router`) es la **única** forma de llegar al modelo. No hay endpoint alternativo, no hay "atajo", no hay flag para desactivarlo.

```go
// cmd/gateway/main.go — composition root: la cadena es inmutable
func main() {
    // ...
    r := chi.NewRouter()
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)

    // La cadena zero-bypass — el orden importa y no se negocia
    r.Use(mw.Auth(jwtSvc))        // 1. Valida JWT HS256, extrae claims
    r.Use(mw.Tenant(tenantSvc))   // 2. Resuelve tenant, setea app.tenant_id (LOCAL tx)
    r.Use(mw.RateLimit(rlSvc))    // 3. 3 buckets: reqs/min, tokens/min, tool_execs/min
    r.Use(mw.Audit(auditSvc))     // 4. Append-only + hash-chain per tenant
    r.Use(mw.Guardrails(gSvc))    // 5. Local + external classifier, input/output
    r.Use(mw.HITL(hitlSvc))       // 6. Intercepta tools que requieren aprobación

    // Solo después de la cadena completa: model router
    r.Route("/v1", func(r chi.Router) {
        r.Post("/chat/completions", gatewayHandler.ChatCompletions)
        // ... otros endpoints protegidos por la misma cadena
    })
}
```

Si un handler intenta llamar al modelo sin pasar por el router, no compila — el `ModelProvider` port vive en `internal/domain/model` y solo el `GatewayService` (usecase) lo tiene inyectado.

## Decisiones de diseño clave

### 1. Tenancy: RLS FORCE + PK compuesta — defensa en profundidad real

El aislamiento no vive en un `WHERE` que alguien puede olvidar. Vive en PostgreSQL:

```sql
-- Cada tabla tenanted: RLS FORCE + PK compuesta (id, tenant_id)
CREATE TABLE private.audit_events (
    id              uuid NOT NULL,
    tenant_id       uuid NOT NULL REFERENCES public.tenants(id),
    seq             bigint NOT NULL,
    prev_hash       char(64) NOT NULL,
    chain_hash      char(64) NOT NULL,
    actor_user_id   uuid,
    action          text NOT NULL,
    entity_type     text NOT NULL,
    entity_id       uuid,
    payload         jsonb NOT NULL,
    severity        text NOT NULL DEFAULT 'info',
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, tenant_id),
    UNIQUE (tenant_id, seq)
);

CREATE POLICY tenant_isolation ON private.audit_events
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
ALTER TABLE private.audit_events FORCE ROW LEVEL SECURITY;
```

- `current_setting('app.tenant_id')` devuelve `NULL` si no está seteado — un predicado `NULL` es **siempre falso**, así que una query sin contexto devuelve **cero filas, nunca un leak**.
- El contexto se bindea **dentro de una transacción** con `SELECT set_config('app.tenant_id', $1, true)` — el `true` hace el setting `LOCAL`. Un `SET` plano en conexiones pooled leakea tenant A en requests de tenant B; el scoping transaccional lo previene.
- `FORCE` extiende RLS al owner de la tabla: ni `psql` crudo ni una query buggy cruzan tenants sin superuser.
- PK compuesta `(id, tenant_id)` cierra el side-channel: una FK de tabla no protegida no puede referenciar (y revelar) una fila de otro tenant.

```go
// internal/adapter/postgres/db.go — WithTenant: la ÚNICA forma de acceder a datos tenanted
func (db *DB) WithTenant(ctx context.Context, tenantID uuid.UUID, fn func(context.Context) error) error {
    return pgx.BeginTxFunc(ctx, pgx.TxOptions{}, func(tx pgx.Tx) error {
        // LOCAL = scoped a ESTA transacción, no a la conexión pooled
        if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID.String()); err != nil {
            return err
        }
        return fn(pgx.InjectTx(ctx, tx))
    })
}

// Uso en repositorios — SIEMPRE via WithTenant, nunca query directa
func (r *PostgresAuditRepository) Append(ctx context.Context, evt *domain.AuditEvent) error {
    return r.db.WithTenant(ctx, evt.TenantID, func(ctx context.Context) error {
        // RLS FORCE garantiza que el INSERT respete tenant_id
        return r.queries.InsertAuditEvent(ctx, pgxargs...)
    })
}
```

### 2. Audit log que sobrevive al compromiso: hash-chaining por tenant

El audit trail no es "confía en que la DB no la toquen". Es **inmutable y verificable**:

```go
// internal/usecase/audit/audit.go — chain_hash = SHA256(prev_hash|seq|tenant_id|actor|action|entity_type|entity_id|payload|created_at)
func (s *AuditService) computeChainHash(prevHash string, seq int64, tenantID uuid.UUID, evt *domain.AuditEvent) string {
    // Canonicalización: decode → re-marshal JSON para estabilidad
    payload, _ := json.Marshal(evt.Payload)
    created := evt.CreatedAt.Truncate(time.Microsecond).Format(time.RFC3339Nano)

    parts := []string{
        prevHash,
        strconv.FormatInt(seq, 10),
        tenantID.String(),
        evt.ActorUserID.String(),
        evt.Action,
        evt.EntityType,
        evt.EntityID.String(),
        string(payload),
        created,
    }
    h := sha256.Sum256([]byte(strings.Join(parts, "|")))
    return hex.EncodeToString(h[:])
}

// VerifyChain — detector interno de manipulación
func (s *AuditService) VerifyChain(ctx context.Context, tenantID uuid.UUID) (brokenSeq int64, err error) {
    // Recorre seq 1..N recomputando chain_hash; devuelve el primer seq roto
}
```

Cada tenant tiene su propia cadena (`seq` reinicia en 1). Un atacante que modifique una fila rompe el `chain_hash` de esa fila y todas las subsiguientes — `VerifyChain` detecta el primer `seq` corrupto.

### 3. HITL: el agente pide permiso, nunca escribe directo

Cualquier acción de escritura (crear recurso, ejecutar tool sensible, cambiar config) pasa por HITL:

```go
// internal/usecase/hitl/hitl.go — State machine + token opaco + re-validación completa
func (s *HITLService) CreateRequest(ctx context.Context, req *domain.ReviewRequest) (*domain.ReviewRequest, string, error) {
    // Token opaco: 32 bytes random, hex. SOLO se guarda su SHA-256.
    tokenBytes := make([]byte, 32)
    if _, err := rand.Read(tokenBytes); err != nil {
        return nil, "", err
    }
    token := hex.EncodeToString(tokenBytes)
    hash := sha256.Sum256([]byte(token))

    req.TokenHash = hex.EncodeToString(hash[:])
    req.Status = domain.ReviewStatusPending
    req.ExpiresAt = time.Now().Add(24 * time.Hour)

    if err := s.repo.Create(ctx, req); err != nil {
        return nil, "", err
    }
    return req, token, nil // token se devuelve UNA vez al caller (el agente)
}

func (s *HITLService) Approve(ctx context.Context, token string, approverID uuid.UUID) error {
    // Timing-safe compare del hash
    hash := sha256.Sum256([]byte(token))
    req, err := s.repo.FindByTokenHash(ctx, hex.EncodeToString(hash[:]))
    // ... validaciones: PENDING, no expirado, RBAC (admin/operator)

    // RE-VALIDACIÓN COMPLETA al aprobar — fail-closed
    var payload map[string]any
    if err := json.Unmarshal(req.Payload, &payload); err != nil {
        return domain.ErrInvalidPayload
    }
    // Re-resolver IDs dentro del tenant, validar permisos, etc.

    // Materializar + marcar EXECUTED en misma transacción
    return s.repo.Execute(ctx, req.ID, approverID)
}
```

- La DB guarda el **hash SHA-256**, nunca el token en claro.
- Aprobación + ejecución en una transacción con guarda condicional: dos approves concurrentes con el mismo token no pueden ejecutar dos veces — solo el ganador commitea.
- SSE streaming nativo (`/v1/reviews/{id}/stream`) para status en tiempo real — compatible con `curl -N`, sin WebSockets ni sticky sessions.

### 4. Guardrails: interfaz de dominio + local + external classifier

```go
// internal/domain/guardrail/guardrail.go — Port pura, cero deps
type Guardrail interface {
    CheckInput(ctx context.Context, req *CheckInputRequest) (*CheckResult, error)
    CheckOutput(ctx context.Context, req *CheckOutputRequest) (*CheckResult, error)
}

// internal/adapter/guardrail/local.go — LocalGuardrail: regex, wordlist, PII, injection heuristics
// Cero red, cero API keys, corre in-process

// internal/adapter/guardrail/external.go — ExternalClassifier adapter (OpenAI Moderation, Anthropic, Llama Guard via Ollama)
// Implementa retry + circuit breaker, thresholds por categoría

// internal/adapter/guardrail/composite.go — CompositeGuardrail: merge logic (any/all/weighted)
// Fail behaviors: fallback_local / fail_open / fail_closed
// Flag SendContentExternal para data residency
```

Input validation fails closed (reject). Output validation fails closed (reject o sanitize según severidad). Violaciones se registran en audit log con severidad `critical`.

### 5. Model Routing: Provider Port + Fallback Chain + Pricing

```go
// internal/domain/model/provider.go
type ModelProvider interface {
    ChatCompletion(ctx context.Context, req *ChatRequest) (*ChatResponse, error)
    EstimateCost(req *ChatRequest) (USDPer1kTokens, error)
    Name() string
}

// internal/adapter/provider/openai.go — Adapter completo
// internal/adapter/provider/anthropic.go, ollama.go — Stubs (extensibles)

// internal/usecase/chat/router.go — FallbackChain con bounded retries + half-open circuit breaker
type FallbackChain struct {
    providers []ModelProvider
    breaker   *CircuitBreaker
    pricing   PricingService
}

func (fc *FallbackChain) ChatCompletion(ctx context.Context, req *ChatRequest) (*ChatResponse, error) {
    // Pre-estimate cost via PricingService
    // Try primary → on error/timeout: bounded retry → half-open → secondary → local (Ollama)
    // Post-actual cost → rate limit (tokens/min) + audit
}
```

`PricingService` usa tablas versionadas `provider + model → USD/1k tokens` (migración 0014 sembrada con costos de OpenAI, Anthropic, Ollama). Costos pre-estimados y reales se integran con rate limit y audit.

### 6. Tool Sandbox: ToolExecutor + WebAssembly (wazero)

```go
// internal/domain/tool/executor.go
type ToolExecutor interface {
    Execute(ctx context.Context, call *ToolCall, cfg *ToolConfig) (*ToolResult, error)
}

// internal/adapter/tool/wasm.go — WasmExecutor (wazero)
// - Fuel limit (instrucciones), memory limit (bytes), wall-time limit
// - Read-only FS mounts, no network by default
// - Per-execution module instantiation (aislamiento total)
// - Bounded agent loop: max 5 iteraciones, HITL gate para tools que requieren aprobación
// - Per-step cost/audit/rate-limit accounting

// internal/adapter/tool/mock.go — MockExecutor para tests unitarios
```

El agente no ejecuta código arbitrario: el gateway valida, sandboxea, audita, rate-limita y pide aprobación humana si el tool lo requiere.

## Qué gana uno con este enfoque

| Garantía | Cómo se logra |
|---|---|
| Ninguna llamada saltea el gateway | Cadena middleware inmutable (auth→tenant→ratelimit→audit→guardrails→router) en composition root |
| Aislamiento de tenant a prueba de bugs | RLS FORCE + PK compuesta `(id, tenant_id)` + `set_config(..., true)` LOCAL tx + middleware cross-check |
| Audit trail inmutable y verificable | Append-only + hash-chaining por tenant (`seq`, `prev_hash`, `chain_hash`) + `VerifyChain` detector |
| El modelo no muta datos sin humano | HITL: request `PENDING` + token opaco (SHA-256) + re-validación completa al aprobar + transacción atómica |
| Token de aprobación no se filtra | Solo hash en DB; timing-safe compare; TTL 24h; family revocation en reuse |
| Rate limiting granular y atómico | Redis `redis_rate` (Lua/token bucket) 3 dims: reqs/min, tokens/min, tool_execs/min — por tenant/user/role |
| Guardrails extensibles sin tocar dominio | Interfaz `Guardrail` + `LocalGuardrail` (regex/PII) + `ExternalClassifier` adapter + `CompositeGuardrail` merge |
| Fallback de modelo con control de costo | Provider port + `FallbackChain` (bounded retry + circuit breaker) + `PricingService` versionado + pre/post cost tracking |
| Tools aislados del host y otros tenants | `ToolExecutor` port + `WasmExecutor` (wazero) fuel/memory/time/FS/network limits + bounded loop + HITL gate |
| Observabilidad sin vendor lock-in | OpenTelemetry stdout + Prometheus `/metrics` + Grafana dashboards auto-provisionados + Loki/Promtail + Jaeger |
| CI/CD con secretos seguros | GitHub Actions + SOPS/age (`.env.enc` en repo) + canary deploy script + cosign signing |

Cada garantía de la tabla tiene su test de integración contra PostgreSQL y Redis reales (testcontainers-go), no mocks.

## Lo que conscientemente dejé fuera del MVP

Mismo principio que `go-authz` y `agro-iam`: nombrado explícito, no silenciosamente ausente.

| Ítem | Razón | Criterio de salida |
|---|---|---|
| Schema-per-tenant isolation | RLS en instancia compartida basta para threat model actual | Solo si aparece requisito concreto de aislamiento mayor |
| Full-history secret scanning en CI | CI escanea diffs de PR + rango pusheado; full history = alert fatigue | Gitleaks + Trivy en CI; job programado si se necesita |

La decisión de no sumar infra prematura está documentada en `DECISIONS.md`. Si una tarea entra en conflicto con esas reglas, se detiene y se discute antes de implementar.

## Conclusión

agent-gateway demuestra que operar agentes LLM a escala no requiere "confiar en que nadie hace trampa". Requiere **arquitectura zero-bypass** (la cadena middleware es la única forma de llegar al modelo), **aislamiento estructural en la base de datos** (RLS FORCE + PK compuesta, no un WHERE), **auditoría que sobrevive al compromiso** (hash-chaining por tenant), y **controles reutilizables como servicios de dominio** (HITL, guardrails, routing, sandbox) — no lógica dispersa en handlers.

La lección que se repite: **un LLM no es el lugar para las garantías de seguridad — es el lugar para la flexibilidad.** El routing se decide en el router, la escritura se gobierna con HITL, el tenant se aísla en el contexto de transacción, los guardrails viven en una interfaz de dominio, y las tools se ejecutan en un sandbox. Cuando cada garantía vive en una capa determinista y testeable, el sistema sigue correcto incluso cuando el modelo se equivoca.

El código está abierto en [github.com/ezequielranieri/agent-gateway](https://github.com/ezequielranieri/agent-gateway) con CI verde, docs bilingües, OpenAPI 3.1, 14 migraciones (0001_extensions a 0014_pricing_tables) y roadmap de 8 fases completado — desde Foundation hasta CI/CD + Observabilidad.