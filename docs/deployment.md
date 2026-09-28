---
type: concept
title: Tiers and clouds
description: mecha's tiers from browser to edge, the unit that holds the WAL reader and the request that wakes it, the managed service each component maps to, and what runs on a cloud as built.
---

# Tiers and clouds

A tier is what the cluster is made of in one place. The services, the schema
and the door's routes are the same at every tier. What changes is the
substrate, and with it what the change path can promise.

## The tiers

| tier | the cluster runs as | in this tree |
|---|---|---|
| Browser | PGlite and a JavaScript stand-in per service, in one tab | Built: [`packages/mecha-browser`](browser.md). The change path is best-effort |
| CLI | Native processes, no containers | `sayt launch@local` runs `dapr run -f dapr.yaml` against a PostgreSQL on `:5432` and a Redis on `:6379`. That file names `services/crud/postgrest-local.conf` and `services/cdc/conduit.yaml`, and neither is in the tree, so its crud and conduit do not start. The Caddyfile and the pipeline it runs address compose names (`crud:3000`, `redis:6379`) |
| Single machine | Docker Compose: [`cluster.cue`](../cluster.cue), lowered by bayt | Built. Every consumer develops here |
| k8s | A Deployment per service, scaling from zero, with a CronJob as the clock | Not built |
| Cloud | Managed services that scale to zero | Runs on GCP through a consumer's overlay ([as built](#clouds-as-built)); mecha emits no cloud artifact of its own |
| Edge | The cluster in a serverless isolate on Cloudflare, over Cloudflare's SQLite-backed storage | Not built |

Where a WAL reader runs, the change path is at-least-once end to end
([change capture](change-capture.md)).

On a single machine nothing sleeps. The database keeps its data directory on
the container's writable layer, so a recreated database starts empty.

