# Mecha: the architectures behind the invariants

`README.md` states what makes a system a mecha — nine invariants a candidate
either satisfies or does not. This is how three generations satisfied them,
what each one cost, and where the design is going. `CONTRIBUTING.md` is the
working guide; `docs/` holds the arguments for individual decisions.

Multiple implementations are legitimate on purpose. v1, v2 and v3 differ in
almost every component and agree on every invariant, which is the claim the
invariants exist to make: they are the architecture, and the stack under them
is a choice.

## Mecha v1

The original implementation, deployed to Cloud Run with Neon (managed PostgreSQL).

```
Frontend → nginx/OpenResty → PostgREST → PostgreSQL
                                              │ WAL
                                          Boxer (Rust CDC)
                                              │
                                          pgstream → Redis Streams → Dapr → Arroyo
                                              │
                                          nginx SSE handler (Lua)
```

| Role | Component | Notes |
|------|-----------|-------|
| Reverse proxy | nginx + OpenResty | Lua scripts for webhook/SSE handlers |
| CDC | Boxer (custom Rust) | Custom WAL parser, maintenance burden per PG version |
| Message buffer | Redis Streams | Absorbs backpressure, XREADGROUP consumer groups |
| Service mesh | Dapr | Retry, circuit breaker, pubsub abstraction |
| SSE | nginx sse_handler.lua | Custom Lua with Last-Event-ID replay |
| Stream processing | Arroyo | SQL windowed aggregation, SSE source |
| Real-time sync | pgstream SSE | Fire-and-forget (no at-least-once) |
| Heartbeat | nginx periodic publish | Advances Arroyo watermarks during activity |

**Limitations that motivated v2:**
- Boxer requires maintenance per PostgreSQL major version (custom WAL parser)
- nginx Lua scripts are brittle, hard to test, opaque to observability
- pgstream advances LSN regardless of delivery success (not at-least-once)
- No Windows support (nginx, Boxer)
- SSE handler requires custom Last-Event-ID state management
- Redis Streams as event buffer adds operational complexity

**Cloud mapping (v1):**
PostgreSQL → Neon, Redis → ElastiCache, Arroyo → Arroyo Cloud, nginx → Cloud Run, Dapr → Azure Container Apps.

## Mecha v2

Current implementation. Replaces all custom code (Boxer, Lua scripts, pgstream) with off-the-shelf declarative components. The architecture has two variants: a dev stack for local development and a production stack for cloud deployment.

### Dev architecture (Docker Compose)

```
Frontend → Caddy → PostgREST → PostgreSQL
                                     │ WAL (logical replication)
                                 Conduit (declarative YAML pipelines)
                                     │
                                 Dapr pubsub → Redis Streams
                                     │
                                 rpk (bloblang DSL)
                                  ┌──┴──┐
                            PATCH │     │ Kafka produce
                          PostgREST   Redpanda → Arroyo
                                              │
                                        webhook → PostgREST

                   ElectricSQL ← PostgreSQL (shape streams)
```

### Production architecture (Cloud Run)

In production, Redis Streams is replaced by the cloud provider's native pubsub service. The proven GCP deployment uses:

```
Frontend → Caddy → PostgREST → PostgreSQL (Neon)
                                     │ WAL (logical replication)
                                 Conduit (sidecar)
                                     │
                                 Dapr pubsub → GCP Pub/Sub
                                     │
                                 rpk (sidecar, pulls from Pub/Sub subscription)
                                  ┌──┴──┐
                            PATCH │     │ Kafka produce
                          PostgREST   Managed Kafka → Arroyo
                                              │
                                        webhook → PostgREST

                   ElectricSQL ← PostgreSQL (shape streams)
```

The key difference: Dapr publishes to a cloud-native topic instead of Redis Streams, and rpk pulls from a cloud-native subscription instead of a Redis consumer group. The bloblang transform pipelines are identical between dev and prod.

### Sidecar bundling for scale-to-zero

