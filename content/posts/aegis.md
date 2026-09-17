---
title: Ejecutar WebAssembly no confiable requiere más que un sandbox — aegis, ejecución segura con capabilities, receipts y dos fases
slug: aegis
project: aegis
status: published
date: 2026-09-16T00:00:00.000Z
lang: es
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
translationOf: aegis-en
cover: ''
---

Cuando empecé aegis, el problema era concreto: ejecutar código que no controlo requiere que cada acceso a un recurso esté controlado y que cada efecto secundario sea demostrable. Un sandbox por sí solo no alcanza — el sandbox te protege de lo que el guest no debería poder hacer, pero no te dice qué hizo.

> **Estado actual: Fase 9 (two-phase receipts) implementada** — `cargo test` verde (160 tests), `cargo clippy --all-targets -- -D warnings` limpio, `cargo fmt --check` limpio. Runtime con **capability-based host functions**, **receipts Ed25519 + BLAKE3 hash-chained**, **ejecución en dos fases (prepare/commit/abort)**, **fuel metering**, y **gRPC con mTLS obligatorio**. CI verde en GitHub.

1. **¿Cómo garantizás que el guest solo toque lo que se le autorizó?** Si el modelo es "el código corre en un sandbox", un syscall de más se convierte en un dilema de auditoría: ¿quién autorizó ese archivo?
2. **¿Cómo probás qué se ejecutó y qué costó?** "El WASM corrió bien" no es evidencia. Necesitás un recibo firmado que demuestre qué ejecutó, con qué resultado y a qué costo — verificable sin conexión al runtime.
3. **¿Cómo separás la intención del resultado?** Una ejecución que falla a mitad de camino deja al sistema ambivalente: ¿se intentó, se completó, o algo de eso? La ejecución en dos fases convierte la ambigüedad en un protocolo.

La tentación era la clásica: "corro el guest en Wasmtime y listo". Eso te da aislamiento de memoria, pero no te da una política. La respuesta fue combinar **host functions por capability** (deny by default, cada capacidad declara su alcance exacto), **receipts firmados con hash-chaining por ejecución**, **ejecución en dos fases** (un recibo de `prepare` antes de correr, un recibo de `commit` o `abort` después), **límites duros** (memoria, fuel, epoch interruption) y **mTLS obligatorio** en el borde gRPC — todo en un solo binario Rust sobre Wasmtime.

## El problema de confiar en "el sandbox me protege"

Ejecutar WebAssembly no confiable tiene dos caras. La primera es técnica: el guest no debe poder leer archivos arbitrarios, hacer llamadas HTTP a cualquier host ni agotar la CPU del proceso host. Un sandbox resuelve eso. La segunda es de diseño: cuando el guest pide acceso, ¿quién decide qué puede tocar y cómo se demuestra después? Si la respuesta es "el guest pide todo lo de WASI y el host confía", no tenés un modelo de seguridad: tenés una fea costumbre.

El error clásico no es un ataque sofisticado: es una capability ancha. Darle al guest `filesystem` completo porque "el código es confiable" es el equivalente de un `WHERE tenant_id = ?` olvidado — no es un bug, es una brecha en potencia. La solución correcta empieza al revés: el guest no tiene **nada** hasta que la política declare lo contrario.

## Decisiones de diseño clave

### 1. Host functions por capability, no WASI

WASI da acceso amplio y genérico. aegis no expone WASI: cada guest recibe **exactamente** las capacidades declaradas en su `PolicyConfig` — `filesystem.read`, `filesystem.write`, `network.http` — y nada más. Cada capacidad además viene acotada:

- `filesystem.read` con un `allowed_root`: el guest solo lee bajo ese directorio.
- `network.http` con allowlists de host y método: el guest solo llama adonde la política permite.

Es deny by default: un guest sin configuración no puede tocar archivos ni red. No hay modo "todo abierto".

### 2. Receipts firmados y encadenados por hash

Cada ejecución produce un recibo firmado con **Ed25519** y hasheado con **BLAKE3**, encadenado a los anteriores. El recibo demuestra *qué se ejecutó, con qué resultado y a qué costo*. La cadena corre dentro del runtime vía `ReceiptEmitter`, y se puede verificar **offline** con `aegis-verify <chain.json> <public_key_b64>` — sin volver a contactar al servidor.

Esto es lo que separa "el WASM corrió" de "podemos probarlo": si un cliente pregunta por la ejecución del día anterior, la cadena de receipts es la prueba, no la palabra del runtime.

### 3. Ejecución en dos fases: la intención también se firma

`ExecutePrepare` / `ExecuteCommit` / `ExecuteAbort` forman el protocolo de dos fases:

1. `ExecutePrepare` produce un recibo de `prepare` firmado **antes** de que corra cualquier WASM — la intención queda registrada.
2. `ExecuteCommit` (o `ExecuteAbort`) produce el recibo final **después** de la ejecución — el resultado queda registrado.

