---
title: Cómo diseñé una plataforma agrícola multi-tenant en Go donde el aislamiento de datos no depende de la disciplina
slug: agro-iam-demo
project: agro-iam
status: published
date: 2026-08-14T00:00:00.000Z
lang: es
tags:
  - Go
  - PostgreSQL
  - JWT
  - Multi-Tenancy
  - RBAC
  - Clean Architecture
  - Security
  - Row Level Security
translationOf: agro-iam-demo-en
cover: ''
---

Cuando empecé agro-iam, el problema era concreto: una cooperativa agrícola necesita gestionar lotes, campañas y aplicaciones de productos por cada uno de sus productores, y cada cooperativa debe ver únicamente su propia información. El mismo modelo de negocio que usé en go-authz —multi-tenant, con aislamiento como garantía de seguridad de primera clase— pero llevado a un dominio agrícola real, con una demo funcional desplegada.

Y me hice tres preguntas antes de escribir la primera línea:

1. ¿Cómo garantizo que el productor de la cooperativa A no pueda leer ni escribir los lotes de la cooperativa B, sin depender de que cada query tenga el filtro correcto?
2. ¿Cómo mantengo sesiones largas (un operario en el campo no está re-logueándose cada hora) sin que un token robado sea una puerta trasera permanente?
3. ¿Cómo demuestro que nada de esto es humo — con una app real que cualquiera pueda abrir y probar?

La tentación era hacer lo de siempre: `WHERE tenant_id = ?` en cada repositorio y una fe ciega en que nadie se equivocaría nunca. Ese enfoque ya me había fallado antes. La respuesta fue la misma filosofía de defensa en profundidad que aprendí en go-authz, pero con un giro: **RLS FORCED en Postgres, refresh tokens que se auto-destruyen ante un robo, y un audit log encadenado por hash que no se puede alterar sin romper toda la cadena.**

## El problema de confiar en "la query tiene un WHERE"

En un sistema multi-tenant, el error clásico no es un ataque sofisticado: es un desarrollador que se olvida un filtro, un JOIN que no pasa el tenant, una consola SQL abierta a mano. Cada uno de esos errores es una fuga de datos entre clientes.

agro-iam ataca eso en la base de datos misma, no en la aplicación:

```sql
ALTER TABLE app.users        FORCE ROW LEVEL SECURITY;
ALTER TABLE app.lots         FORCE ROW LEVEL SECURITY;
ALTER TABLE app.campaigns    FORCE ROW LEVEL SECURITY;
ALTER TABLE app.applications FORCE ROW LEVEL SECURITY;
```

El detalle que marca la diferencia es `FORCE`: no solo se habilita RLS, se aplica también al owner de la tabla. Un query mal escrito, una sesión psql manual, cualquier cosa que no haya establecido el contexto de tenant correcto devuelve **cero filas** — nunca un leak.

El contexto de tenant se establece por transacción, nunca en una conexión compartida:

```sql
SELECT set_config('app.tenant_id', $1, true)  -- true = LOCAL a la transacción
```

El `true` es lo importante: sin él, un pool de conexiones compartiría el tenant de la transacción anterior entre requests. Con él, cada transacción empieza limpia. Las políticas comparan contra una función que lee ese GUC:

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

Cuando el GUC es NULL (falta contexto), `current_tenant_id()` devuelve NULL y toda política es falsa: **contexto faltante = cero filas, nunca una fuga**. Y un detalle de diseño que no es casual: las claves primarias compuestas `(id, tenant_id)` en las tablas de negocio hacen imposible referenciar la fila de otro tenant ni siquiera por FK.

## Decisiones de diseño clave

### 1. Refresh tokens que se destruyen ante su propio reuso

El ciclo de vida de una sesión en el campo es largo, así que el refresh token tiene que durar y, sobre todo, tiene que ser seguro. La regla es la misma que en go-authz: tokens opacos de 256 bits, rotación obligatoria, y una familia (`family_id`) que amarra cada rotación a la sesión original.

```go
// DecideRotation es el corazón puro de la rotación + detección de reuso.
// El modelo de amenaza: un atacante que roba un token corre contra el usuario
// legítimo. Quien refresque primero rota; quien llegue segundo presenta un
// token ya revocado y dispara la revocación de toda la familia.
func DecideRotation(revoked bool, replacedBy string, expiresAt, now int64) RefreshTokenDecision {
	if revoked {
		if replacedBy != "" {
			return RotationRejectRevoked // reuso: escalar a revocación de familia
		}
		return RotationRejectInvalid
	}
	if expiresAt <= now {
		return RotationRejectExpired
	}
	return RotationAllow
}
```