In production on Cloud Run, Conduit, rpk (transform), and Dapr are bundled as sidecars of a single multi-container service. This ties their lifetimes together: the whole pipeline wakes on the first user request and scales to zero as a unit.

The key insight: CDC consumers (Conduit WAL reader) and stream consumers (rpk Pub/Sub pull) need continuous CPU, but by bundling them with the ingress container (Dapr), they get CPU only while the pod is alive. One public-facing ingress container (Dapr) receives the first request, which wakes all sidecars. When traffic stops, the entire unit scales to zero — no orphaned CDC readers burning CPU on an idle database.

Nothing in the user's request path talks to Dapr, so that first request has to come from somewhere. It is the ticker's (`services/ticker`): a clock inside the unit cannot wake the unit, which is why a periodic wake is a component and not a pipeline input.

```
Cloud Run multi-container service
┌─────────────────────────────────────────────┐
│  Dapr (ingress, public)                     │
│  Conduit (sidecar, CDC from Neon WAL)       │
│  rpk transform (sidecar, Pub/Sub consumer)  │
│                                             │
│  Lifecycle: wake together, sleep together   │
└─────────────────────────────────────────────┘
```

### Components (v2)

| Role | Component | DSL/Config | Dev | Prod (GCP) |
|------|-----------|-----------|-----|-------------|
| Reverse proxy | Caddy | Caddyfile | same | same |
| CDC | Conduit v0.14.0 | YAML pipeline definitions | container | sidecar |
| Message bus | Redis Streams / GCP Pub/Sub | redis.conf / topic+subscription | Redis Streams | GCP Pub/Sub |
| Kafka broker | Redpanda | --mode=dev-container | container | Managed Kafka / Confluent / MSK |
| Service mesh | Dapr | YAML component definitions | container | ingress sidecar |
| Transform | rpk Connect (Benthos) | YAML + bloblang DSL | container | sidecar |
| Stream processing | Arroyo | SQL (CREATE TABLE + INSERT INTO SELECT) | same | same |
| Real-time sync | ElectricSQL | HTTP shape stream API | same | Cloud Run |
| Object storage | rclone-s3 | rclone.conf | local filesystem | GCS |
| Image processing | imgproxy | URL-based transforms | same | Cloud Run |
| Periodic wake | ticker (`services/ticker`) | Five-field cron in the `schedule` table | same | same |

### Key design decisions (v2)

**Conduit over Boxer**: Declarative YAML pipelines replace custom Rust. No code to maintain per PostgreSQL version. Connectors are plugins.

**Caddy over nginx**: Native Windows support. Automatic HTTPS. Caddyfile is simpler than nginx.conf + Lua. No custom scripting.

**Redis Streams (dev) + cloud pubsub (prod)**: Redis Streams for durable CDC delivery in local development. Redis is already required by the stream profile (Arroyo), so reusing it for cdc eliminates an extra service (NATS). In production, the cloud provider's native pubsub (GCP Pub/Sub, Amazon SNS+SQS, Azure Service Bus) replaces Redis Streams — same Dapr pubsub abstraction, zero code changes. Kafka protocol (via Redpanda) for Arroyo source, giving true end-to-end at-least-once and uniform protocol for dev/prod.

**rpk bloblang over Lua scripts**: Declarative transform DSL. Fan-out via broker/switch output. Heartbeat via generate input — co-located with processing, scales to zero with it.

**ElectricSQL over pgstream SSE**: Purpose-built for frontend sync. Shape streams with offset-based resumption. No custom SSE handler.

**Three-way routing in rpk**: Heartbeats → Kafka only. Already-enriched records → Kafka only (breaks CDC amplification loop). New records → PATCH enrichment + Kafka.

**rclone-s3 over Garage**: rclone fronts any storage backend with an S3-compatible API. In dev, it uses the local filesystem. In prod, it uses GCS (or S3, or Azure Blob). Simpler and more portable than running a distributed object store like Garage for dev purposes.