**The fence is the part of the ladder the code reads.** A migration fences the
statements that need a WAL reader under the one tier word, `container`
([the fence](browser.md#the-fence)). The word orders nothing: the fenced
statements apply on every rung where PostgreSQL itself runs — CLI, single
machine, k8s and cloud — and PGlite skips them.

## The bundled unit

At cloud tier, the unit's daprd (`mesh-events` in `cluster.cue`), conduit and
transform are three containers of one Cloud Run service at
`minInstanceCount: 0`. Only daprd publishes a port. A request therefore
reaches daprd, and starting the instance starts the other two. conduit and
transform list daprd in `dependsOn`, so daprd is listening before conduit
publishes to it. The unit runs with `cpuIdle: false`, because the WAL reader
and the bus puller make progress only while they hold a CPU. Bundling limits
that CPU to the life of the instance. The unit wakes together and sleeps
together, no CDC reader spins against an idle database, and the containers
reach each other on localhost.

## The first request

Nothing on a user's request path reaches daprd. The proxy routes no path to
it, and daprd's app channel points back at caddy. The wake comes from the
ticker instead ([its contract](../services/ticker/README.md#the-wake)). After
a sweep emits a tick, the ticker sends `GET /v1.0/healthz/outbound` to
`MESH_URL`, which is `mesh-events` and never another daprd. It advances no
watermark until that request lands. A clock outside the unit
([clocks](../services/ticker/README.md#clocks)) pokes the ticker. On a single
machine that clock is the `clock` service, an rpk `generate` input that posts
every `POKE_INTERVAL` (60 s by default). The cloud clock is among the ticker's
parts [not built](../services/ticker/README.md#not-built).

What bites:

- **Only a cluster that declares a schedule gets a ticker and a clock**
  (`len(state.schedules) > 0`). At cloud tier, a cluster with no schedule has
  nothing to wake its WAL reader, and its writes wait in the replication slot.
- **Below cloud tier the wake still runs, and a failed wake still holds every
  watermark.** A `MESH_URL` aimed at the wrong daprd therefore shows up as a
  DNS error on a laptop, not as a silent stall in production.
- **A wake drains everything the unit had backed up**, not only the tick that
  sent it.

## Managed equivalents

[Invariant 8](../README.md#8-portable-cloud-mapping) asks every stateful
component for a managed service on each major cloud. This is the mapping, not
what runs:

| component | single machine | AWS | Azure | GCP |
|---|---|---|---|---|
| PostgreSQL | `postgres:18` | RDS, Aurora, Neon | Azure Database for PostgreSQL, Neon | Cloud SQL, AlloyDB, Neon |
| the bus | Redis Streams on `redis:7.4` | SNS with SQS, ElastiCache | Service Bus, Azure Managed Redis | Pub/Sub, Memorystore |
| Kafka broker | Redpanda | MSK | Event Hubs | Managed Service for Apache Kafka |
| object storage | rclone-s3 over the local filesystem | S3 | Blob Storage through rclone-s3 | GCS through rclone-s3 |
| stream processing | Arroyo | Managed Service for Apache Flink | Stream Analytics | Dataflow |
| change capture | Conduit | DMS, or Debezium on MSK | Debezium on Event Hubs | Datastream |
| the services' compute | containers | ECS Fargate | Container Apps | Cloud Run |

Azure Container Apps has Dapr built in, so there the mesh is the platform's
rather than a container of the unit. Where managed Kafka is already paid for,
Debezium on it with Flink replaces the change path and the stream tier
together.

## Clouds, as built

mecha emits compose and nothing else. Its mesh image carries only the Redis
Streams component, and transform's pipelines read `redis_streams`. GCP is the
one cloud where this shape runs, as a consumer's production overlay: Cloud Run
services declared through Crossplane's GCP provider and deployed by skaffold
with the `sha256` tag policy. That overlay brings its own mesh entrypoint,
which writes a `pubsub.gcp.pubsub` component at start. It also brings its own
pipelines, whose input is `gcp_pubsub`. The processors are unchanged, and the
inputs are the tier's.

The overlay wakes the unit another way than [the first request](#the-first-request)
describes. Its daprd has public ingress and an `allUsers` invoker, and the
consumer wakes the unit by requesting that URL; CRUD goes to PostgREST's own
Cloud Run service. No ticker runs there. That is the user route to daprd this
document [rejects](#rejected).

| service | single machine | GCP, deployed |
|---|---|---|
| database | the `postgres:18` image mecha builds | Neon, with logical replication |
| caddy, crud, imgproxy | images | Cloud Run services |
| electric | image | Cloud Run, at most one instance, its storage on a GCS bucket volume, run with `ELECTRIC_INSECURE` |
| mesh-events, conduit, transform | three services | [the bundled unit](#the-bundled-unit), its daprd public |
| the bus | Redis Streams | Pub/Sub topic `cdc-events`, one subscription per pipeline, each with a dead-letter topic |
| rclone-s3 | the local filesystem | GCS through rclone's `google cloud storage` remote ([capabilities](capabilities.md#the-blob-plane)) |

Nothing runs on another cloud, and no stream processing runs on any cloud.

## What bites on Cloud Run

- **The publish path names the topic.** daprd publishes
  `/v1.0/publish/<component>/<topic>` to the Pub/Sub topic with exactly that
  name. Nothing maps one name to another.
- **A tag is not a deploy.** A revision resolves an image tag once, so
  redeploying the same tag pulls nothing new. Deploy by digest. Every base
  image `cluster.cue` and `bayt.cue` name is pinned by `sha256`.
- **A browser carries no Google identity.** Any service that the browser or
  the proxy reaches directly needs `roles/run.invoker` for `allUsers` and has
  to guard itself. The cluster's electric requires `ELECTRIC_SECRET`, which
  only the proxy adds ([the gate](proxy.md#routes)).
- **Neon keeps a slot active for a connection that died with the unit.** The
  next conduit then cannot take the slot. Terminate the stale backend and let
  conduit resume from the slot. Dropping the slot discards every change it
  retained while the unit slept.
- **Pub/Sub carries the same string as Redis.** daprd republishes conduit's
  flat row as the CloudEvent that
  [change capture](change-capture.md#the-record-on-the-bus) describes, with
  `data` a JSON string.

## Rejected

- **conduit and transform as services of their own.** Each would need its own
  wake or a warm instance, and a WAL reader kept at one instance burns CPU
  against an idle database.
- **The wake clock inside the unit**, such as an rpk `generate` input in
  transform ([clocks](../services/ticker/README.md#clocks)).
- **A user route to daprd, so that traffic wakes the unit.** daprd's publish
  endpoint has no inbound auth, so a public route would let anyone put events
  on the bus. The pipelines would also sleep whenever nobody visits.
- **Dropping a stale replication slot on wake.** It trades at-least-once for
  liveness: the changes the slot held are gone.
- **Turso/libSQL at the edge.** libSQL is a database of its own: it loses
  PostgREST, row-level security and the extensions the database image carries,
  and with them the tenancy floor and the one set of migrations every other
  tier runs. The browser cluster already runs those on PGlite, and an isolate
  can host it.
- **App Runner as the door on AWS.** It is closed to new customers.
- **Electric Cloud as the sync service's managed equivalent.** It wound down in
  August 2026.
