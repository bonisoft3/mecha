# Mecha

Mecha is a **schema-driven backend meta-architecture** that generates a complete CRUD + CDC + real-time sync stack from entity definitions. Given a schema, mecha derives everything: database tables, REST API, change data capture pipeline, real-time sync, stream processing, and object storage bindings.

Multiple implementations (v1, v2, v3) are legitimate. What makes them all "mecha" is adherence to a set of architectural invariants.

## Invariants

A system is a mecha if and only if it satisfies these properties:

### 1. Schema is the source of truth

A single declarative schema (Protocol Buffers, SQL DDL, CUE) generates all artifacts. No hand-written boilerplate for CRUD operations, database migrations, or API routes. The schema defines entities; the architecture derives behavior.

### 2. Three-path data flow

Every mecha has exactly three data paths:

```
                    ┌─── Sync path ──── real-time frontend updates
                    │
  User action ──────┼─── CRUD path ──── synchronous read/write
                    │
                    └─── CDC path  ──── asynchronous side effects
```

- **CRUD path**: Direct, synchronous reads and writes. The user gets an immediate response.
- **CDC path**: Change data capture drives asynchronous processing. Enrichment, analytics, notifications. At-least-once delivery guarantees.
- **Sync path**: Real-time state synchronization to frontends. No polling. The frontend reflects database state continuously.

### 3. At-least-once end-to-end with sink idempotency

One user interaction produces either an **immediately consistent** or **eventually consistent** outcome. Never fire-and-forget. Every write that enters the CRUD path will eventually be captured by CDC and processed by all downstream consumers. The only acceptable failure mode is re-delivery (at-least-once), not message loss.

**Idempotency at the sink is a default infrastructure concern**, not application logic. The implementation: every entity table has a UNIQUE constraint on its request ID column. PostgREST sinks use `Prefer: resolution=ignore-duplicates` to absorb duplicate CDC events at the database level. This makes at-least-once delivery safe by default — duplicate events from retries, redeliveries, or bus rebalancing are silently absorbed. This applies in both dev and production environments.

### 4. Vertical scalability (down and up)

The same architecture must run at every scale:

| Scale | Environment | Consistency model |
|-------|------------|-------------------|
| **Browser** | PGlite + Service Worker + WASM | Best-effort eventual |
| **CLI** | Native binaries, no containers | Full consistency |
| **Single machine** | Docker Compose | Full consistency |
| **Cloud** | Managed services per component | Full consistency |
| **Edge** | Embedded/SQLite-based | Eventual consistency |

Downscaling to zero is a first-class property. When no users are present, stateless components sleep. When a request arrives, the mesh (Dapr or equivalent) wakes dependent services. Upscaling replaces each component with its managed cloud equivalent without architectural changes.

### 5. Stateless processing, stateful storage

Processing components (reverse proxy, CDC reader, transform pipeline, stream processor, API gateway) are **stateless**. They can crash, restart, and scale horizontally without coordination. All durable state lives in purpose-built stores (relational database, message broker, object storage) that have managed cloud equivalents on every major cloud.

### 6. Declarative over imperative

Configuration lives in YAML, CUE, SQL, or Protocol Buffers. Not in application code. DSLs reduce bugs, enable generation, and make the system auditable. When choosing between a custom service and a declarative pipeline definition, choose the pipeline.

### 7. Additive profiles

Capabilities are layered incrementally. The base profile is always CRUD. Each subsequent profile adds services without modifying existing ones:

```
crud → sync → cdc → stream → ai → blobs
```

A team that only needs CRUD runs 4 containers. A team that needs real-time AI runs 12+. Same architecture, same schema, different profiles.

### 8. Portable cloud mapping

Every stateful component maps to at least one managed service on each major cloud provider. The local development stack uses lightweight, open-source equivalents. No vendor lock-in at the architecture level.

### 9. CDC over event sourcing

Mecha uses **change data capture** (reading the database WAL), not event sourcing (storing events as the primary model). This preserves the relational model — tables, rows, SQL — which enables:
- PostgREST to auto-generate REST APIs from table definitions
- ElectricSQL to sync table shapes to frontends
- Standard SQL tooling for migrations, queries, and analytics

Event sourcing requires custom projection logic and breaks the "schema generates everything" invariant. CDC captures the same events without changing the data model.

## The spectrum, and where to read on

The invariants admit a range of stacks rather than one. Three generations have
satisfied them — a Kotlin/Micronaut service, a Docker-Compose-and-Cloud-Run
pipeline, and a set of proposed edge and browser targets — and what each one
costs is `DESIGN.md`.

| You want | Read |
|---|---|
| Why a system is or is not a mecha | the invariants above |
| How v1, v2 and v3 satisfy them, and the cloud mappings | [DESIGN.md](DESIGN.md) |
| Running the stack, generating from schema, fixing a broken pipeline | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Schema evolution, the access layer, the connection ceiling | [`docs/`](docs/) |

## Local Development

```bash
# Install tools
mise install

# Generate all artifacts from protobuf
task generate

# Start crud profile
docker compose up --build --watch

# Start with profiles (additive)
docker compose --profile sync up --build --watch
docker compose --profile sync --profile cdc up --build --watch
docker compose --profile sync --profile cdc --profile stream up --build --watch

# Run smoke tests
task integrate                 # CRUD smoke test
task integrate:cdc             # CDC pipeline E2E
task integrate:stream          # Stream analytics E2E

# Full cleanup
docker compose --profile sync --profile cdc --profile stream --profile blobs down -v
```

## License

LGPL-3.0
