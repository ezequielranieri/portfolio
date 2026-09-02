---
title: The Only Path Between Your Application and the Model — agent-gateway, a Multi-tenant Gateway/Control Plane for LLM Agents
slug: agent-gateway-en
project: agent-gateway
status: published
date: 2026-08-31T00:00:00.000Z
lang: en
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
  - Hexagonal Architecture
  - Observability
translationOf: agent-gateway
cover: ''
---

When I started agent-gateway, the problem was concrete: any system running LLM agents at scale eventually faces three uncomfortable questions.

> **Current status: MVP complete** — Phases 0-8 implemented (Foundation, Rate Limiting, Audit Log, HITL, Guardrails, **Model Routing**, **Tool Sandbox**, **External Guardrail Classifier**, **CI/CD + Observability**). **Pricing tables (migration 0014) seeded with OpenAI, Anthropic, and Ollama model costs**.

1. **How do you ensure no call bypasses the gateway?** Without a mandatory interception layer, a single `http.Post` to an LLM endpoint leaks data, burns budget, and evades every control.
2. **How do one tenant's data, budget, and agent behavior stay isolated from another's?** A missing `WHERE tenant_id = ?` in one query, a shared rate limit bucket, or a leaked tool execution context is a cross-tenant incident — not a bug, a breach.
3. **How do you prove what happened when something goes wrong?** "The model did it" is not an audit trail. You need immutable logs of every model call, tool execution, guardrail decision, and human approval — queryable, replayable, tamper-evident.

The temptation was the usual move: put a simple proxy in front of the model and trust that "no one will cheat." That approach had already failed me. The answer was combining **zero-bypass architecture** (an unbreakable middleware chain), **tenant isolation enforced at the database** (RLS FORCE + composite PK), **audit log with per-tenant hash-chaining**, **HITL as a reusable service** (state machine + SSE), **guardrails as a domain interface** (local + external classifier), **model routing with fallback and pricing**, and **tool sandbox with WebAssembly** — all in a single Go binary with Clean/Hexagonal Architecture.

## The problem with trusting "no one will cheat"

In a multi-tenant system with LLM agents, the classic failure isn't a sophisticated attack: it's a direct call that bypasses controls. A rushed developer does `openai.ChatCompletion.Create(...)` from a handler and done — skipped auth, tenant, rate limit, audit, guardrails. A query without `tenant_id` reads another tenant's data. A global rate limit lets one noisy user exhaust everyone's quota.

agent-gateway attacks this with **zero-bypass by construction**: the chi middleware chain (`auth → tenant → ratelimit → audit → guardrails → model router`) is the **only** way to reach the model. No alternative endpoint, no "shortcut," no flag to disable it.

```go
// cmd/gateway/main.go — composition root: the chain is immutable
func main() {
    // ...
    r := chi.NewRouter()
    r.Use(middleware.RequestID)
    r.Use(middleware.RealIP)
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)

    // The zero-bypass chain — order matters and is non-negotiable
    r.Use(mw.Auth(jwtSvc))        // 1. Validate JWT HS256, extract claims
    r.Use(mw.Tenant(tenantSvc))   // 2. Resolve tenant, set app.tenant_id (LOCAL tx)
    r.Use(mw.RateLimit(rlSvc))    // 3. 3 buckets: reqs/min, tokens/min, tool_execs/min
    r.Use(mw.Audit(auditSvc))     // 4. Append-only + hash-chain per tenant
    r.Use(mw.Guardrails(gSvc))    // 5. Local + external classifier, input/output
    r.Use(mw.HITL(hitlSvc))       // 6. Intercept tools requiring approval

    // Only after the full chain: model router
    r.Route("/v1", func(r chi.Router) {
        r.Post("/chat/completions", gatewayHandler.ChatCompletions)
        // ... other endpoints protected by the same chain
    })
}
```

If a handler tries to call the model without going through the router, it won't compile — the `ModelProvider` port lives in `internal/domain/model` and only the `GatewayService` (usecase) has it injected.

## Key design decisions

### 1. Tenancy: RLS FORCE + Composite PK — real defense in depth

Isolation doesn't live in a `WHERE` clause someone can forget. It lives in PostgreSQL:

```sql
-- Every tenanted table: RLS FORCE + composite PK (id, tenant_id)
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

- `current_setting('app.tenant_id')` returns `NULL` if unset — a `NULL` predicate is **always false**, so a query without context returns **zero rows, never a leak**.
- Context is bound **inside a transaction** with `SELECT set_config('app.tenant_id', $1, true)` — the `true` makes it `LOCAL`. A plain `SET` on pooled connections would leak tenant A into tenant B's requests; transaction scoping prevents that.
- `FORCE` extends RLS to the table owner: neither raw `psql` nor a buggy query can cross tenants without superuser.
- Composite PK `(id, tenant_id)` closes the side-channel: an FK from an unprotected table cannot reference (and thereby reveal) another tenant's row.

```go
// internal/adapter/postgres/db.go — WithTenant: the ONLY way to access tenanted data
func (db *DB) WithTenant(ctx context.Context, tenantID uuid.UUID, fn func(context.Context) error) error {
    return pgx.BeginTxFunc(ctx, pgx.TxOptions{}, func(tx pgx.Tx) error {
        // LOCAL = scoped to THIS transaction, not the pooled connection
        if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID.String()); err != nil {
            return err
        }
        return fn(pgx.InjectTx(ctx, tx))
    })
}

