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
| WAL → Conduit | Conduit v0.20.4, `builtin:postgres` in `logrepl` mode, `snapshotMode: never`, forwarding what its `tables` names. The pipeline is the consumer's template (`meta.conduitTemplate`; mecha's is [`cdc-to-dapr.yaml`](../services/cdc/pipelines/cdc-to-dapr.yaml)), `envsubst`-rendered at every start |
| Conduit → Dapr | the `standalone:http` connector v0.4.0, baked into `conduit-image` |
| Dapr → bus | daprd 1.17.20, pubsub component `redis-streams` ([components](../services/mesh/dapr/components/)); the topic is the stream key |
| bus → pipelines | Redpanda Connect 4.114.0 (`rpk`) reading Redis itself, one consumer group per pipeline; `state.pipelines` in [`cluster.cue`](../cluster.cue) |

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

## Transaction traces

The CloudEvent's `traceparent` is conduit's publish, not the write. Where a
publication carries `mecha.txn_trace` (rls.sql), each writing transaction's
first change on the bus is its marker, `__table: txn_trace`, holding the
writer's traceparent or `''`. Every stream the transform runs loads
[`cdc-trace.yaml`](../services/transform/cdc-trace.yaml) by `-r`: its
`cdc_trace_join`, among a stream's input processors, drops each marker into a
per-stream cache entry and stamps every later row's `@traceparent`. Calls send
it as the `traceparent` header, so PostgREST's `mark_txn` marks the derived
write's transaction with the same trace and the chain continues through it. A
call that coalesces a batch (a drain, compute's invalidation) sends the first
traced transaction's (`cdc_trace_batch`).

The join is ordered for free: Connect runs input processors on one goroutine,
so a stream's pipeline threads stay parallel. A process that restarts mid-
transaction knows no trace for that transaction's remaining rows.

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

Without durable retry a record every layer refuses stays in its group's pending
list, retried forever. A release enrols a group in durable retry by naming it in
`CDC_RETRY_GROUPS` (pronto's docker appliance and Kubernetes/GKE releases enrol
every generated pipeline and drain):

- **Hand-off.** A record the consumer fails, after the output's own retries, is
  written unchanged to `<group>-retry` and acknowledged, so the stream moves on.
  A record that crashes the consumer leaves only a growing delivery count;
  past `CDC_MAX_DELIVERIES` (5) the per-batch guard in
  [[../services/transform/cdc-trace.yaml]] moves it the same way.
- **Redelivery.** `mesh-events`' daprd subscribes to each retry stream with the
  release's Subscription files (`MESH_SUBSCRIPTIONS_DIR`) and posts every record
  to its stream's `/<stream>/replay` on the transform (`CDC_REPLAY_PORT`, which
  daprd reaches at `MESH_APP_ADDRESS` and `MESH_APP_PORT`). The inbound policy `redeliver` in
  `resiliency.yaml` backs off from 1 s to 5 min over twelve retries; a replay
  that fails answers an error, and past the policy the record lands in
  `<group>-dead`. Dapr's polling stays on the retry streams: a record that
  succeeds never meets it.
- **Redrive.** On start, [[../services/transform/durable-retry.yaml]] moves each
  enrolled group's dead stream back to its retry stream and logs, per group,
  what it redrove, what is pending and the lag, so the release that fixes a
  poison record also redelivers it.