**Sink idempotency by default**: UNIQUE constraint on request ID + PostgREST `Prefer: resolution=ignore-duplicates`. Duplicate CDC events are absorbed at the database level, making at-least-once delivery safe without application-level deduplication.

### Delivery guarantees (v2)

The delivery pipeline has three layers of retry before a message is considered undeliverable:

```
User INSERT → PostgREST → PostgreSQL
                               │
                          WAL entry created (durable)
                               │
                          Conduit reads WAL (logical replication)
                               │
                          Dapr pubsub (retry + circuit breaker)
                               │
                      ┌── Dev: Redis Streams (durable, consumer groups)
                      │
                      └── Prod: GCP Pub/Sub (topic + subscription)
                               │
                          rpk consumes (ack after downstream success)
                               │
                    ┌──────────┼──────────┐
                    ▼                     ▼
              PATCH PostgREST       Kafka produce
              (enrichment)          (Arroyo source)
                    │                     │
              ack to bus            Arroyo processes
                    │                     │
              UNIQUE constraint     webhook POST
              absorbs duplicates    (aggregated result)
                    │
              ✓ idempotent sink
```

**Three-layer retry strategy:**

| Layer | Mechanism | Configuration | Scope |
|-------|-----------|---------------|-------|
| **Layer 1: Transform retry** | rpk/Benthos `retry` block with exponential backoff | 2s initial, 30s max, 3 retries, 3m total timeout | Transient HTTP failures (PostgREST down, network blip) |
| **Layer 2: Bus redelivery** | Redis `maxRetries` / Pub/Sub `retryPolicy` | Configurable per component | Consumer crashes, unacked messages |
| **Layer 3: Dead-letter** | Redis dead-letter stream / Pub/Sub dead-letter topic | After Layer 2 exhaustion | Poison messages, persistent failures |

At every boundary, the upstream waits for downstream acknowledgment before advancing. WAL position advances only after Conduit delivers. The bus acks only after rpk succeeds. Kafka acks only after Arroyo commits the offset. This chain provides end-to-end at-least-once delivery with idempotent sinks absorbing duplicates.

**Dead-letter queues** are configured by default in both dev and prod. Messages that exhaust all retry layers land in a DLQ for manual inspection and replay. This is an infrastructure default, not an opt-in feature.

### Profiles (v2)

| Profile | Services | Cloud equivalent |
|---------|----------|-----------------|
| **crud** | PostgreSQL + PostgREST + Caddy + Dapr | Neon + Cloud Run |
| **sync** | + ElectricSQL | + Electric Cloud |
| **cdc** | + Conduit + Redis Streams + rpk | + GCP Pub/Sub + Cloud Run sidecars |
| **stream** | + Arroyo + Redpanda + Redis | + Arroyo Cloud + Managed Kafka + ElastiCache |
| **blobs** | + rclone-s3 + imgproxy | + GCS/S3 + imgproxy Cloud |

### Cloud mapping (v2)

| Component | Local | AWS | Azure | GCP |
|-----------|-------|-----|-------|-----|
| PostgreSQL | postgres:18 | RDS / Aurora / Neon | Azure DB / Neon | Cloud SQL / AlloyDB / Neon |
| Message broker | Redis Streams | SNS + SQS | Service Bus | Pub/Sub |
| Kafka broker | Redpanda | MSK / Confluent | Event Hubs | Managed Kafka |
| Object storage | rclone-s3 (local fs) | S3 (native) | Blob Storage via rclone-s3 | GCS via rclone-s3 |
| Redis | redis:7.4 | ElastiCache | Cache for Redis | Memorystore |
| Stream processing | Arroyo | Managed Flink | Stream Analytics | Dataflow |
| CDC | Conduit | DMS / Debezium on MSK | Event Hubs Capture | Datastream |

The Kafka ecosystem (Debezium + Redpanda/MSK + Flink) is a valid cloud-scale substitution for the entire cdc+stream tier. The architecture is the same; only the component names change.

## Production Deployment

Concrete deployment proposals for the three major clouds. GCP is proven with iris-mecha v2; AWS and Azure are proposed mappings that preserve the same architecture.

