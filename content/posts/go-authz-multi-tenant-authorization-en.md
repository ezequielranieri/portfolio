---
title: How I Designed a Multi-Tenant Authorization Service in Go Without Building Another Keycloak
slug: go-authz-multi-tenant-authorization-en
project: go-authz
status: published
date: 2026-08-07T00:00:00.000Z
lang: en
tags:
  - Go
  - PostgreSQL
  - JWT
  - Multi-Tenancy
  - RBAC
  - Clean Architecture
  - Security
translationOf: go-authz-multi-tenant-authorization
cover: ''
---

When I started designing go-authz, I had a concrete problem: several internal services needed a shared way to authenticate users and check permissions, and each one was threatening to half-reimplement its own version.


1. How do users authenticate, and how long does a stolen session stay useful?
2. How does one tenant's data stay isolated from another's, beyond "the query has a WHERE clause"?
3. How do other services check "can this user do X?" without each one reimplementing roles and permissions?


The temptation was to spin up Keycloak, or build a full OAuth2/OIDC provider from scratch — client registration, consent screens, discovery endpoints. But that's a category of complexity an internal service, consumed by other services in the same organization, doesn't ask for yet.


The answer was a purpose-built auth service, deliberately scoped: **Postgres as the source of truth with two independent isolation layers, tokens that self-heal from theft, and a single authorization endpoint any other service can query.**


## The problem with trusting a single layer of protection


In a multi-tenant system, the temptation is to write `WHERE tenant_id = ?` in every query and trust the team never to forget it. One query without that filter is a cross-tenant data leak — and in an authorization service, that's not just any bug, it's the worst possible one.


go-authz takes the opposite approach: **every important security guarantee is reinforced by at least two independent layers**, so a mistake in one doesn't compromise the whole system.


```
┌─────────────────────────────────────────────────────────┐
│                        go-authz                          │
│                                                            │
│  ┌──────────────┐        ┌──────────────────────────┐   │
│  │  HTTP API    │───────▶│  Use cases (auth, rbac)   │   │
│  │  (chi)       │        │  domain-driven, no infra   │   │
│  └──────┬───────┘        └────────────┬──────────────┘   │
│         │                             │                   │
│  ┌──────▼───────┐        ┌───────────▼──────────────┐   │
│  │  Middleware   │        │  Postgres repositories    │   │
│  │  tenant check │        │  RLS + AUTH1 trigger      │   │
│  └──────────────┘        └───────────────────────────┘   │
│                                                            │
│  ┌──────────────────────────────────────────────────┐    │
│  │  Redis: atomic rate limiting (Lua, fixed window)  │    │
│  └──────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```


## Key design decisions


### 1. Refresh tokens that detect their own theft


A leaked refresh token shouldn't be a permanent backdoor. The fix: opaque tokens, mandatory rotation, and a family (`family_id`) tying every rotation back to the original session.


```go
func (uc *RefreshUseCase) RefreshSession(ctx context.Context, plaintext, ua, ip string) (*RefreshOutput, error) {
	hash := opaquetoken.Hash(plaintext)
	token, err := uc.refreshTokens.GetByTokenHash(ctx, hash)
	if err != nil {
		return nil, ErrInvalidRefreshToken
	}


	// A token that's ALREADY REVOKED showing up again is the reuse signal.
	// Checked BEFORE expiration: a token that's both revoked and expired
	// must be reported as a breach, not hidden behind "it just expired".
	if token.Revoked() {
		uc.refreshTokens.RevokeAllByFamily(ctx, token.FamilyID())
		return nil, ErrRefreshReuseDetected
	}
	if token.IsExpired(time.Now()) {
		return nil, ErrInvalidRefreshToken
	}


	// Rotation: the new token is persisted BEFORE the old one is revoked.
	// If this fails, the legitimate client can safely retry without the
	// system mistaking a transient error for an attack.
	newToken, _ := domain.NewRefreshToken(token.UserID(), newHash, token.FamilyID(), ua, ip)
	if err := uc.refreshTokens.Create(ctx, newToken); err != nil {
		return nil, err // the old one was NEVER touched
	}
	uc.refreshTokens.Revoke(ctx, token.ID())


	return &RefreshOutput{AccessToken: access, RefreshToken: newPlaintext}, nil
}
```


If a revoked token shows up again, it's not just that one request that gets rejected — the **entire family** gets killed. That's the difference between "block one suspicious request" and "assume this whole session is compromised."


### 2. Tenant isolation enforced twice, not once


Row Level Security in Postgres protects against poorly-written queries. But that's not enough for many-to-many relationships between tables that don't carry `tenant_id` directly — like assigning a role to a user.


```sql
CREATE OR REPLACE FUNCTION check_user_role_same_tenant()
RETURNS TRIGGER AS $$
DECLARE
    user_tenant UUID;
    role_tenant UUID;
BEGIN
    SELECT tenant_id INTO user_tenant FROM users WHERE id = NEW.user_id;
    SELECT tenant_id INTO role_tenant FROM roles WHERE id = NEW.role_id;
    IF user_tenant IS DISTINCT FROM role_tenant THEN
        RAISE EXCEPTION 'user_roles: user and role must belong to the same tenant'
            USING ERRCODE = 'AUTH1';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```


