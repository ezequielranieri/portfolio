---
title: Cómo construí un workflow engine durable con Sagas usando Python y Celery
slug: workflow-engine-sagas-flowcore
project: flowcore
status: published
date: 2026-07-11T00:00:00.000Z
lang: es
tags:
  - Python
  - Celery
  - RabbitMQ
  - Distributed Systems
  - Sagas
  - Workflow Engine
  - Hexagonal Architecture
  - Resilience
translationOf: workflow-engine-sagas-flowcore-en
cover: ''
---

Cuando empecé a diseñar flowcore, tenía un problema claro: los microservicios distribuidos fallan, y cuando un proceso de varios pasos falla a mitad de camino, necesitás una forma confiable de deshacer lo que ya se ejecutó o reintentar lo que falló sin perder el estado del workflow.

Las transacciones ACID no existen en sistemas distribuidos. Lo que existe es el patrón Saga: una secuencia de transacciones locales donde cada paso tiene una compensación que deshace su efecto si algo sale mal.

## El problema: coreografía frágil

En un enfoque de coreografía, cada servicio publica eventos y otros reaccionan. La coordinación es implícita y frágil: no hay una fuente de verdad única sobre el estado de la transacción distribuida. Si un servicio no recibe un evento, o crashea antes de publicar el suyo, el sistema entero queda en un estado inconsistente sin que nadie lo sepa.

```
Orden Creada → Servicio A → Evento publicado → Servicio B → Evento → Servicio C
                                                                   
Si B crashea antes de publicar: el estado queda colgado sin compensación
```

## Cómo flowcore resuelve esto con orquestación

Flowcore usa un orchestrator central que ejecuta un grafo de pasos. Cada paso es una tarea Celery que puede ser síncrona o async, y que declara su compensación explícitamente.

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

## Implementación del core

### 1. Definición de workflows

Cada workflow se define como un grafo de pasos con compensaciones:

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

### 2. Orchestrator con state machine

El orchestrator mantiene una máquina de estados por instancia de workflow:

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

### 3. Persistencia y recuperación

Cada cambio de estado se persiste en PostgreSQL. Si el worker crashea, el reconciler levanta las instancias PENDING o RUNNING y las re-ejecuta:

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

### 4. Reintentos con backoff exponencial

Cada paso tiene reintentos configurables con backoff:

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

## Beneficios que obtuve con flowcore

### Compensaciones automáticas

Cuando un paso falla después de que otros ya se ejecutaron, el orchestrator ejecuta automáticamente las compensaciones en orden inverso. No hay que acordarse de limpiar manualmente.

### Multi-tenancy nativa

Cada workflow y cada instancia tiene un `tenant_id`. Los stores de PostgreSQL particionan por tenant. Los workers pueden asignarse por tenant para aislar carga.

### Recuperación ante fallos de workers

Si un worker muere mientras ejecuta un paso, el reconciler —que corre como un proceso separado— detecta instancias colgadas y las reasigna a otro worker disponible.

### Observabilidad

Cada transición de estado genera un evento en el event store interno. Esto permite reconstruir el historial completo de cualquier instancia de workflow, auditar decisiones de compensación, y medir tiempo por paso.

```python
class WorkflowEvent:
    instance_id: str
    step_name: str
    from_state: StepState
    to_state: StepState
    timestamp: datetime
    metadata: dict
```

## Conclusión

Flowcore no reinventa Celery: lo usa como capa de ejecución distribuida. Lo que agrega es la orquestación consciente del estado, las compensaciones automáticas del patrón Saga, y la persistencia que permite recuperar instancias después de una caída completa del cluster.

Si estás lidiando con transacciones distribuidas, timeouts, y estados inconsistentes entre microservicios, un workflow engine como flowcore transforma el problema de "cómo coordino N servicios" en "cómo defino un grafo de pasos con sus compensaciones". El resto lo resuelve el engine.
