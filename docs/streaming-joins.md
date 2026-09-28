---
type: concept
title: Streaming joins
description: The stream tier — Arroyo over the change feed, writing a derived table back through CRUD — what runs, and what a join across entities needs.
---

# Streaming joins

CRUD answers a read from the rows as they are. An answer that depends on many
rows, on several tables or on time is either recomputed on every read or kept.
The stream tier keeps it: it reads the change feed, holds state, and writes its
result back through the CRUD API as an ordinary table, which sync serves and
PostgREST answers like any other. That is what makes mecha more than CRUD with
a change feed. It is also its least finished part: what runs is one windowed
aggregation over one entity, and no join.

## What runs

```
cdc-events ─► kafka-fanout ─► Redpanda flat-Hello ─► Arroyo ─► POST crud:3000/GroupHello
```

None of it is in the cluster: [`bayt.cue`](../bayt.cue) adds `redpanda`
(v24.3.7, `--mode=dev-container`), `kafka-fanout` and `arroyo` beside it in
mecha's own stack ([beside the cluster](capabilities.md#beside-the-cluster)).

- **The tee**, [`kafka-fanout.yaml`](../services/transform/kafka-fanout.yaml),
  reads the bus in its own consumer group ([routing](change-capture.md#routing))
  and writes each row with an `id` to the topic `flat-${collection}`, stamped
  with `operation`, `collection` and `traceparent`. A `generate` input merged
  into it adds a heartbeat every five seconds, so time moves on an idle topic
  and a window closes without waiting for the next write.
- **The query**, [`hello_aggregation.sql`](../services/arroyo/queries/hello_aggregation.sql),
  reads `flat-Hello` as a Kafka source from `earliest`, keeps `create` records
  of `Hello`, takes `DISTINCT id, message` (the write-back's UPDATE arrives as a
  second copy of the same row) and, per 30-second tumbling window holding at
  least two, posts `string_agg(message, ', ')` through a webhook sink to
  PostgREST's `/GroupHello`.
- **Loading**: [`arroyo-init.sh`](../services/arroyo/arroyo-init.sh) starts
  Arroyo, creates the pipeline from the file (a 409 means one by that name
  exists) and force-restarts it on every container start.
- **The proof** is `task integrate:stream`: `smoke-stream` posts three `Hello`
  rows to PostgREST, and its healthcheck holds until `GroupHello` has a row
  joining their messages with commas.

The SQL is hand-written. `task generate` renders only the database's HCL
([schema](schema.md#mechas-own-tables-from-protobuf)), and the source's columns
restate `Hello`'s by hand.

## What a join keeps that CRUD cannot

- **A shape is one table.** ElectricSQL syncs one table under a filter. A
  screen that needs two entities together either syncs both whole and joins in
  every browser, or reads a view through PostgREST and polls, which the sync
  path exists to remove.
- **A view is not a table.** Logical replication publishes tables, so no view
  reaches sync, and a materialized view recomputes whole on a `REFRESH`
  someone schedules.
- **A join kept as a table is paid per write**, once, not per read per client,
  and its rows sync and serve like any table's.
- **It can speak of time**: a count per window, a row with no match ten minutes
  later. No read and no trigger says that without a scheduler.

## What a join needs below it

A join across entities runs on the same path, and needs three things it does
not give:

- **A topic per entity.** The tee sets `collection` to `Hello` for every record,
  because the bus record names no table
  ([the record on the bus](change-capture.md#the-record-on-the-bus)): every
  captured row, from any table, lands on `flat-Hello` stamped `create`.
- **Changes, not inserts.** A join retracts what it emitted when an input
  changes or goes. The tee stamps every row `create`, and a delete reaches it
  with no row, so an append-only aggregation is the only shape correct on it.
- **A sink that absorbs and updates.** The webhook posts to PostgREST directly,
  with no key and no `Prefer`, so each emission is a new row. A join's output
  row changes with its inputs: it needs a key derived from the join key, an
  upsert, and a delete, which a webhook sink cannot send.

## What bites

- **A replay is a second row.** After a restart Arroyo can re-emit windows
  since its last checkpoint, and neither `redpanda` nor `arroyo` has a volume:
  a recreated Arroyo reads `flat-Hello` from `earliest` again and re-posts
  every window. Nothing on `GroupHello` absorbs either.
- **The derived table echoes.** `GroupHello` is captured too, so its rows come
  back on `flat-Hello` as an id with a null `message`. `COUNT(*)` counts them
  and `string_agg` skips them: a window with one `Hello` and one echo posts a
  group of one.
- **The endpoint spells the table.** PostgREST serves `"GroupHello"` at
  `/GroupHello`; a sink posting to `/grouphello` gets a 404.
- **The sink writes as `anon`**: it carries no token.
- **The derived table has no floor.** Nothing calls `rls_protect` on
  `GroupHello` ([the tenancy floor](../services/database/rls/README.md)).

## Rejected

- **Arroyo's SSE source, fed by the proxy.** No offsets: a restart loses what
  was in flight, and replay needs a Last-Event-ID store kept by hand. A Kafka
  topic has offsets, and Arroyo checkpoints its position in them.
- **Arroyo reading the bus.** The bus differs per tier, Redis Streams in
  compose and the provider's pubsub above it; Kafka is a protocol Arroyo reads
  and every cloud serves managed, so the tee is the one seam.
- **Views and materialized views read through CRUD.** Neither reaches sync, and
  a materialized view recomputes whole.
- **Triggers keeping a derived table.** Imperative code in every write's
  transaction, adding its latency to the write, with no notion of time.
- **Joining in the browser.** Every client syncs every input whole and
  recomputes the same join.
- **A heartbeat in a container of its own.** At cloud tier it scales to zero
  with nothing to wake it; inside the tee it runs exactly while the pipeline
  does.