`AUTH1` is a custom error code, not the generic `P0001` Postgres assigns by default — had the generic one been used, the very next unrelated trigger added anywhere else in the schema would have collided with this error mapping without anyone noticing.


This database layer doesn't replace the application layer — it complements it. And finding that exact blind spot is what surfaced the most interesting bug in the project.


### 3. The bug that hit six endpoints at once


The middleware authorizing an admin to manage their tenant checked "does this user hold an admin role somewhere?" — but never compared **in which tenant**. Since every user belongs to exactly one tenant, that check always came back true for any admin, regardless of which tenant the URL was actually operating on.


```go
func RequireTenantAdmin(assignments port.RoleAssignmentRepository) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims := ClaimsFromContext(r.Context())
			if claims.TokenType == domain.SuperAdminToken {
				next.ServeHTTP(w, r)
				return
			}


			urlTenant, err := uuid.Parse(chi.URLParam(r, "tenantID"))
			// THE FIX: compare the token's tenant against the URL's tenant,
			// not just check that an "admin" role exists somewhere.
			if err != nil || claims.TenantID != urlTenant {
				writeError(w, http.StatusForbidden, "forbidden")
				return
			}


			roles, _ := assignments.ListRolesByUser(r.Context(), claims.Subject)
			if !hasRole(roles, "admin", urlTenant) {
				writeError(w, http.StatusForbidden, "forbidden")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
```


Fixed once, at the middleware level, not endpoint by endpoint — any new route using this same middleware inherits the protection automatically, without anyone having to remember to replicate the check.


### 4. An authorization endpoint that doesn't run N+1 queries


Checking whether a user has a permission means walking user → roles → each role's permissions. With the obvious queries, that's 1+N round trips — unacceptable for the single most-called endpoint in the entire system.


```sql
-- name: ListPermissionsByUser :many
SELECT DISTINCT p.resource, p.action
FROM user_roles ur
JOIN role_permissions rp ON rp.role_id = ur.role_id
JOIN permissions p ON p.id = rp.permission_id
WHERE ur.user_id = $1;
```


A single query resolves the entire graph, no matter how many roles the user has. I didn't assume this — I measured it: I instrumented a query tracer inside the integration test and asserted an exact query count, not "fast enough."


## What this approach buys


| Guarantee | How it's achieved |
|---|---|
| A stolen session self-heals | Opaque refresh + rotation + family-based reuse detection |
| Tenant isolation survives application bugs | Row Level Security + `AUTH1` DB trigger |
| Cross-tenant privilege escalation blocked at the door | Middleware compares URL tenant against token tenant |
| `/authorize` stays fast regardless of role count | Single SQL query, verified with a query tracer |
| Rate limiting is atomic under real concurrency | Redis + Lua, verified with 50 goroutines against the same limit |
| Passwords resist offline brute-force | Argon2id (OWASP-aligned parameters) |
| Refresh tokens avoid unnecessary hashing cost | SHA-256 — high entropy doesn't need memory-hardness |


Every guarantee in that table also has an integration test running against real Postgres and real Redis via testcontainers — no mocks in the persistence layer or the rate limiter. The reuse-detection case, for instance, explicitly verifies that revoking a compromised family doesn't touch a different family belonging to the same user.


## What I deliberately left out of the MVP


- **Prometheus metrics / OpenTelemetry tracing.** These were in the original stack plan but never got built — today there's only structured `slog` logging and real healthchecks. I'd rather say that outright than let the docs imply something the code doesn't have.
- **Service Accounts / M2M authentication.** Every caller today is either a `User` or a `SuperAdmin`. A service that needs to authenticate "as a service" rather than "as a person" doesn't have a client-credentials flow yet.
- **Redis high availability.** It's a single point of failure today, documented and accepted for now — the rate limiter is even configured fail-open specifically because of this: during a Redis outage, availability is prioritized over a throttling layer that's already backed by Argon2id anyway.


The decision not to build premature infrastructure is documented in `DECISIONS.md`, along with the four real security bugs the review process caught before this reached production — not hypothetical ones, but actual missing checks and operation orderings that would have been exploitable.


## Conclusion


go-authz doesn't invent anything new: it uses known patterns (token rotation, RLS, RBAC) and implements them with real defense in depth, not aspirational defense in depth. The hexagonal architecture keeps the domain free of infrastructure, and every important security guarantee is reinforced by more than one layer — because trusting just one already proved, in this very project, that it fails.


If you're building a system that needs shared authentication and authorization across several services, you don't always need a full Keycloak: a well-designed Postgres schema, short-lived JWTs, and a simple authorization endpoint cover most real cases. The code, the tests, and the full retrospective — bugs included, when the problem calls for it — are in `DECISIONS.md`.
