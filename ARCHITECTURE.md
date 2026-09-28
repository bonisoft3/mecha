---
type: reference
title: "Mecha: the architecture behind the invariants"
description: The stack that satisfies the invariants in this tree, one row per component, each linking the document that argues it.
---

# Mecha: the architecture behind the invariants

`README.md` states what makes a system a mecha. This is the stack that
satisfies it here, as a single machine runs it; each row links the document
that argues the part and what it was chosen over.

```
browser ─► Caddy ─┬─ /crud ─────► PostgREST ─► PostgreSQL ─ WAL ─► Conduit
                  ├─ /electric ─► ElectricSQL ◄─────┘                 │
                  ├─ /poke ─────► ticker ◄── clock           Dapr (mesh-events)
                  └─ /img ──────► imgproxy ─► rclone-s3               │
                                                           Redis Streams cdc-events
                                                     ┌────────────────┴───┐
                                                 transform          kafka-fanout
                                              PATCH ─► PostgREST          │
                                                                      Redpanda ─► Arroyo
                                                                                    │
                                                            PostgREST ◄─ webhook ───┘
```

The routes are mecha's own Caddyfile's; a consumer's differs
([the proxy](docs/proxy.md#routes)).

| role | component | argued in |
|---|---|---|
| The door | Caddy, one h2 origin | [the proxy](docs/proxy.md) |
| Database | PostgreSQL 18, with the tenancy floor | [schema](docs/schema.md), [row-level security](services/database/rls/README.md) |
| CRUD | PostgREST, its API read from the catalog | [schema](docs/schema.md#what-notices-a-change) |
| Real-time sync | ElectricSQL | [the proxy](docs/proxy.md#routes) |
| Change capture | Conduit, reading a publication through a slot | [change capture](docs/change-capture.md) |
| Mesh | Dapr, holding the publish side | [change capture](docs/change-capture.md#the-path), [the bundled unit](docs/deployment.md#the-bundled-unit) |
| Bus | Redis Streams | [change capture](docs/change-capture.md#retries), [its rejected alternatives](docs/change-capture.md#rejected) |
| Transform | Redpanda Connect: YAML and bloblang | [change capture](docs/change-capture.md#routing) |
| Kafka broker, stream processing | Redpanda, Arroyo | [streaming joins](docs/streaming-joins.md) |
| Auth | the auth service's WebAuthn and tokens | [its contract](services/auth/README.md) |
| Object storage, images | rclone-s3, imgproxy | [the blob plane](docs/capabilities.md#the-blob-plane) |
| Periodic wake | ticker, clock | [its contract](services/ticker/README.md), [the first request](docs/deployment.md#the-first-request) |
| The same cluster in a page | PGlite and a stand-in per service | [the browser platform](docs/browser.md) |

A cluster turns its planes on in `cluster.cue`
([invariant 7](README.md#7-additive-capabilities)): data, auth, blobs, and a
schedule ([capabilities](docs/capabilities.md)). The same services run at every
tier of [invariant 4](README.md#4-vertical-scalability-down-and-up); what each
tier runs them on is [tiers and clouds](docs/deployment.md), and what is not
built is [PENDING.md](PENDING.md).