Intención y resultado son ambos demostrables. Un fallo a mitad de camino deja un rastro consistente: hay un `prepare` firmado y un `abort` firmado, y no hay ambigüedad sobre qué pasó. Es el mismo espíritu que dos fases en sistemas distribuidos, aplicado a la evidencia de ejecución.

### 4. Límites duros: memoria, instancias y CPU

El sandbox de Wasmtime viene acotado desde la base: **1 MiB de memoria**, 1024 elementos de tabla, **4 instancias** y 2 memorias por store como tope. El presupuesto de CPU tiene dos mecanismos:

- **Epoch interruption**: el límite wall-clock que corta la ejecución aunque el guest se meta en un loop sin salida.
- **Fuel metering**: contabilidad determinista de CPU por ejecución; agotar el fuel produce "fuel budget exceeded".

Son complementarios: el epoch corta, el fuel cuenta. Y `fuel_budget` y `max_concurrent` son configurables por TOML, declarativamente.

### 5. mTLS obligatorio en el borde gRPC

El server gRPC exige que el cliente presente un certificado firmado por una CA configurada, con `CN`/`SAN` coincidiendo con la identidad esperada. **No existe modo sin TLS** — no hay flag que lo desactive. Si el certificado no matchea, la conexión no se establece, y punto.

### 6. Verificación offline, arquitectura declarativa

El runtime es declarativo: una configuración TOML declara server, identidad TLS, la clave de firma, defaults de política y los knobs de ejecución. Los dos binarios que produce el crate:

| Binario | Propósito |
|---------|-----------|
| `aegis-runtime` | Server gRPC con mTLS, receipts y sandbox |
| `aegis-verify` | Verificador offline de cadenas de receipts |

## El test flaky que era un bug de producción

Lo más interesante de aegis no apareció en un diseño: apareció en el CI. Los tests E2E de red fallaban "de vez en cuando", con un patrón inconfundible: `13 passed; 1 failed`. Los sospechosos clásicos eran los puertos fijos (`50071`, `50072`, y una serie en `50051-50063`) más un `sleep(100ms)` a ciegas antes de conectar. Esa combinación producía un fallo determinista bajo binarios de test paralelos: el bind fallaba en silencio, el cliente conectaba al server de **otra instancia** del test, y el certificado firmado por otra CA explotaba con `BadSignature` — 8 de 8 instancias fallaban así.

El fix fue de harness: puertos efímeros (`bind(127.0.0.1:0)` → leer el puerto real) y **readiness probe** (reintento de conexión TCP hasta ~5s) en lugar de dormir a ciegas. Resultado: `BadSignature` eliminado, 0 en más de 40 instancias paralelas.

Pero seguía un fallo residual, 2 de 6 corridas del suite completo: `network timeout exceeded` en un test de fetch exitoso. Ahí estaba el bug real, y no estaba en los tests: el handler gRPC ejecutaba el WASM **sincrónicamente en un worker del runtime async**, y el guest hace fetches HTTP bloqueantes (ureq) dentro de host functions. Bajo carga, los workers del runtime quedaban todos bloqueados en fetches concurrentes, la tarea async del stub TLS no podía correr, y el timeout wall-clock de 5 segundos disparaba antes de que el handshake terminara. La solución fue `block_in_place` alrededor de la ejecución WASM (con guard por runtime, porque los tests que corren en `current_thread` no pueden usarlo) — el patrón correcto de producción: el I/O bloqueante nunca debe ocupar un worker async.

La moraleja es la de siempre: un test flaky casi nunca es el test. Es un bug de producción que te está avisando que tenés barro en el sótano. El `BadSignature` era el humo; el `ureq` bloqueando el runtime async era el incendio.

## Qué gana uno con este enfoque

- **Política explícita**: cada guest declara qué puede tocar; el runtime no adivina ni se relaja.
- **Evidencia verificable**: los receipts firmados y encadenados convierten la ejecución en un hecho demostrable, no en una promesa.
- **Protocolo en vez de ambigüedad**: dos fases significa que la intención y el resultado son ambos auditables.
- **Límites duros desde la base**: memoria, instancias, fuel y epoch no son configurables "por si acaso", son el default.
- **mTLS sin modo inseguro**: no existe el botón "andá sin TLS por ahora".

## Lo que conscientemente dejé fuera

- **WASI**: no lo exponemos. Las capabilities de aegis son más estrechas y más auditables; si un día se necesita WASI real, será otra capability explícita, nunca el default.
- **Plugins distribuidos**: el runtime está pensado como servicio — los receipts lo hacen verificable sin ser un sistema de ejecución distribuida.
- **Hot reload de políticas**: hoy la política se declara por request; un sistema de admisión de políticas en caliente puede ser una fase futura, pero no entraba en el alcance del MVP.

## Conclusión

aegis empezó con una pregunta incómoda — ¿cómo pruebo que el código que no controlo hizo exactamente lo que se supone que hizo? — y terminó siendo un runtime donde la seguridad no es una feature: es el protocolo. Capabilities estrechas, receipts firmados, dos fases y límites duros: cada pieza existe para que una sola cosa sea cierta: en aegis, **nada pasa sin dejar una prueba firmada**.