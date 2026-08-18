---
title: Un agente agrícola que consulta datos reales, pero no puede escribir sin aprobación humana
slug: agro-agent-demo
project: agro-agent
status: published
date: 2026-08-17T00:00:00.000Z
lang: es
tags:
  - Go
  - PostgreSQL
  - pgvector
  - RAG
  - LLM
  - Tool Calling
  - Human-in-the-Loop
  - Clean Architecture
  - Evals
translationOf: agro-agent-demo-en
cover: ''
---

Cuando empecé agro-agent, el problema era concreto: los agrónomos de una cooperativa quieren preguntar en lenguaje natural —"¿qué lotes tienen aplicaciones con retraso?", "¿cuál es el protocolo para herbicidas en trigo?"— y obtener respuestas ancladas en **datos reales**, jamás en la memoria del modelo. El mismo ecosistema que ya tenía en agro-iam (multi-tenant, con aislamiento como garantía), pero ahora con un agente que además de leer quiere *escribir*. Y con un frontend propio, **agro-web** (Next.js), para que el agrónomo chatee, vea sus lotes y apruebe solicitudes sin tocar la API.

Y me hice tres preguntas antes de escribir la primera línea:

1. ¿Cómo logro que el LLM elija la herramienta correcta sin cruzar de dominio — datos estructurados vs. documentos RAG — cuando el modelo es no-determinista?
2. ¿Cómo permito que el agente programe una aplicación de glifosato sin que un modelo alucinado mute datos de producción directamente?
3. ¿Cómo demuestro que el routing es correcto, si no puedo confiar en "probé una vez y anduvo"?

La tentación era la de siempre: exponer todas las tools al LLM y confiar en que la descripción le baste para no equivocarse. Ese enfoque ya me había fallado. La respuesta fue combinar tres piezas: **un router determinista que expone solo las tools del dominio detectado, human-in-the-loop con tokens opacos para toda escritura, y un golden set de evals que mide el routing en cada corrida.**

## El problema de confiar en la descripción de la tool

En un agente con tool calling, el error clásico no es un ataque sofisticado: es el modelo que cruza de dominio. Preguntan por "el protocolo de herbicidas para trigo" y el LLM decide consultar la tabla de aplicaciones en vez de los documentos — o al revés. Cada cruce es una respuesta equivocada con total seguridad.

agro-agent ataca eso con un sesgo determinista antes del LLM: un clasificador de dominio decide si la consulta es de *datos* o de *documentos*, y solo expone las tools de ese dominio. Y por si el router fallara, la descripción de cada tool lleva escrita la misma frontera como red de seguridad:

```go
const (
	discernimientoDatosSufijo      = " NO uses esta tool para procedimientos, protocolos o recomendaciones: esa información vive en los documentos (buscar_documentos)."
	discernimientoDocumentosSufijo = " NO uses esta tool para datos de lotes, rendimientos, aplicaciones o solicitudes: esos datos viven en la DB (consultar_lotes, consultar_rendimientos, etc.)."
)
```

El router es el sesgo determinista; la descripción es la red de seguridad que el LLM lee siempre. Si uno falla, el otro lo cubre — y los evals miden los dos.

## Decisiones de diseño clave

### 1. HITL: el agente pide permiso, nunca escribe directo

El agente quiere programar una aplicación. La regla: la tool NO inserta nada. Crea una solicitud pendiente con un token opaco de aprobación; un humano (admin o agrónomo) la aprueba presentando el token; **al aprobar se re-valida el contexto** — lote, producto, campaña, dosis y vigencia — y recién entonces se inserta la aplicación.

```go
// newToken genera el token opaco de aprobación: 32 bytes aleatorios en hex.
// No lleva significado: es un secreto de un solo uso presentado por el humano.
// Se persiste únicamente su hash sha256 — la DB no puede filtrar el secreto.
func newToken() (token, hash string, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", fmt.Errorf("approval: generar token: %w", err)
	}
	token = hex.EncodeToString(buf)
	sum := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(sum[:]), nil
}
```