El reuso es la señal de robo: si un token ya rotado reaparece, no se rechaza solo ese intento — se revoca la familia completa, matando también el token nuevo que el atacante acaba de obtener. Y solo se guarda el hash SHA-256 del token, nunca el valor en claro: una base filtrada no sirve para rejugar.

### 2. Un audit log que no se puede alterar sin romper la cadena

Todo lo que pasa en la plataforma queda registrado: quién, qué, cuándo, y sobre qué entidad. Pero un log que cualquiera pueda editar en la base no sirve como evidencia. La solución: una cadena de hash SHA-256 donde cada entrada incluye el hash de la anterior.

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

Para que la verificación sea estable, el payload se canoniza antes de hashear (mismo código en inserción y en verificación, para que el orden de claves o el formato de números nunca rompan la cadena). Modificar una entrada del medio rompe el `prev_hash` de la siguiente — la verificación recorre la cadena y reporta la primera entrada rota, con su `seq`.

### 3. Arquitectura hexagonal y una demo que cualquiera puede probar

El código sigue el patrón que ya usé en go-authz: dominio puro y testeable sin infraestructura, casos de uso en la capa de aplicación, y adaptadores (Postgres, HTTP) afuera. Las reglas de seguridad críticas —como `DecideRotation` y la cadena de auditoría— son funciones puras, unit-testeadas sin base de datos ni red.

La diferencia visible es la demo: una SPA embebida en el binario con `go:embed`, que corre en cualquier lugar donde corra el binario. Dos cooperativas de ejemplo, cada una con su propio set completo de datos, y credenciales de acceso documentadas. Sin Redis, sin infraestructura extra — un solo binario, una base Postgres, y RLS haciendo su trabajo.

## Qué gana uno con este enfoque

| Garantía | Cómo se logra |
|---|---|
| Aislamiento de tenant a prueba de bugs de aplicación | RLS `FORCED` en Postgres, aplicada incluso al owner |
| Contexto faltante nunca filtra | GUC local a la transacción + política que devuelve cero filas con NULL |
| Sesión robada se auto-destruye | Tokens opacos 256-bit + rotación + revocación por familia ante reuso |
| Evidencia de auditoría confiable | Cadena SHA-256 con canonización y verificación de cadena completa |
| Sin dependencia de infraestructura extra | SPA embebida con `go:embed`, un solo binario desplegable |
| Reglas de seguridad testeables de verdad | Funciones puras en el dominio, tests sin DB ni red |

Cada garantía de la tabla tiene su test, y el proyecto corre sobre una base Postgres real — no mocks en la capa de persistencia.

## Lo que conscientemente dejé fuera del MVP

- **Redis / rate limiting distribuido.** go-authz lo tiene; agro-iam no lo necesita todavía: un solo binario servido detrás de un proxy puede confiar en los límites del proxy y en Argon2id para las contraseñas. No construyo infraestructura que el dominio no pide.
- **Métricas Prometheus / tracing.** Solo hay logging estructurado con `slog` y healthchecks. Prefiero decirlo explícitamente antes que dejar que el README insinúe algo que el código no tiene.
- **Migrations automáticas en deploy.** Se aplican manualmente desde local con `migrate`. Automatizarlas es una mejora de conveniencia, no una de seguridad.

## Conclusión

agro-iam demuestra que la filosofía de go-authz no era un caso especial: aislamiento reforzado en la capa de datos, sesiones que se auto-curan ante un robo, y evidencia de auditoría que no depende de la buena voluntad de quien edita la base — aplicados a un dominio completamente distinto, con una demo real desplegada que cualquiera puede abrir.

La lección que se repite: **la seguridad multi-tenant no se resuelve con disciplina, se resuelve con diseño.** Si una garantía depende de que un desarrollador recuerde hacer algo en cada query, ya está rota. Cuando el aislamiento vive en la base de datos, en el protocolo de tokens y en la cadena de auditoría, el sistema sigue seguro incluso cuando la gente se equivoca.

La demo está en vivo: https://agro-iam.onrender.com — dos cooperativas, credenciales de prueba documentadas, y todo el código abierto en el repo.