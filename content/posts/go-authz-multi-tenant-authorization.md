---
title: Cómo diseñé un servicio de autorización multi-tenant en Go sin construir otro Keycloak
slug: go-authz-multi-tenant-authorization
project: go-authz
status: published
date: 2026-08-07T00:00:00.000Z
lang: es
tags:
  - Go
  - PostgreSQL
  - JWT
  - Multi-Tenancy
  - RBAC
  - Clean Architecture
  - Security
translationOf: go-authz-multi-tenant-authorization-en
cover: ''
---

Cuando empecé a diseñar go-authz, tenía un problema concreto: varios servicios internos necesitaban una forma compartida de autenticar usuarios y verificar permisos, y cada uno amenazaba con reimplementar su propia versión a medias.


1. ¿Cómo se autentican los usuarios, y cuánto tiempo sigue siendo útil una sesión robada?
2. ¿Cómo se mantiene aislada la data de un tenant respecto de otro, más allá de "la query tiene un WHERE"?
3. ¿Cómo verifican otros servicios "puede este usuario hacer X?" sin que cada uno reimplemente roles y permisos?


La tentación era levantar Keycloak, o directamente construir un proveedor OAuth2/OIDC completo con registro de clientes, pantallas de consentimiento y discovery endpoints. Pero eso es una categoría de complejidad que un servicio interno, consumido por otros servicios de la misma organización, no pide todavía.


La respuesta fue un servicio de auth propio, deliberadamente acotado: **Postgres como fuente de verdad con dos capas de aislamiento independientes, tokens que se auto-corrigen ante un robo, y un solo endpoint de autorización que cualquier otro servicio puede consultar.**


## El problema de confiar en una sola capa de protección


En un sistema multi-tenant, la tentación es escribir `WHERE tenant_id = ?` en cada query y confiar en la disciplina del equipo para nunca olvidarlo. Un solo query sin ese filtro es una fuga de datos entre clientes — y en un servicio de autorización, ese tipo de error no es un bug cualquiera, es el peor bug posible.


go-authz toma el camino contrario: **cada garantía de seguridad importante se refuerza en al menos dos capas independientes**, para que un error en una no comprometa el sistema entero.


```
┌─────────────────────────────────────────────────────────┐
│                        go-authz                          │
│                                                            │
│  ┌──────────────┐        ┌──────────────────────────┐   │
│  │  HTTP API    │───────▶│  Use cases (auth, rbac)   │   │
│  │  (chi)       │        │  domain-driven, sin infra  │   │
│  └──────┬───────┘        └────────────┬──────────────┘   │
│         │                             │                   │
│  ┌──────▼───────┐        ┌───────────▼──────────────┐   │
│  │  Middleware   │        │  Postgres repositories    │   │
│  │  tenant check │        │  RLS + trigger AUTH1      │   │
│  └──────────────┘        └───────────────────────────┘   │
│                                                            │
│  ┌──────────────────────────────────────────────────┐    │
│  │  Redis: rate limiting atómico (Lua, fixed window) │    │
│  └──────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```


## Decisiones de diseño clave


### 1. Refresh tokens que detectan su propio robo


Un refresh token filtrado no debería ser una puerta trasera permanente. La solución: tokens opacos, rotación obligatoria, y una familia (`family_id`) que amarra cada rotación a la sesión original.


```go
func (uc *RefreshUseCase) RefreshSession(ctx context.Context, plaintext, ua, ip string) (*RefreshOutput, error) {
	hash := opaquetoken.Hash(plaintext)
	token, err := uc.refreshTokens.GetByTokenHash(ctx, hash)
	if err != nil {
		return nil, ErrInvalidRefreshToken
	}


	// Un token YA REVOCADO que reaparece es la señal de reuso.
	// Se chequea ANTES que la expiración: un token revocado y vencido
	// debe reportarse como breach, no esconderse detrás de "expiró".
	if token.Revoked() {
		uc.refreshTokens.RevokeAllByFamily(ctx, token.FamilyID())
		return nil, ErrRefreshReuseDetected
	}
	if token.IsExpired(time.Now()) {
		return nil, ErrInvalidRefreshToken
	}


	// Rotación: el nuevo token se persiste ANTES de revocar el viejo.
	// Si esto falla, el cliente legítimo puede reintentar sin que el
	// sistema confunda un error transitorio con un ataque.
	newToken, _ := domain.NewRefreshToken(token.UserID(), newHash, token.FamilyID(), ua, ip)
	if err := uc.refreshTokens.Create(ctx, newToken); err != nil {
		return nil, err // el viejo NUNCA se tocó
	}
	uc.refreshTokens.Revoke(ctx, token.ID())


	return &RefreshOutput{AccessToken: access, RefreshToken: newPlaintext}, nil
}
```


Si un token revocado reaparece, no se rechaza solo ese intento — se mata **toda la familia**. Es la diferencia entre "bloqueo un request sospechoso" y "asumo que esa sesión completa está comprometida".


### 2. Aislamiento de tenant reforzado dos veces, no una


Row Level Security en Postgres protege contra queries mal escritas. Pero eso no alcanza para relaciones muchos-a-muchos entre tablas que no tienen `tenant_id` directo — como asignar un rol a un usuario.


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


