---
title: Why I Chose Hexagonal Architecture to Build a High-Performance IAM Service
slug: arquitectura-hexagonal-iam-en
project: hex-auth-service
status: published
date: 2026-07-11T00:00:00.000Z
lang: en
tags:
  - Python
  - FastAPI
  - Hexagonal Architecture
  - IAM
  - Security
  - Clean Architecture
  - Redis
  - PostgreSQL
translationOf: arquitectura-hexagonal-iam
cover: ''
---

When I started designing hex-auth-service, I knew that an IAM service needs to be maintainable over the long term. Authentication protocols change, databases get migrated, identity providers get replaced. If the business domain is coupled to infrastructure, every change becomes a major surgery.

Hexagonal Architecture —also known as Ports & Adapters— solves exactly that problem. And in hex-auth-service it allowed me to build a system where the authentication core does not know whether it is running on PostgreSQL, Redis, or an in-memory database.

## The coupling problem

A typical IAM service follows this flow:

```
HTTP Request → Controller → Business Logic → Database → Response
```

The problem: each layer depends on the concrete implementation of the next. If you change the database, you touch the business logic. If you change the HTTP framework, you touch the controllers. The domain gets buried under layers of infrastructure.

## How Hexagonal Architecture solves it

The core idea: the domain defines **ports** (interfaces), and infrastructure implements **adapters** that plug into those ports.

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

## Implementation in hex-auth-service

### 1. Domain layer

Defines entities and ports. It imports nothing from infrastructure:

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

### 2. Input adapters (FastAPI)

HTTP endpoints are adapters that translate requests into domain calls:

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

Notice the handler does not know what database sits behind it, or how the token is generated. It only talks to the `TokenService` port.

### 3. Output adapters (PostgreSQL)

The concrete repository implementation:

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

If tomorrow I want to migrate to Redis for tokens, I just implement `TokenRepository` against Redis. The domain does not change.

### 4. O(1) validation with Redis

For access token validation, the port defines:

```python
class TokenValidator(ABC):
    @abstractmethod
    async def is_blacklisted(self, jti: str) -> bool: ...
```

And the Redis implementation:

```python
class RedisTokenValidator(TokenValidator):
    def __init__(self, redis_client):
        self._redis = redis_client

    async def is_blacklisted(self, jti: str) -> bool:
        return await self._redis.exists(f"bl:{jti}")
```

Validation is O(1) — a single Redis call — without touching the main database. This is critical for an IAM service where every authenticated request goes through this check.

## Concrete benefits I gained

### Testability

I can test the entire domain without infrastructure:

```python
async def test_rotate_refresh_token():
    repo = InMemoryTokenRepository()  # In-memory implementation for tests
    crypto = MockCryptoService()
    service = DomainTokenService(repo=repo, crypto=crypto)

    token = RefreshToken(token_id=uuid4(), user_id=uuid4(), ...)
    await repo.save(token)

    new_access, new_refresh = await service.rotate_refresh_token(token.token)
    assert new_refresh.family_id == token.family_id
    assert new_refresh.token_id != token.token_id
```

### Infrastructure migration

Switching from PostgreSQL to MySQL, or adding Redis as a validation cache, does not touch a single line of domain code. You just write a new adapter.

### Separation of concerns

The security team can audit the domain without reading FastAPI or SQL code. Business rules live in one place, free from infrastructure noise.

## Conclusion

Hexagonal Architecture is no more complex than a traditional design once you understand the pattern. In hex-auth-service, this decision let me evolve infrastructure without rewriting the authentication core —and gives me confidence that the system can keep growing without accumulating technical debt in the wrong layer.

If you are building an IAM service, or any system where the business domain has enough complexity to justify it, hexagonal architecture is an investment that pays for itself on the first infrastructure change.
