---
title: How I Built a Durable Job Queue in Go Using Only Postgres
slug: go-durable-jobs-postgres-en
project: go-durable-jobs
status: published
date: 2026-08-01T00:00:00.000Z
lang: en
tags:
  - Go
  - PostgreSQL
  - Durable Jobs
  - Idempotency
  - Distributed Systems
  - Clean Architecture
  - Resilience
translationOf: go-durable-jobs-postgres
cover: ''
---

When I started designing go-durable-jobs, I had a concrete problem: any system that fires off asynchronous work (sending an email, charging a card, generating a report, notifying a webhook) eventually runs into three uncomfortable questions.

1. What happens if the process crashes mid-job?
2. What happens if the same job fires twice because of a network timeout?
3. What happens when a job fails due to a transient error?

The temptation is to stand up RabbitMQ, Kafka, or Redis Streams. But the problem didn't ask for that infrastructure yet. What I needed was **never lose a job**, **never duplicate a job**, and **retry in a controlled way**, using the simplest tools that provide the right guarantee.

The answer was Postgres as the single source of truth + a native Go worker pool.

## The problem with in-memory queues or premature brokers

An in-memory queue (or a plain Go channel) disappears on process restart. An external broker solves durability, but adds operational complexity, another component to monitor, and another failure surface. For an MVP (and for many medium-sized systems) it's over-engineering.

go-durable-jobs takes the opposite path: **the database you already have is the queue**.

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

## Key design decisions

### 1. Real idempotency via unique constraint

The same `idempotency_key` never creates two jobs. If a duplicate POST arrives, the system responds with **200 OK** and the existing job (Stripe-style), not a 500 or an aggressive 409.

```go
// In the repository
func (r *PostgresJobRepository) Create(ctx context.Context, job *domain.Job) error {
    _, err := r.pool.Exec(ctx, `
        INSERT INTO jobs (id, idempotency_key, type, payload, status, max_attempts, available_at)
        VALUES ($1, $2, $3, $4, 'pending', $5, NOW())
    `, job.ID, job.IdempotencyKey, job.Type, job.Payload, job.MaxAttempts)

    if isUniqueViolation(err) {
        // Idempotency conflict → return the existing one
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

In the application layer this is translated into a 200 with the body of the already-created job. The client that retries receives success, not an error it has to handle differently.

### 2. Safe dequeue with SKIP LOCKED

Multiple workers can compete for the same queue without stepping on each other. The key is:

```sql
SELECT id, type, payload, attempts, max_attempts
FROM jobs
WHERE status = 'pending'
  AND available_at <= NOW()
ORDER BY priority DESC, created_at
FOR UPDATE SKIP LOCKED
LIMIT 1
```

The explicit `available_at` filter is mandatory: without it, retry delays don't work correctly. `SKIP LOCKED` guarantees that two workers never claim the same row.

### 3. Retries with backoff + explicit Dead Letter Queue

It does not retry forever. Every job has `max_attempts` (default 5). On failure:

- An exponential delay with jitter is calculated.
- `available_at` is updated and the job goes back to `pending`.
- If attempts are exhausted → `status = 'dead'`.

The DLQ is not a separate table. It's the same model with a different status and a requeue endpoint:

```
POST /jobs/{id}/requeue
```

It only allows requeuing if the job is `dead`. Otherwise → 409 Conflict. On requeue, `attempts`, `last_error`, and `available_at` are reset.

### 4. Graceful shutdown that doesn't cut jobs short

When SIGINT/SIGTERM arrives, the server does not kill workers mid-execution. It waits for in-flight jobs to finish (with a configurable grace period) and only then exits.

```
signal received → stop accepting new work → wait for in-flight jobs → exit
```

This is achieved with `context` + `errgroup` and an ordered drain of the pool.

## What you gain with this approach

| Guarantee | How it's achieved |
|---|---|
| Never lose jobs | Postgres as source of truth |
| Never duplicate jobs | Unique constraint + 200 on conflict |
| No infinite retries | `max_attempts` + `status = dead` |
| Safe concurrency | `FOR UPDATE SKIP LOCKED` |
| Observability | Prometheus (enqueued, processed, in-flight, histogram) |
| Simple operations | A single piece of infrastructure (the DB you already have) |

In addition, the project is a deliberate exercise in correct concurrency in Go: tests run under `-race` and there are real scaling benchmarks of the dequeue mechanism.

## What I deliberately left out of the MVP

- Redis (reserved for Phase 2: fast idempotency / rate limiting).
- Circuit breaker (MVP jobs do not call external services by default).
- OpenTelemetry (only Prometheus metrics + `slog` for now).
- Inspection CLI and distributed tracing.

The decision not to add premature infrastructure is documented in `DECISIONS.md`. If a task conflicts with those rules, work stops and the decision is discussed before implementing.

## Conclusion

go-durable-jobs doesn't invent anything new: it uses a known pattern (durable queue on a relational database) and implements it cleanly, testably, and with explicit guarantees. Hexagonal architecture keeps the domain free of Postgres details, the worker pool is native, and failure behaviour is defined up front (not "we'll see in production").

If you're building a system that needs at-least-once delivery, real idempotency, and controlled retries, and it doesn't yet justify a broker, Postgres + `SKIP LOCKED` + a solid state model is a solid and honest foundation.

The code, tests, benchmarks, and retrospective are in the repo. The natural next step is Phase 2 (Redis, inspection CLI, and tracing), but only when the problem asks for it.
