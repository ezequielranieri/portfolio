---
title: Por qué elegí Arquitectura Hexagonal para construir un servicio IAM de alto rendimiento
slug: arquitectura-hexagonal-iam
project: hex-auth-service
status: published
date: 2026-07-11T00:00:00.000Z
lang: es
tags:
  - Python
  - FastAPI
  - Hexagonal Architecture
  - IAM
  - Security
  - Clean Architecture
  - Redis
  - PostgreSQL
translationOf: arquitectura-hexagonal-iam-en
cover: ''
---

Cuando empecé a diseñar hex-auth-service, sabía que un servicio IAM necesita ser mantenible a largo plazo. Los protocolos de autenticación cambian, las bases de datos se migran, los proveedores de identidad se reemplazan. Si el dominio de negocio está acoplado a la infraestructura, cada cambio se vuelve una cirugía mayor.

La Arquitectura Hexagonal —también conocida como Ports & Adapters— resuelve exactamente ese problema. Y en hex-auth-service me permitió construir un sistema donde el núcleo de autenticación no sabe si está corriendo sobre PostgreSQL, Redis o una base de datos en memoria.

## El problema del acoplamiento

Un servicio IAM típico tiene este flujo:

```
HTTP Request → Controlador → Lógica de negocio → Base de datos → Respuesta
```

El problema: cada capa depende de la implementación concreta de la siguiente. Si cambias la base de datos, tocás la lógica de negocio. Si cambiás el framework HTTP, tocás los controladores. El dominio queda enterrado bajo capas de infraestructura.

## Cómo lo resuelve la Arquitectura Hexagonal

La idea central: el dominio define **puertos** (interfaces), y la infraestructura implementa **adaptadores** que se conectan a esos puertos.

```
                   ┌─────────────────────────────────────┐
                   │           Application               │
                   │  ┌───────────────────────────────┐  │
                   │  │          Domain               │  │
                   │  │  ┌─────────┐  ┌───────────┐  │  │
  HTTP ─────►──►──┼──┼──┤ Port    │  │  Port     │  │  │
                   │  │  │ (in)   │  │  (out)    │  │  │
                   │  │  └────┬────┘  └─────┬─────┘  │  │
                   │  └───────┼─────────────┼─────────┘  │
                   │          │             │            │
                   │  ┌───────▼────┐  ┌─────▼────────┐  │
                   │  │  Adapter   │  │   Adapter    │  │
                   │  │  (FastAPI) │  │ (PostgreSQL) │  │
                   │  └────────────┘  └──────────────┘  │
                   └─────────────────────────────────────┘
```

## Implementación en hex-auth-service

### 1. Capa de dominio

Define las entidades y puertos. No importa nada de infraestructura:

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass
from uuid import UUID


@dataclass
class AccessToken:
    user_id: UUID
    claims: dict
    expires_at: int


@dataclass
class RefreshToken:
    token_id: UUID
    user_id: UUID
    family_id: UUID
    expires_at: int


class TokenRepository(ABC):
    @abstractmethod
    async def save(self, token: RefreshToken) -> None: ...

    @abstractmethod
    async def find_by_id(self, token_id: UUID) -> RefreshToken | None: ...

    @abstractmethod
    async def revoke_family(self, family_id: UUID) -> None: ...


class TokenService(ABC):
    @abstractmethod
    async def generate_access_token(self, user_id: UUID) -> AccessToken: ...

    @abstractmethod
    async def validate_access_token(self, raw: str) -> AccessToken | None: ...

    @abstractmethod
    async def rotate_refresh_token(self, raw: str) -> tuple[AccessToken, RefreshToken]: ...
```

### 2. Adaptadores de entrada (FastAPI)

Los endpoints HTTP son adaptadores que traducen requests a llamadas al dominio:

```python
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

router = APIRouter()


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str


@router.post("/auth/refresh", response_model=TokenResponse)
async def refresh_token(
    body: RefreshRequest,
    token_service: TokenService = Depends(get_token_service),
):
    try:
        access, refresh = await token_service.rotate_refresh_token(
            body.refresh_token
        )
        return TokenResponse(
            access_token=access.token,
            refresh_token=refresh.token,
        )
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid token")
```

Nótese que el handler no sabe qué base de datos hay detrás, ni cómo se genera el token. Solo habla con el puerto `TokenService`.

### 3. Adaptadores de salida (PostgreSQL)

La implementación concreta del repositorio:

```python
import asyncpg
from uuid import UUID


class PostgresTokenRepository(TokenRepository):
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def save(self, token: RefreshToken) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO refresh_tokens (token_id, user_id, family_id, expires_at)
                VALUES ($1, $2, $3, $4)
                """,
                token.token_id, token.user_id, token.family_id, token.expires_at,
            )

    async def find_by_id(self, token_id: UUID) -> RefreshToken | None:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM refresh_tokens WHERE token_id = $1",
                token_id,
            )
            if not row:
                return None
            return RefreshToken(
                token_id=row["token_id"],
                user_id=row["user_id"],
                family_id=row["family_id"],
                expires_at=row["expires_at"],
            )

    async def revoke_family(self, family_id: UUID) -> None:
        async with self._pool.acquire() as conn:
            await conn.execute(
                "UPDATE refresh_tokens SET revoked = true WHERE family_id = $1",
                family_id,
            )
```

Si mañana quiero migrar a Redis para tokens, solo implemento `TokenRepository` contra Redis. El dominio no cambia.

### 4. Validación O(1) con Redis

Para la validación de access tokens, el puerto define:

```python
class TokenValidator(ABC):
    @abstractmethod
    async def is_blacklisted(self, jti: str) -> bool: ...
```

Y la implementación Redis:

```python
class RedisTokenValidator(TokenValidator):
    def __init__(self, redis_client):
        self._redis = redis_client

    async def is_blacklisted(self, jti: str) -> bool:
        return await self._redis.exists(f"bl:{jti}")
```

La validación es O(1) — una sola llamada a Redis — sin tocar la base de datos principal. Esto es crítico para un servicio IAM donde cada request autenticado pasa por este check.

## Beneficios concretos que obtuve

### Testabilidad

Puedo testear el dominio completo sin infraestructura:

```python
async def test_rotate_refresh_token():
    repo = InMemoryTokenRepository()  # Implementación en memoria para tests
    crypto = MockCryptoService()
    service = DomainTokenService(repo=repo, crypto=crypto)

    token = RefreshToken(token_id=uuid4(), user_id=uuid4(), ...)
    await repo.save(token)

    new_access, new_refresh = await service.rotate_refresh_token(token.token)
    assert new_refresh.family_id == token.family_id
    assert new_refresh.token_id != token.token_id
```

### Migración de infraestructura

Cambiar de PostgreSQL a MySQL, o agregar Redis como caché de validación, no toca ni una línea del dominio. Solo escribís un nuevo adaptador.

### Separación de concerns

El equipo de seguridad puede auditar el dominio sin leer código de FastAPI o SQL. Las reglas de negocio están en un solo lugar, sin ruido de infraestructura.

## Conclusión

La Arquitectura Hexagonal no es más compleja que un diseño tradicional una vez que entendés el patrón. En hex-auth-service, esta decisión me permitió evolucionar la infraestructura sin reescribir el núcleo de autenticación —y me da la confianza de que el sistema puede seguir creciendo sin acumular deuda técnica en la capa equivocada.

Si estás construyendo un servicio IAM, o cualquier sistema donde el dominio de negocio tenga suficiente complejidad como para justificarlo, la arquitectura hexagonal es una inversión que se paga sola en el primer cambio de infraestructura.
