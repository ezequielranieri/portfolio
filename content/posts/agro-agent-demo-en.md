---
title: An Agricultural Agent That Reads Real Data, but Can't Write Without Human Approval
slug: agro-agent-demo-en
project: agro-agent
status: published
date: 2026-08-17T00:00:00.000Z
lang: en
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
translationOf: agro-agent-demo
cover: ''
---

When I started agro-agent, the problem was concrete: a cooperative's agronomists want to ask questions in natural language — "which lots have delayed applications?", "what's the protocol for applying herbicides to wheat?" — and get answers grounded in **real data**, never in the model's memory. The same ecosystem I already had in agro-iam (multi-tenant, with isolation as a guarantee), but now with an agent that, beyond reading, wants to *write*. And with its own frontend, **agro-web** (Next.js), so the agronomist can chat, see their lots, and approve requests without touching the API.

I asked myself three questions before writing the first line:

1. How do I get the LLM to pick the right tool without crossing domains — structured data vs. RAG documents — when the model is non-deterministic?
2. How do I let the agent schedule a glyphosate application without a hallucinating model mutating production data directly?
3. How do I prove the routing is correct, when I can't trust "I tried it once and it worked"?

The temptation was the usual move: expose every tool to the LLM and trust its description to keep it from making mistakes. That approach had already failed me. The answer was combining three pieces: **a deterministic router that exposes only the tools of the detected domain, human-in-the-loop with opaque tokens for every write, and a golden-set eval harness that measures routing on every run.**

## The problem with trusting the tool description

In a tool-calling agent, the classic failure isn't a sophisticated attack: it's the model crossing domains. Someone asks about "the herbicide protocol for wheat" and the LLM decides to query the applications table instead of the documents — or the other way around. Every crossing is a confidently wrong answer.

agro-agent attacks that with a deterministic bias before the LLM: a domain classifier decides whether the query is about *data* or *documents*, and only exposes the tools of that domain. And in case the router fails, each tool description carries the same boundary written into it as a safety net:

```go
const (
	discernimientoDatosSufijo      = " DO NOT use this tool for procedures, protocols, or recommendations: that information lives in the documents (buscar_documentos)."
	discernimientoDocumentosSufijo = " DO NOT use this tool for lot, yield, application, or request data: that data lives in the DB (consultar_lotes, consultar_rendimientos, etc.)."
)
```

The router is the deterministic bias; the description is the safety net the LLM always reads. If one fails, the other covers it — and the evals measure both.

## Key design decisions

### 1. HITL: the agent asks for permission, never writes directly

The agent wants to schedule an application. The rule: the tool inserts NOTHING. It creates a pending request with an opaque approval token; a human (admin or agronomist) approves by presenting the token; **on approval the context is re-validated** — lot, product, campaign, dosage, and validity — and only then is the application inserted.

```go
// newToken generates the opaque approval token: 32 random bytes in hex.
// It carries no meaning: a single-use secret presented by the human.
// Only its sha256 hash is persisted — the DB can't leak the secret.
func newToken() (token, hash string, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", fmt.Errorf("approval: generate token: %w", err)
	}
	token = hex.EncodeToString(buf)
	sum := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(sum[:]), nil
}
```

The DB stores the hash, never the token. Approval and insertion live in the same transaction with a conditional guard: two concurrent approvals with the same token can't insert a duplicate application — only the winner commits. A tampered payload can't escape validation because it's re-parsed fail-closed on approval.

### 2. Multi-provider fallback and RAG in the same Postgres

The agent uses Gemini as its primary provider, but when the free-tier quota runs out it falls back to Groq automatically — without changing a line in the orchestrator. RAG lives in the same Postgres with `pgvector`: documents are embedded and queried through a tool that returns only the tenant-scoped relevant passages.

### 3. Accept-both intake: the agro-iam ecosystem plugs in without rewriting

agro-agent never mints its own tokens: it consumes agro-iam's with accept-both intake. An integer `tenant_id` (demo) is used directly; a UUID `tenant_id` (agro-iam) is resolved via `tenants.uuid`; English roles are normalized (`agronomist`→`agronomo`); and a UUID `sub` resolves scoped to the tenant. Whatever doesn't resolve, fails closed — never a leak.

### 4. agro-web: the frontend that completes the ecosystem

The backend doesn't live alone: **agro-web** is the Next.js frontend that consumes it. Chat with streaming, the lots and applications view, and the HITL approvals panel (where the agronomist pastes the token and approves or rejects). One design detail worth highlighting: the frontend proxies backend calls server-side (`src/app/api/chat/route.ts`), so the browser never sees the backend URL — a single entry surface, no CORS, no exposed infrastructure.

## What you gain with this approach

| Guarantee | How it's achieved |
|---|---|
| The LLM doesn't cross domains | Deterministic router + description suffixes as a safety net |
| The model can't mutate production data | HITL: pending request + opaque token + re-validation on approval |
| The approval token can't leak | Only its sha256 hash is persisted, never the plaintext |
| No duplicate applications from races | Approval + insertion in one transaction with a conditional guard |
| Answers grounded in real data | Tenant-scoped DB tools + RAG with pgvector |
| Routing is measurable | Golden-set evals: expected tools, forbidden tools, anti-hallucination |

Every guarantee in the table has its test, and the evals run against the real agent (Gemini + Postgres), not mocks.

## What I consciously left out

- **Deploy to a public host.** The Render free tier is already occupied by agro-iam and there's no paid plan; the backend runs locally with Docker Compose + Neon. I'd rather say that explicitly than fake a live demo. Real screenshots are in the README.
- **Distributed rate limiting / Redis.** A single binary behind a proxy doesn't need it yet.
- **Prometheus metrics / tracing.** Only structured logging with `slog` and healthchecks.
- **Live eval run as a gate.** The harness exists and measures by trend; automating it against the daily free quota is the next step, not a promise.

## Conclusion

agro-agent proves an agent can be useful and auditable at the same time: it queries real data with RAG, picks its tools with a deterministic bias instead of faith, and to write, it needs a human to present a token no one else can replay.

The lesson repeats itself: **an LLM isn't the place for security guarantees — it's the place for flexibility.** Routing is biased in the router, writes are governed by HITL, and tenant isolation lives in the context. When every guarantee sits in a deterministic, testable layer, the system stays correct even when the model makes mistakes.

The code is open at [github.com/ezequielranieri/agro-agent](https://github.com/ezequielranieri/agro-agent) with green CI, bilingual docs, and real screenshots — and the frontend at [github.com/ezequielranieri/agro-web](https://github.com/ezequielranieri/agro-web).