La DB guarda el hash, nunca el token. La aprobación y la inserción viven en la misma transacción con guarda condicional: dos approves concurrentes con el mismo token no pueden insertar una aplicación duplicada — solo el ganador commitea. Un payload manipulado no escapa a la validación porque se re-parsea fail-closed al aprobar.

### 2. Fallback multi-proveedor y RAG en el mismo Postgres

El agente usa Gemini como proveedor principal, pero cuando la cuota free tier se agota, cae automáticamente a Groq — sin cambiar una línea del orquestador. La RAG vive en el mismo Postgres con `pgvector`: los documentos se embedden y se consultan con una tool que devuelve solo los pasajes relevantes al tenant.

### 3. Ingesta accept-both: el ecosistema agro-iam entra sin reescribir

agro-agent nunca emite tokens propios: consume los de agro-iam con ingesta accept-both. Un `tenant_id` entero (demo) se usa directo; un `tenant_id` UUID (agro-iam) se resuelve vía `tenants.uuid`; los roles en inglés se normalizan (`agronomist`→`agronomo`); y un `sub` UUID se resuelve acotado al tenant. Lo que no resuelve, falla cerrado — nunca un leak.

### 4. agro-web: el frontend que completa el ecosistema

El backend no vive solo: **agro-web** es el frontend Next.js que lo consume. El chat con streaming, la vista de lotes y aplicaciones, y el panel de aprobaciones HITL (donde el agrónomo pega el token y aprueba o rechaza). Un detalle de diseño que vale la pena: el frontend proxya las llamadas al backend del lado servidor (`src/app/api/chat/route.ts`), así el navegador jamás ve la URL del backend — una sola superficie de entrada, sin CORS ni exposición de infraestructura.

## Qué gana uno con este enfoque

| Garantía | Cómo se logra |
|---|---|
| El LLM no cruza de dominio | Router determinista + sufijos de descripción como red de seguridad |
| El modelo no muta datos de producción | HITL: solicitud pendiente + token opaco + re-validación al aprobar |
| El token de aprobación no se filtra | Solo se persiste su hash sha256, nunca el valor en claro |
| Sin aplicaciones duplicadas por carrera | Aprobación + inserción en una transacción con guarda condicional |
| Respuestas ancladas en datos reales | Tools que consultan la DB del tenant + RAG con pgvector |
| El routing se puede medir | Golden set de evals: tools esperadas, prohibidas, y anti-alucinación |

Cada garantía de la tabla tiene su test, y los evals corren contra el agente real (Gemini + Postgres), no contra mocks.

## Lo que conscientemente dejé fuera

- **Deploy en un host público.** El free tier de Render ya lo ocupa agro-iam y no hay plan pago; el backend corre local con Docker Compose + Neon. Prefiero decirlo explícito antes que fingir una demo en vivo. Las capturas reales están en el README.
- **Rate limiting distribuido / Redis.** Un solo binario detrás de un proxy no lo necesita todavía.
- **Métricas Prometheus / tracing.** Solo logging estructurado con `slog` y healthchecks.
- **Corrida live del eval como gate.** El harness existe y mide por tendencia; automatizarlo contra la cuota free diaria es el siguiente paso, no una promesa.

## Conclusión

agro-agent demuestra que un agente puede ser útil y auditable a la vez: consulta datos reales con RAG, elige sus herramientas con un sesgo determinista en vez de fe, y para escribir necesita que un humano presente un token que nadie más puede rejugar.

La lección que se repite: **un LLM no es el lugar para las garantías de seguridad — es el lugar para la flexibilidad.** El routing se sesga en el router, la escritura se gobierna con HITL, y el tenant se aísla en el contexto. Cuando cada garantía vive en una capa determinista y testeable, el sistema sigue correcto incluso cuando el modelo se equivoca.

El código está abierto en [github.com/ezequielranieri/agro-agent](https://github.com/ezequielranieri/agro-agent) con CI verde, docs bilingües y capturas reales — y el frontend en [github.com/ezequielranieri/agro-web](https://github.com/ezequielranieri/agro-web).