### GCP (proven with iris)

| Role | Service |
|------|---------|
| Compute | Cloud Run multi-container (Dapr ingress + Conduit + rpk transform as sidecars) |
| Database | Neon (managed PostgreSQL with logical replication) |
| Message bus | GCP Pub/Sub (topics + subscriptions with retryPolicy + dead-letter topic) |
| Real-time sync | ElectricSQL on Cloud Run |
| Object storage | GCS via rclone-s3 on Cloud Run |
| Image processing | imgproxy on Cloud Run |
| Infrastructure as Code | Crossplane GCP providers |

### AWS (proposed)

| Role | Service |
|------|---------|
| Compute | ECS Fargate or App Runner (sidecar pattern) |
| Database | RDS PostgreSQL or Neon |
| Message bus | Amazon SNS + SQS (fan-out + dead-letter queue) |
| Real-time sync | ElectricSQL on ECS |
| Object storage | S3 (native, no rclone needed) |
| Image processing | imgproxy on ECS or Lambda |
| Infrastructure as Code | Crossplane AWS providers or CDK |

### Azure (proposed)

| Role | Service |
|------|---------|
| Compute | Azure Container Apps (built-in Dapr integration) |
| Database | Azure Database for PostgreSQL Flexible Server or Neon |
| Message bus | Azure Service Bus (topics + subscriptions + dead-letter queue) |
| Real-time sync | ElectricSQL on Container Apps |
| Object storage | Azure Blob Storage via rclone-s3 |
| Image processing | imgproxy on Container Apps |
| Infrastructure as Code | Crossplane Azure providers |

### Sidecar bundling pattern (all clouds)

Regardless of cloud provider, the deployment pattern is the same: bundle the CDC reader (Conduit), transform pipeline (rpk), and service mesh (Dapr) as sidecars of a single compute unit. This ensures:

1. **Scale-to-zero as a unit** — no orphaned CDC readers or idle stream consumers
2. **Shared lifecycle** — all components wake on the first request and sleep together
3. **Simplified networking** — sidecars communicate over localhost, no service discovery needed
4. **Cost efficiency** — CPU is allocated only while the pod is alive and serving traffic

## Mecha v3 (Proposed)

Three possible directions, each preserving the invariants:

### v3a: MQTT-native

Replace Redis Streams with MQTT everywhere. Simplifies the stack to a single message protocol.

```
Conduit → Dapr MQTT pubsub → Mosquitto → rpk + Arroyo
```

- Fewer moving parts (no Redis for messaging)
- Better cloud mapping (AWS IoT Core, Azure Event Grid)
- MQTT v5 shared subscriptions for horizontal scaling
- Dapr bridges CDC to MQTT, preserving trace context

### v3b: Edge-native (Turso/libSQL)

Replace PostgreSQL with Turso (managed libSQL/SQLite) for edge deployments.

```
Frontend → Turso embedded replica (local SQLite)
              │ sync
          Turso primary (managed)
              │ change stream
          rpk → MQTT → Arroyo
```

- SQLite runs everywhere (browser, mobile, edge, embedded)
- Turso provides managed replication and CDC-like change streams
- ElectricSQL alternative: **PowerSync** (designed for SQLite sync)
- Trade-off: loses PostgreSQL extensions (pgvector, pg_cron, PostgREST)

### v3c: Browser mecha

The full stack runs in the browser via JavaScript and WebAssembly.

```
Browser:
  PGlite (WASM PostgreSQL) → local storage
  Service Worker → offline queue + retry (mesh role)
  Electric protocol shim → sync to server
  WASM transform → client-side enrichment
```

- Best-effort eventual consistency (no durable broker in browser)
- Service Worker acts as the "Dapr" — retry queue, offline buffering
- PGlite provides full SQL locally
- Sync to server when online via Electric protocol
- All processing in JS/WASM — zero server dependency for reads

**The browser mecha degrades gracefully**: online → full consistency via server sync. Offline → local PGlite with queued writes. Reconnect → eventual consistency via conflict resolution.