// Repository usage — ALWAYS via WithTenant, never direct query
func (r *PostgresAuditRepository) Append(ctx context.Context, evt *domain.AuditEvent) error {
    return r.db.WithTenant(ctx, evt.TenantID, func(ctx context.Context) error {
        // RLS FORCE guarantees the INSERT respects tenant_id
        return r.queries.InsertAuditEvent(ctx, pgxargs...)
    })
}
```

### 2. Audit log that survives compromise: per-tenant hash-chaining

The audit trail isn't "trust the DB isn't touched." It's **immutable and verifiable**:

```go
// internal/usecase/audit/audit.go — chain_hash = SHA256(prev_hash|seq|tenant_id|actor|action|entity_type|entity_id|payload|created_at)
func (s *AuditService) computeChainHash(prevHash string, seq int64, tenantID uuid.UUID, evt *domain.AuditEvent) string {
    // Canonicalization: decode → re-marshal JSON for stability
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

// VerifyChain — internal tamper detector
func (s *AuditService) VerifyChain(ctx context.Context, tenantID uuid.UUID) (brokenSeq int64, err error) {
    // Walks seq 1..N recomputing chain_hash; returns first broken seq
}
```

Each tenant has its own chain (`seq` restarts at 1). An attacker modifying a row breaks the `chain_hash` of that row and all subsequent ones — `VerifyChain` detects the first corrupt `seq`.

### 3. HITL: the agent asks for permission, never writes directly

Any write action (create resource, execute sensitive tool, change config) goes through HITL:

```go
// internal/usecase/hitl/hitl.go — State machine + opaque token + full re-validation
func (s *HITLService) CreateRequest(ctx context.Context, req *domain.ReviewRequest) (*domain.ReviewRequest, string, error) {
    // Opaque token: 32 random bytes, hex. ONLY its SHA-256 is stored.
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
    return req, token, nil // token returned ONCE to caller (the agent)
}

func (s *HITLService) Approve(ctx context.Context, token string, approverID uuid.UUID) error {
    // Timing-safe hash compare
    hash := sha256.Sum256([]byte(token))
    req, err := s.repo.FindByTokenHash(ctx, hex.EncodeToString(hash[:]))
    // ... validations: PENDING, not expired, RBAC (admin/operator)

    // FULL RE-VALIDATION on approve — fail-closed
    var payload map[string]any
    if err := json.Unmarshal(req.Payload, &payload); err != nil {
        return domain.ErrInvalidPayload
    }
    // Re-resolve IDs inside tenant, validate permissions, etc.

    // Materialize + mark EXECUTED in same transaction
    return s.repo.Execute(ctx, req.ID, approverID)
}
```

- DB stores the **SHA-256 hash**, never the plaintext token.
- Approval + execution in one transaction with conditional guard: two concurrent approvals with the same token can't execute twice — only the winner commits.
- Native SSE streaming (`/v1/reviews/{id}/stream`) for real-time status — `curl -N` compatible, no WebSockets or sticky sessions.

### 4. Guardrails: domain interface + local + external classifier

```go
// internal/domain/guardrail/guardrail.go — Pure port, zero deps
type Guardrail interface {
    CheckInput(ctx context.Context, req *CheckInputRequest) (*CheckResult, error)
    CheckOutput(ctx context.Context, req *CheckOutputRequest) (*CheckResult, error)
}

// internal/adapter/guardrail/local.go — LocalGuardrail: regex, wordlist, PII, injection heuristics
// Zero network, zero API keys, runs in-process

// internal/adapter/guardrail/external.go — ExternalClassifier adapter (OpenAI Moderation, Anthropic, Llama Guard via Ollama)
// Implements retry + circuit breaker, per-category thresholds

// internal/adapter/guardrail/composite.go — CompositeGuardrail: merge logic (any/all/weighted)
// Fail behaviors: fallback_local / fail_open / fail_closed
// SendContentExternal flag for data residency
```

Input validation fails closed (reject). Output validation fails closed (reject or sanitize by severity). Violations recorded in audit log with `critical` severity.

### 5. Model Routing: Provider Port + Fallback Chain + Pricing

```go
// internal/domain/model/provider.go
type ModelProvider interface {
    ChatCompletion(ctx context.Context, req *ChatRequest) (*ChatResponse, error)
    EstimateCost(req *ChatRequest) (USDPer1kTokens, error)
    Name() string
}

// internal/adapter/provider/openai.go — Full adapter
// internal/adapter/provider/anthropic.go, ollama.go — Stubs (extensible)

// internal/usecase/chat/router.go — FallbackChain with bounded retries + half-open circuit breaker
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

`PricingService` uses versioned tables `provider + model → USD/1k tokens` (migration 0014 seeded with OpenAI, Anthropic, Ollama costs). Pre-estimated and actual costs integrate with rate limit and audit.

### 6. Tool Sandbox: ToolExecutor + WebAssembly (wazero)

```go
// internal/domain/tool/executor.go
type ToolExecutor interface {
    Execute(ctx context.Context, call *ToolCall, cfg *ToolConfig) (*ToolResult, error)
}

// internal/adapter/tool/wasm.go — WasmExecutor (wazero)
// - Fuel limit (instructions), memory limit (bytes), wall-time limit
// - Read-only FS mounts, no network by default
// - Per-execution module instantiation (total isolation)
// - Bounded agent loop: max 5 iterations, HITL gate for tools requiring approval
// - Per-step cost/audit/rate-limit accounting

// internal/adapter/tool/mock.go — MockExecutor for unit tests
```

The agent doesn't run arbitrary code: the gateway validates, sandboxes, audits, rate-limits, and asks for human approval if the tool requires it.

## What you gain with this approach

| Guarantee | How it's achieved |
|---|---|
| No call bypasses the gateway | Immutable middleware chain (auth→tenant→ratelimit→audit→guardrails→router) in composition root |
| Tenant isolation survives bugs | RLS FORCE + composite PK `(id, tenant_id)` + `set_config(..., true)` LOCAL tx + middleware cross-check |
| Immutable, verifiable audit trail | Append-only + per-tenant hash-chaining (`seq`, `prev_hash`, `chain_hash`) + `VerifyChain` detector |
| Model can't mutate data without human | HITL: `PENDING` request + opaque token (SHA-256) + full re-validation on approve + atomic transaction |
| Approval token can't leak | Only hash in DB; timing-safe compare; 24h TTL; family revocation on reuse |
| Granular, atomic rate limiting | Redis `redis_rate` (Lua/token bucket) 3 dims: reqs/min, tokens/min, tool_execs/min — per tenant/user/role |
| Extensible guardrails without touching domain | `Guardrail` interface + `LocalGuardrail` (regex/PII) + `ExternalClassifier` adapter + `CompositeGuardrail` merge |
| Model fallback with cost control | Provider port + `FallbackChain` (bounded retry + circuit breaker) + versioned `PricingService` + pre/post cost tracking |
| Tools isolated from host and other tenants | `ToolExecutor` port + `WasmExecutor` (wazero) fuel/memory/time/FS/network limits + bounded loop + HITL gate |
| Observability without vendor lock-in | OpenTelemetry stdout + Prometheus `/metrics` + auto-provisioned Grafana + Loki/Promtail + Jaeger |
| CI/CD with secure secrets | GitHub Actions + SOPS/age (`.env.enc` in repo) + canary deploy script + cosign signing |

Every guarantee in the table has its integration test against real PostgreSQL and Redis (testcontainers-go), not mocks.

## What I consciously left out of the MVP

Same principle as `go-authz` and `agro-iam`: named explicitly, not silently absent.

| Item | Reason | Exit Criteria |
|---|---|---|
| Schema-per-tenant isolation | RLS on shared instance suffices for current threat model | Only if concrete requirement for stronger isolation appears |
| Full-history secret scanning in CI | CI scans PR diffs + pushed range; full history = alert fatigue | Gitleaks + Trivy in CI; scheduled job if needed |

The decision not to add premature infra is documented in `DECISIONS.md`. If a task conflicts with those rules, it stops and gets discussed before implementing.

## Conclusion

agent-gateway proves that operating LLM agents at scale doesn't require "trusting no one cheats." It requires **zero-bypass architecture** (the middleware chain is the only way to reach the model), **structural isolation in the database** (RLS FORCE + composite PK, not a WHERE clause), **auditing that survives compromise** (per-tenant hash-chaining), and **reusable controls as domain services** (HITL, guardrails, routing, sandbox) — not scattered logic in handlers.

The lesson repeats itself: **an LLM isn't the place for security guarantees — it's the place for flexibility.** Routing is decided in the router, writes are governed by HITL, the tenant is isolated in the transaction context, guardrails live in a domain interface, and tools run in a sandbox. When every guarantee sits in a deterministic, testable layer, the system stays correct even when the model makes mistakes.

The code is open at [github.com/ezequielranieri/agent-gateway](https://github.com/ezequielranieri/agent-gateway) with green CI, bilingual docs, OpenAPI 3.1, 14 migrations (0001_extensions through 0014_pricing_tables), and an 8-phase roadmap completed — from Foundation through CI/CD + Observability.