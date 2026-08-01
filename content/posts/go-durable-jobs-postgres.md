---
title: Cómo construí una cola durable de jobs en Go usando solo Postgres
slug: go-durable-jobs-postgres
project: go-durable-jobs
status: published
date: 2026-08-01T00:00:00.000Z
lang: es
tags:
  - Go
  - PostgreSQL
  - Durable Jobs
  - Idempotency
  - Distributed Systems
  - Clean Architecture
  - Resilience
translationOf: go-durable-jobs-postgres-en
cover: ''
---

Cuando empecé a diseñar go-durable-jobs, tenía un problema concreto: cualquier sistema que dispare trabajo asíncrono (enviar un email, cobrar una tarjeta, generar un reporte, notificar un webhook) tarde o temprano se enfrenta a tres preguntas incómodas.

1. ¿Qué pasa si el proceso se cae a mitad de un job?
2. ¿Qué pasa si el mismo job se dispara dos veces por un timeout de red?
3. ¿Qué pasa cuando un job falla por un error transitorio?

La tentación es levantar RabbitMQ, Kafka o Redis Streams. Pero el problema no pedía todavía esa infraestructura. Lo que necesitaba era **no perder jobs**, **no duplicarlos** y **reintentar de forma controlada**, usando las herramientas más simples que den la garantía correcta.

La respuesta fue Postgres como única fuente de verdad + un worker pool nativo en Go.

## El problema de las colas en memoria o brokers prematuros

Una cola en memoria (o un simple channel de Go) se pierde al reiniciar el proceso. Un broker externo resuelve la durabilidad, pero agrega complejidad operativa, otra pieza que monitorear y otra superficie de fallo. Para un MVP (y para muchos sistemas de tamaño mediano) es over-engineering.

go-durable-jobs toma el camino contrario: **la base de datos que ya tenés es la cola**.

```
┌─────────────────────────────────────────────────────────┐
│                    go-durable-jobs                       │
│  ┌─────────────┐    ┌──────────────────────────────┐   │
│  │  HTTP API   │───►│        Application           │   │
│  │  /jobs      │    │  (use cases + domain)        │   │
│  └─────────────┘    └──────────────┬───────────────┘   │
│                                    │                    │
│  ┌─────────────┐    ┌──────────────▼───────────────┐   │
│  │ Worker Pool │◄───│   Postgres Job Repository    │   │
│  │ (N workers) │    │  SELECT ... FOR UPDATE       │   │
│  └─────────────┘    │  SKIP LOCKED                 │   │
│                     └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Decisiones de diseño clave

### 1. Idempotencia real vía unique constraint

El mismo `idempotency_key` nunca crea dos jobs. Si llega un POST duplicado, el sistema responde **200 OK** con el job existente (estilo Stripe), no un 500 ni un 409 agresivo.

```go
// En el repositorio
func (r *PostgresJobRepository) Create(ctx context.Context, job *domain.Job) error {
    _, err := r.pool.Exec(ctx, `
        INSERT INTO jobs (id, idempotency_key, type, payload, status, max_attempts, available_at)
        VALUES ($1, $2, $3, $4, 'pending', $5, NOW())
    `, job.ID, job.IdempotencyKey, job.Type, job.Payload, job.MaxAttempts)

    if isUniqueViolation(err) {
        // Conflicto de idempotencia → devolvemos el existente
        existing, err := r.FindByIdempotencyKey(ctx, job.IdempotencyKey)
        if err != nil {
            return err
        }
        *job = *existing
        return domain.ErrAlreadyExists
    }
    return err
}
```

En la capa de aplicación se traduce a un 200 con el body del job ya creado. El cliente que reintenta recibe éxito, no un error que tenga que manejar de forma distinta.

### 2. Dequeue seguro con SKIP LOCKED

Varios workers pueden competir por la misma cola sin pisarse. La clave es:

```sql
SELECT id, type, payload, attempts, max_attempts
FROM jobs
WHERE status = 'pending'
  AND available_at <= NOW()
ORDER BY priority DESC, created_at
FOR UPDATE SKIP LOCKED
LIMIT 1
```

El filtro explícito de `available_at` es obligatorio: sin él el delay de los retries no funciona correctamente. `SKIP LOCKED` garantiza que dos workers nunca tomen el mismo row.

### 3. Retries con backoff + Dead Letter Queue explícita

No se reintenta para siempre. Cada job tiene `max_attempts` (default 5). Al fallar:

- Se calcula un delay exponencial con jitter.
- Se actualiza `available_at` y se vuelve a `pending`.
- Si se agotan los intentos → `status = 'dead'`.

La DLQ no es otra tabla. Es el mismo modelo con un estado distinto y un endpoint de reencolado:

```
POST /jobs/{id}/requeue
```

Solo permite reencolar si el job está en `dead`. Si no → 409 Conflict. Al reencolar se resetean `attempts`, `last_error` y `available_at`.

### 4. Graceful shutdown que no corta jobs

Cuando llega SIGINT/SIGTERM el servidor no mata los workers a mitad de ejecución. Espera a que terminen el job actual (con un grace period configurable) y recién después cierra.

```
signal received → stop accepting new work → wait for in-flight jobs → exit
```

Esto se logra con `context` + `errgroup` y un drain ordenado del pool.

## Qué gana uno con este enfoque

| Garantía | Cómo se logra |
|---|---|
| No perder jobs | Postgres como source of truth |
| No duplicar jobs | Unique constraint + 200 en conflicto |
| No reintentar eterno | `max_attempts` + `status = dead` |
| Concurrencia segura | `FOR UPDATE SKIP LOCKED` |
| Observabilidad | Prometheus (enqueued, processed, in-flight, histograma) |
| Operación simple | Una sola pieza de infra (la DB que ya tenés) |

Además, el proyecto está pensado como ejercicio deliberado de concurrencia correcta en Go: los tests corren con `-race` y hay benchmarks reales de scaling del mecanismo de dequeue.

## Lo que conscientemente dejé fuera del MVP

- Redis (quedó para Fase 2: idempotencia rápida / rate limiting).
- Circuit breaker (los jobs del MVP no llaman servicios externos por defecto).
- OpenTelemetry (solo métricas Prometheus + `slog` por ahora).
- CLI de inspección y tracing distribuido.

La decisión de no sumar infra prematura está documentada en `DECISIONS.md`. Si una tarea entra en conflicto con esas reglas, se detiene y se discute antes de implementar.

## Conclusión

go-durable-jobs no inventa nada nuevo: usa un patrón conocido (cola durable sobre base relacional) y lo implementa de forma limpia, testeable y con garantías explícitas. La arquitectura hexagonal mantiene el dominio libre de detalles de Postgres, el worker pool es nativo y el comportamiento ante fallos está definido de antemano (no "se ve en producción").

Si estás construyendo un sistema que necesita at-least-once delivery, idempotencia real y retries controlados, y todavía no justifica un broker, Postgres + `SKIP LOCKED` + un buen modelo de estados es una base sólida y honesta.

El código, los tests, los benchmarks y la retrospectiva están en el repo. El siguiente paso natural es la Fase 2 (Redis, CLI de inspección y tracing), pero solo cuando el problema lo pida.
