---
title: Arquitectura Hexagonal en Servicios IAM
slug: arquitectura-hexagonal
project: hex-auth-service
status: published
date: 2026-04-20T00:00:00.000Z
lang: es
tags:
  - Arquitectura
  - IAM
  - Go
cover: ''
---

Cómo aplicar arquitectura hexagonal para construir servicios de identidad mantenibles y testeables.

## ¿Qué es la Arquitectura Hexagonal?

También conocida como *Ports and Adapters*, separa el dominio de negocio de los detalles de infraestructura.

```
┌─────────────┐     ┌──────────────┐
│   Adapter   │ ──► │   Domain     │
│  (HTTP/gRPC)│     │  (Business)  │
└─────────────┘     └──────┬───────┘
                          │
                   ┌──────▼───────┐
                   │   Adapter    │
                   │  (Postgres)  │
                   └──────────────┘
```

## Capas

### Domain

Contiene las entidades, value objects y puertos (interfaces). No importa nada externo.

### Service

Implementa la lógica de negocio usando los puertos definidos en domain.

### Handler

Adapter de entrada. Recibe peticiones HTTP y las traduce a llamadas al service.

### Repository

Adapter de salida. Implementa los puertos de persistencia.

## Aplicación a IAM

En [hex-auth-service](https://github.com/ezequielranieri/hex-auth-service), esta arquitectura permite cambiar la base de datos, agregar nuevos protocolos de autenticación, o reemplazar el sistema de logging sin tocar una línea del dominio.