## The Spectrum

Mecha implementations form a spectrum from fully embedded to fully distributed:

```
Browser ──── CLI ──── Container ──── Cloud ──── Edge
  │            │          │            │          │
PGlite     native     Docker       managed    Turso
  │        binaries   Compose     services   embedded
  │            │          │            │      replica
best-effort  full      full        full     eventual
eventual   consistent consistent consistent consistent
```

The invariants hold across the spectrum. What changes is the consistency model (best-effort at the edges, full in the middle) and the component implementations (WASM vs containers vs managed services).

## Schema-Driven Generation

The generation pipeline is the same across all versions:

```
Protocol Buffers → buf generate → JSON Schema
                                      │
                                  CUE + gomplate
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                  ▼
              Atlas HCL         Caddyfile          Arroyo SQL
           (DB migrations)    (proxy routes)    (stream queries)
```

One schema change propagates to all layers. No manual synchronization between database, API, CDC pipeline, and stream processing.

## Production Lessons

These lessons were learned deploying mecha v1 and v2 on Cloud Run with Neon:

### v1 lessons

1. **Scale-to-zero creates cold-start races** — Dapr takes ~5s to initialize while CDC events arrive in ~3s. Redis Streams absorbs the gap.
2. **Heartbeats must be co-located with activity** — a standalone heartbeat container scales to zero and never wakes. Embed heartbeats in the transform pipeline (rpk generate input).
3. **CDC amplification loops** — enrichment PATCHes trigger UPDATE CDC events. Break the loop by checking if a record is already enriched before re-PATCHing.
4. **Table name case sensitivity** — PostgREST preserves the original table name case. `GroupHello` is not `grouphello`. Webhook sinks must match exactly.
5. **WAL slot position after recreation** — after `docker compose down -v`, the replication slot's confirmed_flush_lsn can be ahead of the current WAL. Always do a full clean restart.
6. **Dapr CloudEvent format** — Conduit sends the row payload as a JSON string in the CloudEvent `data` field. Not an OpenCDC record with operation/metadata. Parse accordingly.

### v2 lessons (GCP Cloud Run + Neon)

7. **Dapr publish URL path segment = cloud pubsub topic name** — when Dapr publishes to GCP Pub/Sub, the topic in the URL path (`/v1.0/publish/pubsub/my-topic`) must exactly match the Pub/Sub topic name. No implicit mapping or renaming.
8. **Neon replication slot zombies on scale-to-zero** — when Cloud Run scales to zero, Conduit disconnects without cleaning up its replication slot on Neon. On next wake, slot creation fails because the old slot still exists. Solution: a startup cleanup script that drops stale replication slots before Conduit starts.
9. **Cloud Run multi-container: `latest` tag doesn't force re-pull** — Cloud Run caches container images aggressively. Using the `latest` tag does not guarantee the newest image is pulled on deploy. Solution: pin container images by digest (sha256) in the Cloud Run service definition.
10. **ElectricSQL needs public invoker IAM binding for browser access** — ElectricSQL shape streams must be accessible from browser clients. On Cloud Run, this requires a `roles/run.invoker` IAM binding for `allUsers` on the ElectricSQL service, since browsers cannot attach service account credentials.
11. **Conduit HTTP connector sends flat row JSON, Dapr wraps as CloudEvents with `datacontenttype: text/plain`** — Conduit's HTTP destination sends the CDC payload as a flat JSON body. When Dapr receives this and republishes to Pub/Sub, it wraps it as a CloudEvent with `datacontenttype: text/plain` (not `application/json`). Downstream consumers (rpk) must parse the `data` field as a JSON string, not assume structured JSON.
12. **Wake-on-request: one public ingress container wakes all sidecars** — in the multi-container sidecar model, only the Dapr ingress container needs to be public. The first HTTP request to Dapr wakes the entire service unit, including Conduit (CDC) and rpk (transform) sidecars. No separate wake mechanism needed.
