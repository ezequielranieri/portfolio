---
title: Por qué implementé Refresh Token Rotation en vez de tokens de larga duración en go-iam-service
slug: refresh-token-rotation
project: go-iam-service
status: published
translationOf: refresh-token-rotation-en
date: 2026-07-11T00:00:00.000Z
lang: es
tags:
  - Go
  - IAM
  - Security
  - JWT
  - Refresh Tokens
  - Authentication
  - Arquitectura
cover: ''
---

Cuando diseñé el sistema de autenticación de go-iam-service, una de las decisiones más importantes fue cómo manejar los refresh tokens. La tentación de usar tokens de larga duración (semanas o meses) es grande, especialmente cuando querés minimizar la fricción del usuario. Pero desde una perspectiva de seguridad, los refresh tokens de larga duración introducen un riesgo silencioso: una vez robados, el atacante tiene una ventana enorme para usarlos.

## El problema con los refresh tokens estáticos

Un refresh token tradicional es una credencial persistente. El flujo típico:

1. El usuario se autentica y recibe un access token (corto plazo, ej. 15 min) y un refresh token (largo plazo, ej. 30 días).
2. Cuando el access token expira, el cliente usa el refresh token para obtener uno nuevo.
3. El refresh token original **sigue siendo válido** hasta su expiración natural.

El problema: si un atacante intercepta el refresh token (malware, XSS, leak del lado del cliente), puede emitir nuevos access tokens indefinidamente hasta que el token expire. No hay forma de detectar el robo.

## Refresh Token Rotation: cómo funciona

La rotación de refresh tokens cambia las reglas del juego:

1. Cada vez que se usa un refresh token, el servidor **lo invalida y emite uno nuevo**.
2. El refresh token anterior deja de ser válido inmediatamente.
3. Si alguien intenta usar un token ya rotado, se dispara una **alarma de breach**: el servidor asume que el token fue robado y puede invalidar toda la familia de tokens.

```
Cliente                      Servidor
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
  │  (RT_old queda invalidado)  │
```

## Implementación en go-iam-service

Lo implementé como un **TokenFamily** con los siguientes componentes:

### 1. Modelo de datos

```go
type TokenFamily struct {
    ID           uuid.UUID
    UserID       uuid.UUID
    CurrentHash  string    // SHA-256 del refresh token activo
    PreviousHash string    // SHA-256 del token anterior (para breach detection)
    CreatedAt    time.Time
    RotatedAt    time.Time
    ExpiresAt    time.Time
    IsRevoked    bool
}
```

La tabla en PostgreSQL almacena hashes de los tokens, nunca el token en sí. Esto asegura que un leak de la base de datos no exponga credenciales activas.

### 2. Breach detection

El algoritmo de rotación completa:

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

    // Detección de breach: el hash coincide con PreviousHash,
    // significa que alguien intenta reusar un token ya rotado
    if family.PreviousHash == hash {
        s.revokeFamily(ctx, family.ID) // Revoca toda la familia
        s.alert(ctx, SecurityEvent{
            Type:    EventTokenBreach,
            UserID:  family.UserID,
            FamilyID: family.ID,
            Severity: SeverityCritical,
        })
        return nil, ErrPossibleTokenTheft
    }

    // Rotación normal
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

### 3. Rate limiting en el endpoint de refresh

Un atacante que robe un refresh token va a intentar usarlo apenas lo obtenga. Para mitigar el impacto, el endpoint `POST /auth/refresh` tiene rate limiting agresivo con Lua/Redis:

```lua
-- scripts/rate_limit_refresh.lua
local key = "rl:refresh:" .. KEYS[1]  -- KEYS[1] = user_id
local window = 60                     -- ventana de 60 segundos
local max = tonumber(ARGV[1]) or 5    -- máximo 5 rotaciones

local current = redis.call("INCR", key)
if current == 1 then
    redis.call("EXPIRE", key, window)
end

if current > max then
    return 0  -- denegado
end
return 1       -- permitido
```

### 4. Observabilidad

Cada rotación emite métricas a Prometheus:

```go
metrics.RefreshRotations.WithLabelValues("success").Inc()
metrics.RefreshTokenAge.WithLabelValues().Observe(time.Since(family.CreatedAt).Seconds())
```

Y un log estructurado para auditoría:

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

Esto permitiría detectar patrones anómalos —por ejemplo, 142 rotaciones en 30 días para un solo usuario merecería una revisión.

## Ventajas sobre tokens de larga duración

| Aspecto | Token estático | Token con rotación |
|---|---|---|
| Ventana de ataque | Hasta 30 días | Milisegundos (próximo uso legítimo) |
| Detección de robo | Imposible | Inmediata (breach alert) |
| Revocación | Manual o por expiración | Automática en toda la familia |
| Impacto de leak | Alto: acceso prolongado | Bajo: ventana mínima |
| UX | Sin fricción | Sin fricción (transparente) |

## Consideraciones de implementación

### Concurrencia

Si el cliente hace dos requests de refresh simultáneos, ambos podrían intentar usar el mismo token. Para evitar race conditions, la operación de rotación debe ser atómica. En go-iam-service uso una transacción serializable en PostgreSQL:

```go
tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
```

Si hay conflicto, la transacción falla y el cliente reintenta —el segundo intento encontrará el token ya rotado y recibirá un error, lo que lo obliga a volver a autenticarse.

### Token family cleanup

Los refresh tokens tienen una expiración máxima (configurable, por defecto 90 días). Un job background corre cada hora eliminando familias expiradas:

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

## Conclusión

La rotación de refresh tokens convierte una credencial estática y vulnerable en un mecanismo dinámico con detección de robo incorporada. No es más complejo de implementar que un sistema tradicional, y los beneficios de seguridad son enormes. En go-iam-service, esta fue una decisión de diseño temprana que pagó dividendos en simplicidad mental: sé que incluso si un token se ve comprometido, la ventana de explotación es mínima y tengo mecanismos para detectarlo y responder automáticamente.

Si estás diseñando un sistema de autenticación hoy, no uses refresh tokens estáticos. La rotación debería ser el default.