`AUTH1` es un código de error custom, no el genérico `P0001` que Postgres asigna por defecto — si se hubiera usado el genérico, el primer trigger nuevo que se agregara en cualquier otra tabla habría colisionado con este mapeo de errores sin que nadie lo notara.


Esta capa de base de datos no reemplaza la capa de aplicación — la complementa. Y encontrar exactamente ese punto ciego fue lo que reveló el bug más interesante del proyecto.


### 3. El bug que afectó a seis endpoints a la vez


El middleware que autoriza a un admin a gestionar su tenant verificaba "¿este usuario tiene rol admin en algún lado?" — pero nunca comparaba **en qué tenant**. Como cada usuario pertenece a exactamente un tenant, esa pregunta siempre se contestaba que sí para cualquier admin, sin importar sobre qué tenant estuviera operando la URL.


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
			// EL FIX: comparar el tenant del token contra el de la URL,
			// no solo verificar que el rol "admin" exista en algún lado.
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


Se corrigió una sola vez, a nivel de middleware, no endpoint por endpoint — cualquier ruta nueva que use este mismo middleware hereda la protección automáticamente, sin que alguien tenga que acordarse de replicar el chequeo.


### 4. Un endpoint de autorización que no hace N+1 queries


Verificar si un usuario tiene un permiso implica atravesar usuario → roles → permisos de cada rol. Con las queries obvias, eso es 1+N consultas — inaceptable para el endpoint más transitado de todo el sistema.


```sql
-- name: ListPermissionsByUser :many
SELECT DISTINCT p.resource, p.action
FROM user_roles ur
JOIN role_permissions rp ON rp.role_id = ur.role_id
JOIN permissions p ON p.id = rp.permission_id
WHERE ur.user_id = $1;
```


Una sola query resuelve el grafo completo, sin importar cuántos roles tenga el usuario. No lo asumí — lo medí: instrumenté un query tracer en el test de integración y afirmé un conteo exacto de queries ejecutadas, no "suficientemente rápido".


## Qué gana uno con este enfoque


| Garantía | Cómo se logra |
|---|---|
| Sesión robada se auto-corrige | Refresh opaco + rotación + reuse detection por familia |
| Aislamiento de tenant a prueba de bugs de aplicación | Row Level Security + trigger `AUTH1` en DB |
| Escalación de privilegios cross-tenant bloqueada en la entrada | Middleware compara tenant de URL contra tenant del token |
| `/authorize` rápido sin importar la cantidad de roles | Una sola query SQL, verificada con query tracer |
| Rate limiting atómico bajo concurrencia real | Redis + Lua, verificado con 50 goroutines contra el mismo límite |
| Passwords resistentes a fuerza bruta offline | Argon2id (parámetros alineados a OWASP) |
| Refresh tokens sin costo de hash innecesario | SHA-256 — alta entropía no necesita memory-hardness |


Además, cada garantía de la tabla de arriba tiene un test de integración corriendo contra Postgres y Redis reales vía testcontainers — no mocks en la capa de persistencia ni en el rate limiter. El caso de reuse detection, por ejemplo, verifica explícitamente que revocar una familia comprometida no afecta a otra familia del mismo usuario.


## Lo que conscientemente dejé fuera del MVP


- **Métricas Prometheus / tracing OpenTelemetry.** Estaban en el plan original de stack, pero nunca se construyeron — hoy solo hay logging estructurado con `slog` y healthchecks reales. Preferí decir esto explícitamente antes que dejar que la documentación insinúe algo que el código no tiene.
- **Service Accounts / autenticación M2M.** Todo caller hoy es un `User` o un `SuperAdmin`. Un servicio que necesite autenticarse "como servicio" en vez de "como persona" todavía no tiene un flujo de client credentials.
- **Redis en alta disponibilidad.** Es un punto único de falla hoy, documentado y aceptado por ahora — el rate limiter incluso está configurado en fail-open específicamente por esto: ante una caída de Redis, se prioriza disponibilidad sobre una capa de throttling que de todos modos está respaldada por Argon2id.


La decisión de no construir infraestructura prematura está documentada en `DECISIONS.md`, junto con los cuatro bugs de seguridad reales que el proceso de revisión encontró antes de llegar a producción — no hipotéticos, sino ordenamientos de operaciones y chequeos faltantes que efectivamente hubieran sido explotables.


## Conclusión


go-authz no inventa nada nuevo: usa patrones conocidos (rotación de tokens, RLS, RBAC) y los implementa con defensa en profundidad real, no aspiracional. La arquitectura hexagonal mantiene el dominio libre de infraestructura, y cada garantía de seguridad importante está reforzada en más de una capa — porque confiar en una sola ya demostró, en este mismo proyecto, que falla.


Si estás construyendo un sistema que necesita autenticación y autorización compartida entre varios servicios, no siempre hace falta un Keycloak completo: Postgres bien diseñado, JWT de corta duración, y un endpoint de autorización simple cubren la mayoría de los casos reales. El código, los tests, y la retrospectiva completa están en `DECISIONS.md` — incluidos los bugs, cuando el problema los pida.
