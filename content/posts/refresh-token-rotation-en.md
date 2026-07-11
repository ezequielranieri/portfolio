---
title: Why I Implemented Refresh Token Rotation Instead of Long-Lived Tokens in go-iam-service
slug: refresh-token-rotation-en
project: go-iam-service
status: published
date: 2026-07-11T00:00:00.000Z
lang: en
tags:
  - Go
  - IAM
  - Security
  - JWT
  - Refresh Tokens
  - Authentication
  - Architecture
translationOf: refresh-token-rotation
cover: ''
---

When designing the authentication system for go-iam-service, one of the most important decisions was how to handle refresh tokens. The temptation to use long-lived tokens (weeks or months) is strong, especially when you want to minimize user friction. But from a security perspective, long-lived refresh tokens introduce a silent risk: once stolen, the attacker has a huge window to use them.

## The problem with static refresh tokens

A traditional refresh token is a persistent credential. The typical flow:

1. The user authenticates and receives an access token (short-lived, e.g. 15 min) and a refresh token (long-lived, e.g. 30 days).
2. When the access token expires, the client uses the refresh token to obtain a new one.
3. The original refresh token **remains valid** until its natural expiration.

The problem: if an attacker intercepts the refresh token (malware, XSS, client-side leak), they can issue new access tokens indefinitely until the token expires. There is no way to detect the theft.

## Refresh Token Rotation: how it works

Refresh token rotation changes the game:

1. Every time a refresh token is used, the server **invalidates it and issues a new one**.
2. The previous refresh token becomes immediately invalid.
3. If someone tries to use an already-rotated token, a **breach alarm** is triggered: the server assumes the token was stolen and can invalidate the entire token family.

```
Client                       Server
  │                             │
  │── POST /auth/refresh ──────►│
  │   Bearer: RT_old            │
  │                             │
  │◄── 200 OK ─────────────────│
  │   {                         │
  │     access_token: AT_new,   │
  │     refresh_token: RT_new   │
  │   }                         │
  │                             │
  │  (RT_old is invalidated)    │
```

## Implementation in go-iam-service

I implemented it as a **TokenFamily** with the following components:

### 1. Data model

```go
type TokenFamily struct {
    ID           uuid.UUID
    UserID       uuid.UUID
    CurrentHash  string    // SHA-256 of the active refresh token
    PreviousHash string    // SHA-256 of the previous token (for breach detection)
    CreatedAt    time.Time
    RotatedAt    time.Time
    ExpiresAt    time.Time
    IsRevoked    bool
}
```

The PostgreSQL table stores token hashes, never the token itself. This ensures a database leak does not expose active credentials.

### 2. Breach detection

The complete rotation algorithm:

```go
func (s *Service) Rotate(ctx context.Context, rawToken string) (*TokenPair, error) {
    hash := sha256Hex(rawToken)

    family, err := s.repo.FindByHash(ctx, hash)
    if err != nil {
        return nil, ErrInvalidToken
    }

    if family.IsRevoked {
        return nil, ErrTokenRevoked
    }

    // Breach detection: hash matches PreviousHash,
    // meaning someone is trying to reuse an already rotated token
    if family.PreviousHash == hash {
        s.revokeFamily(ctx, family.ID) // Revoke the entire family
        s.alert(ctx, SecurityEvent{
            Type:    EventTokenBreach,
            UserID:  family.UserID,
            FamilyID: family.ID,
            Severity: SeverityCritical,
        })
        return nil, ErrPossibleTokenTheft
    }

    // Normal rotation
    newToken := s.generateToken()
    newHash := sha256Hex(newToken)

    family.PreviousHash = family.CurrentHash
    family.CurrentHash = newHash
    family.RotatedAt = time.Now()

    if err := s.repo.Update(ctx, family); err != nil {
        return nil, fmt.Errorf("rotate: %w", err)
    }

    accessToken, err := s.issueAccessToken(ctx, family.UserID)
    if err != nil {
        return nil, fmt.Errorf("issue access: %w", err)
    }

    return &TokenPair{
        AccessToken:  accessToken,
        RefreshToken: newToken,
    }, nil
}
```

### 3. Rate limiting on the refresh endpoint

An attacker who steals a refresh token will try to use it immediately. To mitigate the impact, the `POST /auth/refresh` endpoint has aggressive rate limiting with Lua/Redis:

```lua
-- scripts/rate_limit_refresh.lua
local key = "rl:refresh:" .. KEYS[1]  -- KEYS[1] = user_id
local window = 60                     -- 60-second window
local max = tonumber(ARGV[1]) or 5    -- maximum 5 rotations

local current = redis.call("INCR", key)
if current == 1 then
    redis.call("EXPIRE", key, window)
end

if current > max then
    return 0  -- denied
end
return 1       -- allowed
```

### 4. Observability

Each rotation emits metrics to Prometheus:

```go
metrics.RefreshRotations.WithLabelValues("success").Inc()
metrics.RefreshTokenAge.WithLabelValues().Observe(time.Since(family.CreatedAt).Seconds())
```

And structured logs for auditing:

```json
{
  "level": "info",
  "event": "token_rotated",
  "user_id": "a1b2c3d4",
  "family_id": "e5f6g7h8",
  "rotations": 142,
  "family_age_seconds": 2592000
}
```

This makes it possible to detect anomalous patterns — for example, 142 rotations in 30 days for a single user would warrant a review.

## Advantages over long-lived tokens

| Aspect | Static token | Rotation token |
|---|---|---|
| Attack window | Up to 30 days | Milliseconds (next legitimate use) |
| Theft detection | Impossible | Immediate (breach alert) |
| Revocation | Manual or by expiration | Automatic across the entire family |
| Leak impact | High: prolonged access | Low: minimal window |
| UX | No friction | No friction (transparent) |

## Implementation considerations

### Concurrency

If the client makes two simultaneous refresh requests, both could try to use the same token. To avoid race conditions, the rotation operation must be atomic. In go-iam-service I use a serializable transaction in PostgreSQL:

```go
tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
```

If there is a conflict, the transaction fails and the client retries — the second attempt will find the token already rotated and receive an error, forcing re-authentication.

### Token family cleanup

Refresh tokens have a maximum expiration (configurable, 90 days by default). A background job runs every hour to clean up expired families:

```go
func (s *Service) CleanupExpired(ctx context.Context) (int64, error) {
    rows, err := s.db.ExecContext(ctx,
        "DELETE FROM token_families WHERE expires_at < NOW()",
    )
    if err != nil {
        return 0, fmt.Errorf("cleanup: %w", err)
    }
    return rows.RowsAffected()
}
```

## Conclusion

Refresh token rotation turns a static, vulnerable credential into a dynamic mechanism with built-in theft detection. It is no more complex to implement than a traditional system, and the security benefits are enormous. In go-iam-service, this was an early design decision that paid dividends in peace of mind: I know that even if a token is compromised, the exploitation window is minimal and I have mechanisms to detect and respond automatically.

If you are designing an authentication system today, do not use static refresh tokens. Rotation should be the default.
