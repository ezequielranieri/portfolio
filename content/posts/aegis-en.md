---
title: Running Untrusted WebAssembly Requires More Than a Sandbox — aegis, Capability-Based Execution with Signed Receipts and Two Phases
slug: aegis-en
project: aegis
status: published
date: 2026-09-16T00:00:00.000Z
lang: en
tags:
  - Rust
  - WebAssembly
  - Wasmtime
  - gRPC
  - Ed25519
  - BLAKE3
  - mTLS
  - Sandbox
  - Capability-Based Security
  - Receipts
  - Fuel Metering
  - Two-Phase Execution
translationOf: aegis
cover: ''
---

When I started aegis, the problem was concrete: running code I don't control requires that every access to a resource be gated and every side effect be provable. A sandbox by itself is not enough — the sandbox protects you from what the guest shouldn't be able to do, but it doesn't tell you what it did.

> **Current status: Phase 9 (two-phase receipts) implemented** — `cargo test` green (160 tests), `cargo clippy --all-targets -- -D warnings` clean, `cargo fmt --check` clean. Runtime with **capability-based host functions**, **Ed25519 + BLAKE3 hash-chained receipts**, **two-phase execution (prepare/commit/abort)**, **fuel metering**, and **gRPC with configurable mTLS (CN/SAN validation)**. CI green on GitHub.

1. **How do you guarantee the guest only touches what it was authorized to?** If the model is "the code runs in a sandbox," one extra syscall becomes an audit dilemma: who authorized that file?
2. **How do you prove what executed and what it cost?** "The WASM ran fine" is not evidence. You need a signed receipt that proves what executed, with what result, and at what cost — verifiable offline, without contacting the runtime.
3. **How do you separate intent from outcome?** An execution that fails halfway leaves the system ambivalent: was it attempted, completed, or something in between? Two-phase execution turns that ambiguity into a protocol.

The temptation was the classic one: "I run the guest in Wasmtime and done." That gives you memory isolation, but it doesn't give you a policy. The answer was combining **capability-based host functions** (deny by default, each capability declares its exact scope), **signed hash-chained receipts per execution**, **two-phase execution** (a `prepare` receipt before running, a `commit` or `abort` receipt after), **hard limits** (memory, fuel, epoch interruption), and **configurable mTLS** on the gRPC boundary — in two Rust binaries: `aegis-runtime` (gRPC server) and `aegis-verify` (offline verifier for receipt chains).

## The problem with trusting "the sandbox protects me"

Running untrusted WebAssembly has two faces. The first is technical: the guest must not be able to read arbitrary files, make HTTP calls to any host, or exhaust the host process's CPU. A sandbox solves that. The second is design: when the guest asks for access, who decides what it can touch, and how is that proven afterwards? If the answer is "the guest asks for all of WASI and the host trusts it," you don't have a security model — you have a bad habit.

The classic failure isn't a sophisticated attack: it's a broad capability. Giving the guest full `filesystem` because "the code is trusted" is the equivalent of a missing `WHERE tenant_id = ?` — not a bug, a potential breach. The right solution starts backwards: the guest has **nothing** until the policy declares otherwise.

## Key design decisions

### 1. Capability-based host functions, not WASI

WASI provides broad, generic access. aegis does not expose WASI: there are four capability names — `filesystem.read`, `filesystem.write`, `network.http`, `two_phase_receipts` — and each guest receives **exactly** the ones declared in its `PolicyConfig` — nothing more. Only the first three are executable: `two_phase_receipts` is a marker that enables the two-phase RPCs (`ExecutePrepare`/`ExecuteCommit`/`ExecuteAbort`), not an executable capability, and the handler rejects it as one. Each capability is also scoped:

- `filesystem.read` with an `allowed_root`: the guest only reads under that directory.
- `network.http` with host and method allowlists: the guest only calls where the policy permits.

It's deny by default: a guest with no configuration cannot touch files or the network. There is no "everything open" mode.

### 2. Signed, hash-chained receipts

Every execution produces a receipt signed with **Ed25519** and hashed with **BLAKE3**, chained to previous ones. The receipt proves *what executed, with what result, and at what cost*. The chain lives inside the runtime via `ReceiptEmitter` and can be verified **offline** with `aegis-verify <chain.json> <public_key_b64>` — no need to contact the server again.

This is what separates "the WASM ran" from "we can prove it": when a client asks about yesterday's execution, the receipt chain is the proof, not the runtime's word.

### 3. Two-phase execution: intent gets signed too

`ExecutePrepare` / `ExecuteCommit` / `ExecuteAbort` form the two-phase protocol:

