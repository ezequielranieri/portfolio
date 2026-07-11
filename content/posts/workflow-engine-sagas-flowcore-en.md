---
title: How I Built a Durable Workflow Engine with Sagas Using Python and Celery
slug: workflow-engine-sagas-flowcore-en
project: flowcore
status: published
date: 2026-07-11T00:00:00.000Z
lang: en
tags:
  - Python
  - Celery
  - RabbitMQ
  - Distributed Systems
  - Sagas
  - Workflow Engine
  - Hexagonal Architecture
  - Resilience
translationOf: workflow-engine-sagas-flowcore
cover: ''
---

When I started designing flowcore, I had a clear problem: distributed microservices fail, and when a multi-step process fails halfway through, you need a reliable way to undo what already executed or retry what failed without losing workflow state.

ACID transactions don't exist in distributed systems. What does exist is the Saga pattern: a sequence of local transactions where each step has a compensating action that undoes its effect if something goes wrong.

## The problem: fragile choreography

In a choreography approach, each service publishes events and others react. Coordination is implicit and fragile: there is no single source of truth about the distributed transaction's state. If a service misses an event, or crashes before publishing its own, the entire system ends up in an inconsistent state without anyone knowing.

```
Order Created → Service A → Event published → Service B → Event → Service C
                                                                   
If B crashes before publishing: state hangs without compensation
```

## How flowcore solves this with orchestration

Flowcore uses a central orchestrator that executes a step graph. Each step is a Celery task that can be sync or async, and explicitly declares its compensation.

```
                  ┌──────────────────────────────────────┐
                  │            flowcore-engine            │
                  │  ┌────────────────────────────────┐  │
                  │  │         Orchestrator            │  │
                  │  │  ┌──────┐  ┌──────┐  ┌──────┐  │  │
                  │  │  │Step 1│→│Step 2│→│Step 3│  │  │
                  │  │  └──┬───┘  └──┬───┘  └──┬───┘  │  │
                  │  │     │         │         │      │  │
                  │  │  ┌──▼───┐  ┌──▼───┐  ┌──▼───┐  │  │
                  │  │  │Comp 1│  │Comp 2│  │Comp 3│  │  │
                  │  │  └──────┘  └──────┘  └──────┘  │  │
                  │  └────────────────────────────────┘  │
                  │                                       │
                  │  ┌──────────┐  ┌──────────────────┐  │
                  │  │ History  │  │ State Store (PG) │  │
                  │  │ (Event   │  │ persistence +    │  │
                  │  │  Store)  │  │ recovery         │  │
                  │  └──────────┘  └──────────────────┘  │
                  └──────────────────────────────────────┘
```

## Core implementation

### 1. Workflow definition

Each workflow is defined as a step graph with compensations:

```python
from dataclasses import dataclass, field
from typing import Callable, Awaitable


@dataclass
class Step:
    name: str
    run: Callable[..., Awaitable[dict]]
    compensate: Callable[..., Awaitable[None]] | None = None
    depends_on: list[str] = field(default_factory=list)
    max_retries: int = 3
    timeout: int = 300


@dataclass
class WorkflowDefinition:
    name: str
    version: int
    steps: dict[str, Step]
    tenant_id: str | None = None
```

### 2. Orchestrator with state machine

The orchestrator maintains a state machine per workflow instance:

```python
from enum import Enum, auto


class StepState(Enum):
    PENDING = auto()
    RUNNING = auto()
    COMPLETED = auto()
    FAILED = auto()
    COMPENSATING = auto()
    COMPENSATED = auto()


class WorkflowInstance:
    def __init__(self, workflow: WorkflowDefinition, instance_id: str):
        self.workflow = workflow
        self.instance_id = instance_id
        self.states: dict[str, StepState] = {
            name: StepState.PENDING for name in workflow.steps
        }
        self.results: dict[str, dict] = {}
        self.failed_step: str | None = None

    async def execute(self):
        for step_name, step in self.workflow.steps.items():
            deps_met = all(
                self.states[d] == StepState.COMPLETED
                for d in step.depends_on
            )
            if not deps_met:
                continue

            self.states[step_name] = StepState.RUNNING
            try:
                result = await self._run_with_retry(step)
                self.results[step_name] = result
                self.states[step_name] = StepState.COMPLETED
                await self._persist_state()
            except Exception as e:
                self.states[step_name] = StepState.FAILED
                self.failed_step = step_name
                await self._compensate()
                raise WorkflowFailedError(step_name, str(e))

    async def _compensate(self):
        executed = [
            name for name, state in self.states.items()
            if state == StepState.COMPLETED
        ]
        for step_name in reversed(executed):
            step = self.workflow.steps[step_name]
            if step.compensate:
                self.states[step_name] = StepState.COMPENSATING
                try:
                    await step.compensate(self.results.get(step_name, {}))
                except Exception:
                    logger.exception(f"Compensation failed for {step_name}")
                self.states[step_name] = StepState.COMPENSATED
            await self._persist_state()
```

### 3. Persistence and recovery

Every state transition is persisted to PostgreSQL. If a worker crashes, the reconciler picks up PENDING or RUNNING instances and re-executes them:

```python
class PostgresWorkflowStore:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def save_instance(self, instance: WorkflowInstance) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO workflow_instances
                    (instance_id, workflow_name, version, tenant_id, states, results)
                VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
                ON CONFLICT (instance_id)
                DO UPDATE SET states = $5::jsonb, results = $6::jsonb,
                              updated_at = NOW()
                """,
                instance.instance_id,
                instance.workflow.name,
                instance.workflow.version,
                instance.workflow.tenant_id,
                json.dumps({k: v.name for k, v in instance.states.items()}),
                json.dumps(instance.results, default=str),
            )

    async def get_pending_instances(self) -> list[WorkflowInstance]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM workflow_instances WHERE states::jsonb ? 'RUNNING' "
                "OR states::jsonb ? 'PENDING'"
            )
            return [self._row_to_instance(row) for row in rows]
```

### 4. Retries with exponential backoff

Each step has configurable retries with backoff:

```python
import asyncio
import random


async def _run_with_retry(self, step: Step) -> dict:
    last_exc = None
    for attempt in range(step.max_retries):
        try:
            task = asyncio.create_task(step.run(self.results))
            return await asyncio.wait_for(task, timeout=step.timeout)
        except Exception as e:
            last_exc = e
            if attempt < step.max_retries - 1:
                delay = (2 ** attempt) + random.uniform(0, 1)
                logger.warning(
                    f"Step {step.name} failed (attempt {attempt + 1}), "
                    f"retrying in {delay:.1f}s"
                )
                await asyncio.sleep(delay)
    raise last_exc
```

## Benefits I gained with flowcore

### Automatic compensations

When a step fails after others have already executed, the orchestrator automatically runs compensations in reverse order. No need to remember to clean up manually.

### Native multi-tenancy

Every workflow and every instance has a `tenant_id`. PostgreSQL stores partition by tenant. Workers can be assigned per tenant to isolate load.

### Worker failure recovery

If a worker dies while executing a step, the reconciler —running as a separate process— detects stuck instances and reassigns them to an available worker.

### Observability

Every state transition generates an event in the internal event store. This allows reconstructing the full history of any workflow instance, auditing compensation decisions, and measuring per-step timing.

```python
class WorkflowEvent:
    instance_id: str
    step_name: str
    from_state: StepState
    to_state: StepState
    timestamp: datetime
    metadata: dict
```

## Conclusion

Flowcore does not reinvent Celery: it uses it as a distributed execution layer. What it adds is state-aware orchestration, automatic Saga compensations, and persistence that recovers instances after a full cluster outage.

If you are dealing with distributed transactions, timeouts, and inconsistent states between microservices, a workflow engine like flowcore transforms the problem from "how do I coordinate N services" into "how do I define a step graph with its compensations". The engine handles the rest.
