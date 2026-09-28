---
type: metric
title: Pending
description: What mecha argues for and has not built, each with the argument, checked against this tree on the date given.
---

# Pending

What mecha argues for and does not have. A line leaves when it lands or when a
document refuses it.

Every claim below was checked against this tree on 2026-09-27.

## Change capture

**A record every retry refuses lands in a dead-letter stream**, through a
`fallback` output that parks it for inspection and replay
([retries](docs/change-capture.md#retries)).

**The bus record carries its table, its operation and its before-image**
([the record on the bus](docs/change-capture.md#the-record-on-the-bus)). The
OpenCDC record Conduit holds has all three, and a processor before the HTTP
destination could keep them.

**Redelivery after a pipeline crash is tested.** The smoke suites prove one
insert's happy path. Nothing kills `transform` between reading an entry and
acknowledging it, which is the case at-least-once exists for.

**The bus speaks MQTT.** Dapr's MQTT pubsub in front of Mosquitto would give
every tier one message protocol, with MQTT v5 shared subscriptions to scale a
pipeline's consumers and a managed broker on AWS (IoT Core) and Azure (Event
Grid). The pipelines read `redis_streams` themselves, so their inputs move with
the bus ([the path](docs/change-capture.md#the-path)).

## Streaming joins

**Stream processing is a cluster capability**
([beside the cluster](docs/capabilities.md#beside-the-cluster)). A switch beside
`blobs` would make derived tables available to every cluster.

**The tee writes each table to its own `flat-<Entity>` topic**, routing by the
table on the bus record ([what a join needs below it](docs/streaming-joins.md#what-a-join-needs-below-it)).

**The topics carry changes, not rows**: before, after and operation, the shape
Arroyo reads as `debezium_json`
([what a join needs below it](docs/streaming-joins.md#what-a-join-needs-below-it)).

**A join across entities runs**, two entities' topics written back as a derived
table a screen syncs as one shape ([streaming joins](docs/streaming-joins.md)).

**The derived table absorbs a replay**, with a key derived from the window or
join key and `Prefer: resolution=merge-duplicates` in the sink's headers
([what bites](docs/streaming-joins.md#what-bites)).

**Arroyo and Redpanda keep their state across recreation**, on volumes
([what bites](docs/streaming-joins.md#what-bites)).

**The Arroyo sources are rendered from schema**
([what runs](docs/streaming-joins.md#what-runs)). Rendering the Kafka
`CREATE TABLE` from `Entities` keeps a new column from being silently missing
in the stream.

## Schema

**Every list that names an entity is rendered from `Entities`**
([what else names an entity](docs/schema.md#what-else-names-an-entity)).

**`task generate` ends in a migration, or fails.** It renders the HCL and
stops. A check that `atlas migrate diff` would write nothing catches HCL that no
migration carries.

**Numbers keep their width and fraction**: reading the `anyOf`'s first arm
gives `bigint`, `double precision` and enums their own types
([what bites](docs/schema.md#what-bites)).

**`buf breaking` guards the entities.** `buf.yaml` configures the `FILE` rules
and no task runs them. Run in `task test` against the main branch, they would
refuse a renumbered or retyped field before it reaches a migration.

**protovalidate rules reach the table.** Only `max_len` crosses; `min_len`,
`pattern` and `uuid` stop at the JSON Schema, so PostgREST accepts what the
proto forbids.

## Tiers and clouds

**The CLI tier runs** ([the tiers](docs/deployment.md#the-tiers)). Its runner
is an open choice. `dapr run -f dapr.yaml` starts each app beside its own
daprd, the mesh every other tier has. process-compose orders native processes
by health, as compose orders the single-machine tier, and would run each daprd
as a process of its own.

**The k8s tier** ([the tiers](docs/deployment.md#the-tiers)).

**Every server tier runs the migrate step** once per deploy, after the database
is ready and before new readers roll out, and a failure stops the rollout: a
Job with `backoffLimit: 0` on k8s, a job executed with `--wait` on Cloud Run
([carrying a live database forward](docs/schema.md#carrying-a-live-database-forward)).
`pgroll init` installs event triggers, so the migration role needs that
privilege on a managed Postgres.

**mecha emits the cloud tier** ([as built](docs/deployment.md#clouds-as-built)).
Emitting it from `cluster.cue` takes the bus as the tier's choice in mecha's
images, and derives the bundled unit from the cluster instead of writing it by
hand.

**AWS and Azure**, on their [managed equivalents](docs/deployment.md#managed-equivalents).

**Stream processing on a cloud.** A managed Kafka under Arroyo keeps the tee as
the one seam ([managed equivalents](docs/deployment.md#managed-equivalents)).

**conduit reclaims a slot a dead connection holds**, terminating the stale
backend before it starts ([what bites](docs/deployment.md#what-bites-on-cloud-run)).

**The edge tier** ([the tiers](docs/deployment.md#the-tiers)).

**The ticker's cloud clock**, with the rest of its unbuilt parts:
[the ticker](services/ticker/README.md#not-built).

## The browser platform

**The browser cluster syncs with a server**
([what it gives up](docs/browser.md#what-it-gives-up)). Online, the page's
PGlite would follow the server's shapes; offline, it answers reads and keeps
writes; on reconnect, the outbox replays them.

**The page routes from the Caddyfile**, through `caddy-js`, so a route the
Caddyfile gains reaches the page
([what stands in for what](docs/browser.md#what-stands-in-for-what)).

## Capabilities

**The blob plane authorizes**
([the blob plane](docs/capabilities.md#the-blob-plane)). A gate in front of
`/blobs`, like the one a consumer's Caddyfile puts in front of `/electric`
([routes](docs/proxy.md#routes)), would close the store, and an imgproxy key
and salt would close `/img`.

**The blob smoke round-trips through the door**, its PUT and GET able to fail
the suite ([the blob plane](docs/capabilities.md#the-blob-plane)).

**An AI gateway runs in its seat**
([beside the cluster](docs/capabilities.md#beside-the-cluster)). Bifrost there
would give pipelines one model endpoint inside the cluster, as the page's model
handler does at browser tier.
