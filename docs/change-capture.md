---
type: concept
title: Change capture and delivery
description: How a committed row reaches the pipelines through Conduit, Dapr, the bus and rpk, what each hop retries, and what absorbs a duplicate.
---

# Change capture and delivery

Change capture reads the WAL, so a committed row of a captured table is
captured whoever wrote it, with no writer's cooperation. The pipelines write
back through the same CRUD API, so a stuck path looks like a write that landed
and never came back.

## The path

```
PostgREST ─► PostgreSQL ── publication conduit_pub, slot conduit_slot
                  │ logical replication
              Conduit ── POST the row ─► Dapr (mesh-events)
                                            │ /v1.0/publish/redis-streams/cdc-events
                                         Redis stream cdc-events
                          ┌─────────────────┴─────────────────┐
               group rpk-transform                 group rpk-kafka-fanout
           transform: PATCH crud:3000        kafka-fanout: Kafka (streaming-joins.md)
```

| hop | what runs it |
|---|---|
| WAL → Conduit | Conduit v0.14.0, `builtin:postgres` in `logrepl` mode, `snapshotMode: never`, forwarding what its `tables` names. The pipeline is the consumer's template (`meta.conduitTemplate`; mecha's is [`cdc-to-dapr.yaml`](../services/cdc/pipelines/cdc-to-dapr.yaml)), `envsubst`-rendered at every start |
| Conduit → Dapr | the `standalone:http` connector v0.4.0, baked into `conduit-image` |
| Dapr → bus | daprd 1.16.1, pubsub component `redis-streams` ([components](../services/mesh/dapr/components/)); the topic is the stream key |
| bus → pipelines | Redpanda Connect 4.112.0 (`rpk`) reading Redis itself, one consumer group per pipeline; `state.pipelines` in [`cluster.cue`](../cluster.cue) |

