# Contributing to mecha

For running the stack and changing what it generates. `README.md` states the
invariants a mecha satisfies, `DESIGN.md` is how each generation satisfies
them, and `docs/` holds the arguments behind individual decisions.

Two things are worth knowing before the commands make sense. **Everything is
derived from schema** — entities are Protocol Buffers, artifacts are generated,
and hand-editing a generated file is work the next `generate` discards. And
**profiles are additive**: a stack is the union of the profiles you asked for,
so `crud` alone is a complete system and each further profile adds a path
rather than replacing one.

## Development Commands

Install tools: `mise install`

### Schema-Driven Generation

```bash
# Generate all artifacts from protobuf schemas
task generate

# Individual steps
task buf:generate      # Proto → JSON Schema
task cue:generate      # JSON Schema → Atlas HCL (via CUE + gomplate)
task atlas:hash        # Regenerate atlas.sum after migration changes
```

### Running the Stack

```bash
# Start crud profile (sayt verb)
say launch

# Start with profiles
task launch              # crud only
task launch:sync         # + ElectricSQL
task launch:cdc          # + CDC pipeline (Conduit, Redis Streams, rpk)
task launch:stream       # + stream processing (Arroyo, Redpanda, Redis)
task launch:ai           # + AI gateway (Bifrost)
task launch:blobs        # + S3 storage + image processing (rclone-s3, imgproxy)

# Or directly with docker compose
docker compose up --build --watch                                    # crud
docker compose --profile sync up --build --watch                 # + sync
docker compose --profile sync --profile cdc up --build --watch   # + cdc

# Full cleanup (removes volumes)
docker compose --profile sync --profile cdc --profile stream --profile blobs down -v
```

### Native Mac Mode (no Docker)

Prerequisites: PostgreSQL running on localhost:5432, Redis on localhost:6379, ElectricSQL running.

```bash
# Start all apps via Dapr multi-app
dapr run -f .
```

### Testing

```bash
# Run crud smoke tests
task integrate

# Run CDC pipeline smoke tests (CDC end-to-end)
task integrate:cdc

# Manual CRUD test (via Caddy proxy on host port 8080)
curl -X POST http://localhost:8080/crud/Hello \
  -H "Content-Type: application/json" \
  -d '{"message": "test"}'
```

### Benchmarking

```bash
./scripts/benchmark.sh crud    # Startup + CRUD latency
./scripts/benchmark.sh cdc     # + CDC pipeline latency
```

## Code Generation Workflow

### 1. Define Entity in Protocol Buffers

Create or edit `.proto` files in `proto/` directory:

```protobuf
// proto/myentity.proto
syntax = "proto3";
package mecha.v1;

message MyEntity {
  string id = 1;
  string name = 2;
}
```

### 2. Update CUE Template Configuration

Add your entity to `tmpl.cue`:

```cue
MyEntity: _ @embed(file="gen/jsonschema/mecha.v1.MyEntity.jsonschema.json")

Entities: [
    // ... existing entities ...
    { name: "MyEntity", schema: MyEntity, lower: "myentity", ... },
]
```

### 3. Generate and Deploy

```bash
task generate
say launch
```

## Key Files and Directories

### Schema Definition
- `proto/*.proto` — Protocol Buffer entity definitions
- `proto/buf.gen.yaml` — Buf code generation config

### Code Generation
- `tmpl.cue` — CUE schema embedding and entity list
- `tmpl_tool.cue` — CUE tool command for gomplate templating
- `Taskfile.yml` — Task orchestration for generation pipeline

### Services
- `services/database/` — PostgreSQL 18 + wal2json + Atlas migrations
- `services/crud/` — PostgREST with microcheck health probe
- `services/proxy/` — Caddy reverse proxy (Caddyfile)
- `services/mesh/` — Dapr sidecar with Redis Streams pubsub + resiliency
- `services/cdc/` — Conduit CDC (PostgreSQL WAL → HTTP)
- `services/transform/` — rpk bloblang pipelines
- `services/ticker/` — periodic wake: `POST /poke` → one row per due tick (see its README; the argument is `docs/2026-09-08-a-tick-needs-no-durability.md`)

### Infrastructure
- `compose.yml` — Docker Compose with additive profiles
- `dapr.yaml` — Dapr multi-app config for native Mac mode
- `mise.toml` — Development tool versions
- `.say.yaml` — sayt verb config (lint)
- `scripts/benchmark.sh` — Startup + event flow timing

## The path a write takes

Every troubleshooting step below is a probe on one hop of this, so it is worth
having in front of you. The shape that surprises people is the return: the
pipeline writes back through the same CRUD API it read from, so a stuck
pipeline looks like a write that landed and never came back.

```
Frontend / Test
     │
     ├─ POST /crud/* ──────── Caddy ──── PostgREST ──── PostgreSQL
     │                                                       │
     │                                                 WAL (logical)
     │                                                       │
     │                                                   Conduit
     │                                                       │
     │                                              Dapr pubsub API
     │                                                       │
     │                                              Redis Streams
     │                                                       │
     │                                              rpk (bloblang)
     │                                                       │
     │                                              POST /crud/*
     │
     └─ ElectricSQL shapes ── PostgreSQL
```

## Troubleshooting

### Database Issues

```bash
# Check database health
docker compose exec database pg_isready

# Inspect replication slots (Conduit creates one)
docker compose exec database psql -U postgres -d mecha \
  -c "SELECT * FROM pg_replication_slots;"

# Check publication
docker compose exec database psql -U postgres -d mecha \
  -c "SELECT * FROM pg_publication;"
```

### CDC / Conduit Issues

```bash
# Check conduit logs
docker compose logs -f conduit

# Check Redis Streams status
docker compose exec redis redis-cli XINFO GROUPS cdc-events

# Check rpk transform logs
docker compose logs -f transform
```

### Dapr Issues

```bash
# Check Dapr sidecar logs
docker compose logs -f mesh

# Test Dapr health (port 3500 is internal; use docker exec)
docker compose exec mesh /busybox wget -qO- http://localhost:3500/v1.0/healthz

# Test pubsub publish from within the events network
docker compose exec mesh-events /busybox wget -qO- \
  --post-data='{"test": true}' \
  --header='Content-Type: application/json' \
  http://localhost:3500/v1.0/publish/redis-streams/test-topic
```

### Common Fixes

- **"Migration hash mismatch"**: Run `task atlas:hash` to regenerate `atlas.sum`
- **Conduit can't connect**: Ensure `conduit_pub` publication exists — migration `003_publication.sql` handles this
- **Redis not starting**: Check that port 6379 is available and no other Redis instance is running
- **rpk not consuming**: Check consumer group status with `docker compose exec redis redis-cli XINFO GROUPS cdc-events`
- **Stale state**: Full cleanup with `task clean` then `say launch`
