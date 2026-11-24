---
type: decision
title: The bounded bus
description: Keeps the Conduit → Dapr → Redis change bus and closes what native trimming left open — Redis that survives a restart, a poison record parked instead of retried forever, every derivation rebuilt from current rows, and a budget past which a stalled group or a slot is reset and rebuilt.
status: built
---

# The bounded bus

**Status: built, 24 November 2026.** Stages 2 through 5 are built
([[../change-capture|change capture]] holds the contract); stage 1 waits for an
alert channel, which the platform does not have yet.

## The problem

A committed change reaches derived data through one path
([[../change-capture|change capture]]): the WAL, Conduit reading one slot,
Dapr publishing to the Redis stream `cdc-events`, and a Redpanda Connect
consumer group per pipeline, drain and computation. golaberto in production
showed what that path left unbounded. #2532 closed one part: every reader now
calls Redis 8.2's `XTRIM … ACKED` per batch, so entries every group has
acknowledged leave the stream. The rest is open:

- **Redis forgets on restart.** Compose and the docker appliance run it with
  `--save '' --appendonly no`; a restart drops every pending and unread entry.
  Only k8s runs AOF.
- **No rebuild.** Conduit runs with `snapshotMode: never`, and the trimmed stream
  cannot replay: a lost stream, a lost slot or a new reader's group leaves
  derived data stale, and [[../change-capture|change capture]] says only that a
  new reader "needs a snapshot or recount".
- **No bound on failure.** A record every layer refuses stays pending and is
  retried forever; one poison record holds every record behind it.
- **No bound on a stalled group.** `ACKED` never trims what a group has not
  acknowledged, so one stalled reader keeps the whole stream, and a removed
  reader's group must be destroyed by hand.
- **No bound on the slot.** Nothing sets `max_slot_wal_keep_size`; a stalled
  Conduit keeps WAL on the primary without limit.

## Decision

**The bus stays; every derivation can rebuild, and each thing that can grow has
a budget past which it is reset and its consumers rebuild.**

Every consumer on the bus is level-triggered: a pipeline re-reads an absolute
aggregate, a drain recomputes in SQL, a computation recaptures. None needs the
history the bus keeps, only "this key changed", so a rebuild is recomputing from
the current rows, and no capture has to replay the past. Most of the rest rides
on what #2532 already runs: the guard every reader calls per batch
(`cdc_stream_trim`, a `redis_script` that reads `XINFO GROUPS`).

- **Redis keeps what it acknowledged.** The appliance runs AOF with
  `appendfsync always` in Debian's directory for it, `/var/lib/redis` (a named
  volume in production), as k8s already does, so an entry Dapr acknowledged to
  Conduit survives a crash; Redis 8.4's `aof-load-corrupt-tail-max-size`
  repairs a torn tail on load. Compose may stay
  in memory: a restart there is a rebuild.
- **A failed record leaves the push path for a durable retry.** A consumer that
  cannot process a record from `cdc-events`, after its inline retries, writes
  it unchanged to its group's retry stream, `<group>-retry`, and acknowledges
  it, so the stream keeps flowing. Dapr subscribes to every retry stream from
  the one `mesh-events` sidecar, delivers each record back to that consumer's
  replay input with a resiliency policy's backoff and bound, and dead-letters
  what still fails to `<group>-dead`; a replay that fails is rejected, so Dapr
  counts the attempt. A record that crashes its reader leaves no in-memory copy,
  only a growing delivery count in the group's pending list (`XPENDING`); past
  a limit the guard moves it to the retry stream the same way. A starting
  transform moves each dead stream back to its retry stream once, so the release
  that fixes a poison record also redrives it; the next change to the same key
  heals it too. Nothing is operated by hand: sayt's verbs and environment
  variables, the crash-loop limit and the group budget among them, suffice.
  Dapr's polling (its backoff and `redeliverInterval`) runs
  only on retry streams: a record that succeeds never meets it. Redis Streams
  honours resiliency policies from Dapr 1.17.
- **Every derivation rebuilds on start.** A drain already recomputes on its
  startup wake; a pipeline gains the same, sweeping every key of its source
  while it reads the stream, as a drain's wake does, and a computation
  recaptures. A rebuild is then a restart: the guard stops the transform when
  the stream, or a group it registered, has been recreated, and its restart
  sweeps.
- **A stalled group is retired, not kept.** The guard reads each declared
  group's `lag` and `pending`; past the budget (`CDC_GROUP_BUDGET`, default
  100000 entries of `lag + pending`) it destroys the group
  (`XGROUP DESTROY`) and deletes `cdc-epoch:<group>`, so the stream trims past
  it, and that reader's next read fails, restarts and sweeps. Redis runs with
  `maxmemory` (`REDIS_MAXMEMORY`, default `256mb`) and `noeviction`, so the
  budget is reached before memory is.
- **The slot is capped.** `max_slot_wal_keep_size` (`1GB`, `PG_MAX_SLOT_WAL_KEEP_SIZE`
  on the appliance; GCP Cloud SQL does not expose this flag) bounds the WAL a
  stalled Conduit keeps; Conduit's start drops a slot whose `wal_status` is
  `lost`, recreates it, and publishes `slot_reset` through `mesh-events`, so the
  guard clears every declared group's epoch and every reader restarts and sweeps.

## Stages