Dapr holds the publish side: Conduit names a component and a topic, and what
backs the component is Dapr's configuration. The consumer side is not
abstracted: mecha's pipelines read `redis_streams`, so another bus changes
their inputs as well as the component. At cloud tier Conduit, Dapr and
transform run as one unit ([the bundled unit](deployment.md#the-bundled-unit)).

## The record on the bus

Conduit posts the row's after-image and nothing else. Dapr wraps it as a
CloudEvent with `datacontenttype: text/plain`, so `data` is the row as a JSON
string beside a `traceparent`, and every pipeline opens with
`this.data.parse_json()`.

No table, no operation, no before-image: a pipeline hard-codes the table it
writes (`meta collection = "Hello"`) and sees rows from every captured table. A
delete has no after-image, and every shipped pipeline drops a record without an
`id`.

## Routing

Two pipelines read the stream in separate groups, so each acknowledges on its
own and a Redpanda outage stalls the tee, not the write-back:

- **transform** ([`passthrough.yaml`](../services/transform/passthrough.yaml))
  PATCHes a row with an `id` and no `processed_at`, setting `processed_at` and
  `source`, and drops the rest. Its own UPDATE comes back enriched and is
  dropped, which ends the loop a write-back would otherwise start.
- **kafka-fanout**, in mecha's own stack only, tees every row with an `id`, and
  a heartbeat every five seconds, onto Kafka.

Pipelines write to PostgREST directly, never through the proxy, whose POST
`Prefer` would override a pipeline's own `resolution=merge-duplicates`: the
cluster hands transform `CRUD_URL`, and `passthrough.yaml` addresses
`crud:3000`. With the auth plane on, transform is handed `SERVICE_JWT`
([the token contract](../services/auth/README.md)), but `passthrough.yaml`
sends no `Authorization` header, so it writes as `anon`.

## Retries

Each hop acknowledges upstream only after downstream accepted:

| hop | on failure |
|---|---|
| Conduit → Dapr | the position is not acknowledged; the slot keeps the WAL |
| Dapr → Redis | policy `publish`: exponential backoff to 15 s, without limit; `default-breaker` opens for 30 s after more than five consecutive failures |
| pipeline → PostgREST | the output's `retry`: three retries, 2 s to 30 s, three minutes in all |
| after that | the output nacks and the input replays the entry (`auto_replay_nacks`, on by default), without end |

There is no dead-letter stream: a record every layer refuses stays in its
group's pending list, retried forever. The `maxRetries`, `redeliverInterval` and
`processingTimeout` in `redis-streams.yaml` govern Dapr's own subscribers, and
nothing subscribes through Dapr. Computations use the same direct Redis input
in [[../services/compute/events.yaml]], forwarding invalidations to compute over
HTTP. The output waits for completion, nacks failures, and the input replays.
The compute consumer has a stable identity so container replacement also
recovers pending messages. Delivery is at least once; it provides no version
fence across concurrent writers.

## Duplicates

A pipeline can see a row twice: acknowledgements are committed once a second
(`commit_period: 1s`), and Conduit resumes from the slot's confirmed position.
The key absorbs the second copy:

- **The primary key is the request id**; no table has another. A POST through
  the proxy carries `resolution=ignore-duplicates` ([routes](proxy.md#routes)),
  which PostgREST resolves against the primary key: a replay with the same
  client-minted or derived key answers 201 with no rows. Only a writer that
  supplies the key is absorbed: every generated table defaults `id` to
  `uuidv7()` ([the template](schema.md#mechas-own-tables-from-protobuf)), so a
  POST without `id` inserts a second row. A secondary `UNIQUE` turns a replay
  into a 409 ([the ticker's warning](../services/ticker/README.md#one-table-of-mechas-and-the-apps-own)).
- **A PATCH by key converges**: it sets the same columns again.
- **A pipeline that inserts** bypasses the proxy, so it states its own `Prefer`
  and derives its key from its input, as the ticker's `uuid5` does.

The stream tier's webhook sink has neither ([streaming joins](streaming-joins.md#what-bites)).

## What bites

- **Rows older than the slot are never captured.** Conduit creates
  `conduit_slot` on first start and never snapshots; initdb seeds never reach
  the bus.
- **Row-level security does not filter the feed.** Logical decoding reads every
  table in `conduit_pub` (`FOR ALL TABLES`) whatever its policies
  ([a credential in a column](../services/ticker/README.md#reading-a-restricted-table-from-the-pipeline)).
- **A stalled feed holds WAL**: `pg_wal` grows while Conduit is down.
- **Reset the database and Conduit together.** Conduit keeps its position in
  memory (`CONDUIT_DB_TYPE: inmemory`); under a running Conduit, a reset
  database is asked for WAL it never had, and the feed dies silently. Compose
  restarts Conduit with a recreated database (bayt adds `restart: true` to every
  health wait); elsewhere, restart them as one.
- **Names are verbatim.** PostgREST serves `"GroupHello"` at `/GroupHello`;
  Dapr's publish path segment is the bus topic's exact name.
- **A new table is forwarded once `tables` names it**, though the publication
  already covers it.

## When a write does not come back

Probe hop by hop; services carry their bayt names:

```bash
docker compose exec libraries_mecha-database pg_isready
docker compose exec libraries_mecha-database psql -U postgres -d mecha -c "SELECT slot_name, active, confirmed_flush_lsn FROM pg_replication_slots;"
docker compose exec libraries_mecha-database psql -U postgres -d mecha -c "SELECT * FROM pg_publication;"
docker compose logs -f libraries_mecha-conduit
docker compose exec libraries_mecha-redis redis-cli XINFO GROUPS cdc-events
docker compose exec libraries_mecha-redis redis-cli XPENDING cdc-events rpk-transform
docker compose logs -f libraries_mecha-transform
docker compose logs -f libraries_mecha-mesh-events    # Dapr; port 3500 is internal
docker compose exec libraries_mecha-mesh-events /busybox wget -qO- http://localhost:3500/v1.0/healthz
docker compose exec libraries_mecha-mesh-events /busybox wget -qO- --post-data='{"test": true}' \
  --header='Content-Type: application/json' http://localhost:3500/v1.0/publish/redis-streams/test-topic
```

- **Conduit cannot connect**: the publication its template names must exist;
  mecha's `conduit_pub` comes from `006_conduit_publication.sql`.
- **A pipeline is not consuming**: an entry that stays in `XPENDING` is one its
  output keeps refusing.
- **Stale state**: `task clean`, then `sayt launch`.

## Rejected

- **A custom WAL reader (Boxer, in Rust).** Its own WAL parser is maintenance
  per PostgreSQL major version, with no Windows build; Conduit reads a
  publication, and its pipeline is YAML.
- **pgstream's SSE feed.** It advances the LSN whether or not the event was
  delivered: fire-and-forget.
- **NATS as the bus.** Dapr's component and rpk's inputs read NATS JetStream
  as readily as Redis, but only Redis has a managed service on every major
  cloud ([managed equivalents](deployment.md#managed-equivalents)), so over
  Redis the same component and the same `redis_streams` inputs run on any of
  them.
- **Redis Streams as a buffer in front of the mesh**, to absorb Dapr's start.
  The slot holds the WAL until Dapr accepts, and `validateConnection: false`
  lets Conduit start first.
- **One pipeline fanning out through a `broker` output.** One acknowledgement
  for both sinks: a Kafka outage would stall the write-back, and every cluster
  would need Kafka.
- **Deduplicating in the pipeline** with a seen-set: a second store holding
  what the primary key already makes unique.
