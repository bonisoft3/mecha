---
type: decision
title: One compute core
description: Runs a computation's capture, step loop, publication and digest from one sans-IO core on the server, on Cloudflare and in the browser, each host supplying only its DuckDB connection, its storage and its transport.
status: built
---

# One compute core

**Status: built 22 November 2026.** The contract is
[[../compute#One compute core|compute's]].

## The problem

[[../../../../plugins/pronto/docs/decisions/2026-10-20-duckstream-backend-contract|The backend contract]]
holds every DuckDB-evaluated computation to one semantics, wherever it runs.
The code that evaluates it is written three times:

| Host | Code | DuckDB |
| --- | --- | --- |
| server compute container | `services/compute/bounded-runtime.ts` | `@duckdb/node-api`, files on disk |
| Cloudflare | `packages/mecha-edge/src/paged-*.ts`, `compute-*.ts`, `snapshot-*.ts` | workerd DuckDB in Durable Objects |
| pages | `packages/mecha-browser/compute.ts` | `duckdb-wasm` in a worker |

They share the portable types (`portable-contract.ts`), the snapshot statements
(`snapshot-data.ts`), the WASM runner (`wasi.ts`), the static cage, output
selection (`wasm-select.ts`) and the limits (`compute-snapshot/src/bounded.ts`).
Each implements its own capture, query paging, step loop, publication paging and
digest, and there are two `strictJson`s (`services/compute/workers.ts`, which
checks a value before `toJSON` and can sort keys, and
`compute-snapshot/src/json.ts`, which checks after).

Copies drift. The server's capture paged with `OFFSET` and sorted every row's
hash in the JS heap until golaberto's archive exhausted its memory; the edge
and the browser never had that bug, and its fix (#2457) changed the server's
copy alone. A conformance test can catch a divergence after it ships; one core
cannot diverge.

## Decision

**The computation's logic lives once, in `packages/compute-snapshot`, as a
sans-IO core; each host supplies three things.**

- **A DuckDB connection** behind the interface the edge's `PagedExecution`
  already takes (`ExecutionDatabase`, `ExecutionConnection`), made asynchronous
  so node-api and duckdb-wasm fit it as well as workerd does.
- **Storage** for a capture and an output: files on the server, Durable Object
  SQLite on Cloudflare, the worker's memory in a tab.
- **Transport** for a step: a direct call on the server and in the tab, the
  Durable Objects' HTTP exchanges on Cloudflare.

The core owns what the contract fixes: the capture (a relation paged by
position, each row stored as its canonical text), the digest (the sorted row
hashes, sorted by DuckDB), the plan loop (checkpoint, scratch commits, the WASM
jobs a step asks for, every limit in `bounded.ts`), output paging and
publication pages, and one `strictJson`. A host keeps only its own lifecycle:
retention and release of files or objects, the process or Durable Object that
cages a step, and PGlite where the database is PGlite.

### Stages

1. **One `strictJson`**, the server's semantics, in `compute-snapshot`; both
   callers import it.
2. **The step loop.** The edge's `PagedExecution` becomes the core's, on the
   asynchronous connection; `BoundedRuntime.calculate` runs it over node-api.
3. **Capture and digest.** `BoundedRuntime.capture` and the edge's snapshot
   capture become one paged capture; the digest is computed once.
4. **Publication paging**, the last copy on each host.
5. **The browser** runs the core over duckdb-wasm.

Each stage keeps the hosts' existing tests green and adds one conformance test
that runs a computation through every host's adapter and compares outputs and
digests.

## Alternatives

- **Three implementations held together by conformance tests.** Catches a
  divergence only for the inputs a test chose, after the code diverged.
- **The server's code everywhere.** node-api is native, and workerd and the
  browser cannot load it; the files it keeps are not a Durable Object's storage.
- **The edge's code as is.** Its connection is synchronous, which neither
  node-api nor duckdb-wasm offers; the interface, not the code, is what carries
  over.
- **One WASM build of the core for every host.** DuckDB is already a different
  build per host, so a WASM core would still sit on three DuckDBs, at the cost
  of a second heap per call.

## Open questions

- Whether the edge's byte budgets per Durable Object exchange are the core's
  limits for every host, or a transport's.
- Where a capture's retention policy belongs: the core decides when a capture
  is released, a host how.
- Whether Cloudflare's storage limits make compressing captures worth it there
  (the server's job cache already compresses with Zstd; DuckDB files compress
  their columns natively).