1. **Measure and alert.** Slot lag, `safe_wal_size` and group lag; waits for an
   alert channel.
2. **Durable Redis.** AOF with `appendfsync always` in the appliance's own Redis
   directory, on Redis 8.4.
3. **Durable retry.** Consumers hand a failed record to `<group>-retry`; the
   guard hands off crash loops; Dapr 1.17 retries with backoff and
   dead-letters to `<group>-dead`; a start redrives.
4. **Rebuild on start.** Pipelines sweep their sources; the guard stops a
   transform whose stream or group was recreated.
5. **Budgets.** A stalled group retired past its lag, `maxmemory` with
   `noeviction`, the slot capped and a lost one recreated.

### By release

Durable Redis and durable retry are what a production-grade release adds; the
rest is correctness every release keeps.

| | compose, CI, local | docker appliance, k8s, gcp |
| --- | --- | --- |
| a failed record | replayed in memory, as today | handed to the durable retry |
| Redis | in memory | AOF, `appendfsync always` |
| rebuild on start, group budget, slot cap | yes | yes |

## Alternatives

- **A Conduit pipeline and slot per consumer, posting straight to it.** Measured
  locally with the pinned Conduit and Connect: every hop is push, the slot is a
  durable buffer per consumer, a slow consumer delays only itself, and Conduit
  acknowledges a position only after the consumer's 2xx, which Connect returns
  only after its output delivered. It retires Redis and Dapr pub/sub, at one
  WAL decoding per consumer. Kept as the next step if Redis's budgets prove
  too coarse; #2532 invested in Redis first.
- **NATS JetStream as the buffer.** Disk-backed, push, a stalled consumer falls
  off its own retention, native on Windows. mecha ran it in its v2 design; Redis
  replaced it because only Redis has a managed service on every major cloud
  ([[../change-capture|change capture]]), and that still holds.
- **Electric's Durable Streams.** An open HTTP protocol where each consumer keeps
  its own offset and live-tails over long-poll or SSE, served by a Caddy module.
  Its retention is a whole stream's TTL, and it is at 0.x.
- **A derivation database fed by logical replication.** Handlers as `ENABLE
  ALWAYS` triggers on a subscriber: push, exactly-once and rebuilt by resync,
  but a long handler stalls apply, and moving it to a queue adds polled hops the
  bus does not have.
- **Handlers in the commit and an outbox after it.** Pure push, but the outbox is
  a queue on the primary: an insert and a delete per key, dead tuples under
  backlog, and `NOTIFY` waking every listener at a global commit lock.
- **DuckDB as the cushion.** No triggers, no change feed and a single writer:
  every consumer would poll it.
- **RisingWave for every derivation.** Semantically right, but its floor of 2 CPUs
  and 8 GiB ([hardware requirements](https://docs.risingwave.com/deploy/hardware-requirements))
  makes a join cost a streaming engine.
- **Dapr subscriptions for every record.** Retry, backoff and a dead-letter
  topic for free, but Dapr's consumer group is its app's, so per-group
  isolation needs a sidecar per group, and every record pays the extra hop.
  Only the durable retry uses Dapr.
- **The guard handing off every failure.** One place instead of every consumer,
  but Connect 4.114.0 replays a nacked record from memory without end, even
  after an external `XACK` (measured): only the consumer can let go of it.
- **Redis 8.6's idempotent `XADD` (`IDMP`)** would drop a replayed publish, but
  Dapr's publish cannot pass it, and level-triggered consumers absorb a
  duplicate. **Redis 8.4's `XREADGROUP … CLAIM`** reclaims idle entries, but every
  reader has a stable identity and re-reads its own pending list on restart.
- **Kafka or Redpanda, Sequin, Debezium.** Partitions, ordered groups or
  incremental snapshots, each at an operations cost (a Kafka cluster, a second
  Postgres and Redis, a JVM) the level-triggered consumers do not need.
- **Lost-slot signalling: `slot_reset` through `mesh-events` vs direct Postgres or Redis access.**
  Conduit already speaks to `mesh-events` and has no Redis connection; publishing
  `{"__table":"slot_reset"}` over `mesh-events` reuses the existing bus path,
  lets `cdc_stream_trim` clear every declared group's `cdc-epoch:*` atomically in
  Redis, and avoids giving the transform Postgres credentials or giving Conduit
  direct Redis credentials (Dapr itself exposes no `DEL` on pubsub).
- **Group budget unit: `lag + pending` entries vs bytes or pending age.**
  `XINFO GROUPS` reports `lag` and `pending` in O(1) inside the guard's Lua
  script without scanning entries or `XPENDING` timestamps; `lag + pending`
  covers both a reader stopped before reading and a reader stalled with unacked
  entries, whereas `XMEMORY USAGE` or oldest-pending scans add per-entry cost.

## Managed-service findings

- **`noeviction` and `appendfsync always`.** Memorystore for Redis, Amazon
  ElastiCache, and Upstash all support `noeviction`; ElastiCache exposes
  `appendfsync always` via custom parameter groups, whereas Memorystore and
  Upstash manage persistence internally without exposing `appendfsync`.
- **Cloud SQL for PostgreSQL.** `max_slot_wal_keep_size` is not an exposed
  Cloud SQL database flag; Cloud SQL relies on monitoring `pg_replication_slots`,
  `wal_sender_timeout`, and manual `pg_drop_replication_slot`.