1. `ExecutePrepare` produces a signed `prepare` receipt **before** any WASM runs — intent is recorded.
2. `ExecuteCommit` (or `ExecuteAbort`) produces the final receipt **after** execution — outcome is recorded.

Both intent and outcome are provable. A failure halfway leaves a consistent trail: there's a signed `prepare` and a signed `abort`, and there's no ambiguity about what happened. It's the same spirit as two-phase patterns in distributed systems, applied to execution evidence.

### 4. Hard limits: memory, instances, and CPU

The Wasmtime sandbox is bounded from the base: **1 MiB of memory**, 1024 table elements, **4 instances**, and 2 memories per store as the ceiling. The CPU budget has two mechanisms:

- **Epoch interruption**: the wall-clock boundary that cuts execution even if the guest spins in an endless loop.
- **Fuel metering**: deterministic per-execution CPU accounting; exhausting fuel produces "fuel budget exceeded".

They're complementary: epoch cuts, fuel accounts. And `fuel_budget` and `max_concurrent` are configurable via TOML, declaratively.

### 5. Configurable mTLS with identity validation on the gRPC boundary

The gRPC server supports configurable mTLS: when `server.tls` is present, it requires clients to present a certificate signed by the configured CA, with `CN`/`SAN` matching `expected_identity` — no match, no connection. Without a TLS configuration, the server still starts, with a warning and unencrypted connections (not suitable for production).

### 6. Offline verification, declarative architecture

The runtime is declarative: a TOML configuration declares server settings, TLS identity, the signing key, policy defaults, and execution knobs. The two binaries the crate produces:

| Binary | Purpose |
|--------|---------|
| `aegis-runtime` | gRPC server with mTLS, receipts, and sandbox |
| `aegis-verify` | Offline verifier for receipt chains |

## The flaky test that was a production bug

The most interesting thing about aegis didn't come out of a design: it came out of CI. The network E2E tests failed "every now and then," with an unmistakable pattern: `13 passed; 1 failed`. The classic suspects were fixed ports (`50071`, `50072`, and a range in `50051-50063`) plus a blind `sleep(100ms)` before connecting. That combination produced a deterministic failure under parallel test binaries: the bind failed silently, the client connected to **another instance's** server, and the certificate signed by a different CA exploded with `BadSignature` — 8 of 8 instances failed that way.

The harness fix was standard: ephemeral ports (`bind(127.0.0.1:0)` → read the real port) and a **readiness probe** (TCP connect retry up to ~5s) instead of sleeping blind. Result: `BadSignature` eliminated, 0 in more than 40 parallel instances.

But one residual failure remained, 2 out of 6 full-suite runs: `network timeout exceeded` in a successful-fetch test. That's where the real bug was, and it wasn't in the tests: the gRPC handler executed the WASM **synchronously on an async runtime worker**, and the guest performs blocking HTTP fetches (ureq) inside host functions. Under load, all runtime workers ended up blocked on concurrent fetches, the stub's TLS async task never got to run, and the 5-second wall-clock timeout fired before the handshake finished. The fix was `block_in_place` around the WASM execution (guarded by runtime flavor, because tests running on `current_thread` cannot use it) — the correct production pattern: blocking I/O must never occupy an async worker.

The moral is the usual one: a flaky test is almost never the test. It's a production bug telling you there's dirt in the basement. The `BadSignature` was the smoke; the `ureq` call blocking the async runtime was the fire.

## What you gain from this approach

- **Explicit policy**: each guest declares what it can touch; the runtime neither guesses nor relaxes.
- **Verifiable evidence**: signed, chained receipts turn execution into a provable fact, not a promise.
- **Protocol instead of ambiguity**: two phases means intent and outcome are both auditable.
- **Hard limits from the base**: memory, instances, fuel, and epoch aren't configurable "just in case" — they're the default.
- **mTLS with verified identity**: when configured, the client certificate must match the expected identity; without a TLS configuration, the server doesn't start silently — it warns you.

## What I deliberately left out

- **WASI**: we don't expose it. aegis's capabilities are narrower and more auditable; if real WASI is ever needed, it will be another explicit capability, never the default.
- **Distributed plugins**: the runtime is designed as a service — receipts make it verifiable without being a distributed execution system.
- **Hot policy reload**: today policy is declared per request; a hot policy admission system could be a future phase, but it wasn't in the MVP scope.

## Conclusion

aegis started with an uncomfortable question — how do I prove that code I don't control did exactly what it was supposed to do? — and ended up as a runtime where security isn't a feature: it's the protocol. Narrow capabilities, signed receipts, two phases, and hard limits: each piece exists so that one thing is true: **nothing happens in aegis without leaving a signed proof**.