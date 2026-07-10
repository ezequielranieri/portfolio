---
title: Understanding Identity & Access Management
slug: understanding-iam
project: hex-auth-service
status: published
date: 2026-06-01T00:00:00.000Z
lang: en
tags:
  - IAM
  - Security
cover: ''
---

An introduction to IAM concepts, protocols, and architectural patterns for building secure authentication and authorization systems.

## Why IAM Matters

Identity and Access Management is the foundation of modern application security. Without a robust IAM system, you're essentially leaving the door open.

## Core Concepts

### Authentication

Authentication answers the question "who are you?" Common methods include:

- Password-based
- Multi-factor
- OAuth 2.0 / OIDC
- WebAuthn / Passkeys

### Authorization

Authorization determines "what can you do?" after authentication:

- Role-Based Access Control (RBAC)
- Attribute-Based Access Control (ABAC)
- Policy-Based Access Control (PBAC)

## Architectural Patterns

When building IAM services, the hexagonal architecture pattern keeps the domain clean and independent of infrastructure concerns. This is the approach used in [hex-auth-service](https://github.com/ezequielranieri/hex-auth-service).
