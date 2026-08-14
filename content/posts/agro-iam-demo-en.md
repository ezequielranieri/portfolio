---
title: How I Designed a Multi-Tenant Farm Platform in Go Where Data Isolation Doesn't Depend on Discipline
slug: agro-iam-demo-en
project: agro-iam
status: published
date: 2026-08-14T00:00:00.000Z
lang: en
tags:
  - Go
  - PostgreSQL
  - JWT
  - Multi-Tenancy
  - RBAC
  - Clean Architecture
  - Security
  - Row Level Security
translationOf: agro-iam-demo
cover: ''
---

When I started agro-iam, the problem was concrete: an agricultural cooperative needs to manage lots, campaigns, and product applications for each of its producers, and every cooperative must only ever see its own information. The same business model I used in go-authz — multi-tenant, with isolation as a first-class security guarantee — but applied to a real agricultural domain, with a working demo deployed.

I asked myself three questions before writing the first line:

1. How do I guarantee that a producer from cooperative A can never read or write cooperative B's lots, without depending on every query having the right filter?
2. How do I keep long-lived sessions (a field operator isn't re-logging in every hour) without a stolen token becoming a permanent back door?
3. How do I prove none of this is vaporware — with a real app anyone can open and try?

The temptation was the usual move: `WHERE tenant_id = ?` in every repository and blind faith that nobody would ever get it wrong. That approach had already failed me before. The answer was the same defense-in-depth philosophy I learned in go-authz, but with a twist: **FORCED Row Level Security in Postgres, refresh tokens that destroy themselves on theft, and an audit log chained by hash that can't be altered without breaking the whole chain.**

## The problem with trusting "the query has a WHERE"

In a multi-tenant system, the classic failure isn't a sophisticated attack: it's a developer forgetting a filter, a JOIN that doesn't carry the tenant, a manual SQL console session. Each one of those is a data leak between customers.

agro-iam attacks that at the database layer, not in the application:

```sql
ALTER TABLE app.users        FORCE ROW LEVEL SECURITY;
ALTER TABLE app.lots         FORCE ROW LEVEL SECURITY;
ALTER TABLE app.campaigns    FORCE ROW LEVEL SECURITY;
ALTER TABLE app.applications FORCE ROW LEVEL SECURITY;
```

The detail that makes the difference is `FORCE`: RLS isn't just enabled, it also applies to the table owner. A badly written query, a manual psql session, anything that hasn't established the correct tenant context returns **zero rows** — never a leak.

Tenant context is set per transaction, never on a shared connection:

```sql
SELECT set_config('app.tenant_id', $1, true)  -- true = LOCAL to the transaction
```

The `true` is the important part: without it, a connection pool would share the previous transaction's tenant between requests. With it, every transaction starts clean. The policies compare against a function that reads that GUC:

```sql
CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE POLICY tenant_isolation ON app.lots
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
```

When the GUC is NULL (missing context), `current_tenant_id()` returns NULL and every policy predicate is false: **missing context = zero rows, never a leak.** And one design detail that's not accidental: composite primary keys `(id, tenant_id)` on the business tables make it impossible to reference another tenant's row even through a foreign key.

## Key design decisions

### 1. Refresh tokens that destroy themselves on reuse

A field session has a long lifecycle, so the refresh token has to last and, above all, has to be safe. The rule is the same as in go-authz: opaque 256-bit tokens, mandatory rotation, and a family (`family_id`) that ties every rotation to the original session.

```go
// DecideRotation is the pure heart of rotation + replay detection.
// The threat model: an attacker who steals a token races the legitimate user.
// Whoever refreshes first rotates; whoever is second presents an already-revoked
// token and triggers family-wide revocation.
func DecideRotation(revoked bool, replacedBy string, expiresAt, now int64) RefreshTokenDecision {
	if revoked {
		if replacedBy != "" {
			return RotationRejectRevoked // reuse: escalate to family revocation
		}
		return RotationRejectInvalid
	}
	if expiresAt <= now {
		return RotationRejectExpired
	}
	return RotationAllow
}
```

Reuse is the theft signal: if an already-rotated token reappears, it's not just that attempt that gets rejected — the whole family is revoked, killing the new token the attacker just obtained too. And only the SHA-256 hash of the token is stored, never the plaintext: a leaked database can't be replayed.

### 2. An audit log that can't be altered without breaking the chain

Everything that happens on the platform is recorded: who, what, when, and on which entity. But a log anyone can edit in the database isn't evidence. The solution: a SHA-256 hash chain where every entry includes the hash of the previous one.

```go
func HashChainEntry(prevHash string, seq int64, e domain.AuditEntry, canonical []byte) string {
	created := e.CreatedAt.UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)
	input := strings.Join([]string{
		prevHash,
		strconv.FormatInt(seq, 10),
		e.TenantID,
		e.ActorUserID,
		e.Action,
		e.EntityType,
		e.EntityID,
		string(canonical),
		created,
	}, "|")
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])
}
```

For stable verification, the payload is canonicalized before hashing (the same code path at insert and at verification, so key order or number formatting never break the chain). Editing a middle entry breaks the next entry's `prev_hash` — verification walks the chain and reports the first broken entry, with its `seq`.

### 3. Hexagonal architecture and a demo anyone can try

The code follows the pattern I already used in go-authz: pure domain, testable without infrastructure; use cases in the application layer; adapters (Postgres, HTTP) on the outside. The security-critical rules — like `DecideRotation` and the audit chain — are pure functions, unit-tested with no database or network.

The visible difference is the demo: an SPA embedded in the binary with `go:embed`, running anywhere the binary runs. Two example cooperatives, each with its own complete dataset, and documented access credentials. No Redis, no extra infrastructure — one binary, one Postgres database, and RLS doing its job.

## What you gain with this approach

| Guarantee | How it's achieved |
|---|---|
| Tenant isolation immune to application bugs | FORCED Row Level Security in Postgres, applied even to the owner |
| Missing context never leaks | Transaction-local GUC + policy returning zero rows on NULL |
| Stolen session destroys itself | Opaque 256-bit tokens + rotation + family revocation on reuse |
| Trustworthy audit evidence | SHA-256 chain with canonicalization and full-chain verification |
| No extra infrastructure dependency | SPA embedded with `go:embed`, one deployable binary |
| Security rules genuinely testable | Pure functions in the domain, tests without DB or network |

Every guarantee in the table has its test, and the project runs against a real Postgres database — no mocks in the persistence layer.

## What I consciously left out of the MVP

- **Redis / distributed rate limiting.** go-authz has it; agro-iam doesn't need it yet: a single binary served behind a proxy can rely on proxy limits and Argon2id for passwords. I don't build infrastructure the domain doesn't ask for.
- **Prometheus metrics / tracing.** Only structured logging with `slog` and healthchecks. I'd rather say that explicitly than let the README hint at something the code doesn't have.
- **Automatic migrations on deploy.** They're applied manually from local with `migrate`. Automating them is a convenience improvement, not a security one.

## Conclusion

agro-iam proves the go-authz philosophy wasn't a one-off: isolation enforced at the data layer, sessions that self-heal on theft, and audit evidence that doesn't depend on the goodwill of whoever edits the database — applied to a completely different domain, with a real deployed demo anyone can open.

The lesson repeats itself: **multi-tenant security isn't solved with discipline, it's solved with design.** If a guarantee depends on a developer remembering to do something in every query, it's already broken. When isolation lives in the database, in the token protocol, and in the audit chain, the system stays secure even when people make mistakes.

The demo is live: https://agro-iam.onrender.com — two cooperatives, documented test credentials, and all the code open in the repo.