Computations use the same direct Redis input
in [[../services/compute/events.yaml]], forwarding invalidations to compute over
HTTP. On start, `events.yaml` sends a full invalidation (`{"tables": null}`) so
group retirement, slot reset, or Redis loss rebuilds computations without
restarting `compute`. The output waits for completion and resends a refused invalidation with
exponential backoff; still refused after twelve retries, it crashes the transform process, so
the stack fails loudly, and the invalidation, still pending, is replayed first
when it restarts.
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
- **A stalled feed holds WAL up to `max_slot_wal_keep_size`** (`1GB` default in
  [`cluster.cue`](../cluster.cue) and k8s; `PG_MAX_SLOT_WAL_KEEP_SIZE` in the
  docker appliance). GCP Cloud SQL for PostgreSQL does not expose
  `max_slot_wal_keep_size` as a database flag. When `pg_replication_slots.wal_status = 'lost'`
  on Conduit's start (or `slot_reset_pending` remains commented on its
  publication from an interrupted recovery), Conduit waits for `mesh-events`,
  records `slot_reset_pending` on the publication, ensures the `pgoutput` slot
  is recreated, publishes `{"__table":"slot_reset"}` onto `cdc-events` so every
  reader restarts and sweeps, and only then clears the publication comment. On
  the docker appliance, `electric` likewise drops a `lost`
  `electric_slot_default` and clears its shape storage on start so a WAL cap
  hit does not stall startup.
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

## Redis stream retention

The native cluster pins Redis 8.4.8 by image digest. Compose runs that image;
the Debian release appliance copies its glibc server and CLI binaries.
Existing transform inputs call Redis's
`XTRIM cdc-events MAXLEN ~ 10000 LIMIT 1000 ACKED` once per incoming batch
(one event per reader with the Redis Streams input). Redis removes only entries read and acknowledged by every existing group;
pending and unread entries can keep the stream above 10,000 entries. Trimming
is approximate and bounded per call. With no new batches, the remaining tail
stays in Redis. No retention process runs separately. Mecha’s standalone demonstration does
not opt into trimming: its optional Kafka fan-out starts outside the transform
reader manifest and must retain the backlog until it registers.

The shared input resource atomically checks the declared `CDC_GROUPS` before
issuing the native command. Until every declared reader has registered, it
leaves the stream intact. Synthetic startup wakes do not trim. A Redis error
stops the transform instead of acknowledging a failed batch. Raw CDC pipelines
must call `cdc_stream_trim` alongside their input processors.

The manifest is a startup guard, not a whitelist: unknown and obsolete groups
also constrain Redis's native trimming. After permanently removing a reader,
stop that reader and explicitly retire its group with `XGROUP DESTROY`; do not
delete groups belonging to running consumers.

Declared groups in `CDC_GROUPS` also have a stalled-group budget,
`CDC_GROUP_BUDGET` (default `100000` entries of `lag + pending`). Past that
budget `cdc_stream_trim` calls `XGROUP DESTROY` on the stalled group, deletes
`cdc-epoch:<group>`, and marks `cdc-retired:<group>` so `ACKED` trimming
continues while the group is absent. When that reader restarts, its startup
wake (or first guard check past budget if it reconnects at offset `0`) advances
the group to `$` and clears `cdc-retired:<group>` instead of replaying the
retained backlog and re-retiring. Redis runs with `maxmemory` (`REDIS_MAXMEMORY`, default `256mb`) and
`noeviction` so the stalled-group budget is reached before memory fills; the
guard script sets `#!lua flags=allow-oom` so trimming still runs at the memory
limit.

## Rebuild

Every reader rebuilds from the current rows when it starts, so a new reader, a
restart after Redis lost entries, a retired group, or a lost replication slot
needs no snapshot. A drain recomputes on its start wake. A generated pipeline
sweeps: it reads every row of its source from PostgREST, and runs each through
its transform as the bus would carry the row's insert, with the aggregate read
once for the whole sweep. A key whose source rows are all gone is not swept, so
its sink row stays as it was. A hand-written pipeline is its author's to rebuild.

The guard keeps an epoch per group in Redis (`cdc-epoch:<group>`), set the first
time it sees the group, and each transform process remembers the epoch it first
read. A Redis that lost its data, or a group whose epoch was removed with it,
shows the reader a new epoch; the reader stops (`restarting to rebuild`), and
its restart rebuilds. When Conduit recreates a `lost` slot on start and
publishes `{"__table":"slot_reset"}`, `cdc_stream_trim` clears every declared
group's epoch, acknowledges the marker for that reader, and crashes the process
once so its restart sweeps; other readers seeing the same marker ID drop it and
restart via their cleared epochs without looping.
Upgrade the Redis server before starting transforms that use `ACKED`.
