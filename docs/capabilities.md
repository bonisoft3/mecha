---
type: concept
title: Capabilities
description: The switches in cluster.cue that add planes to a cluster — data, change feed, auth, blobs, schedules — and what mecha's own stack runs beside them.
---

# Capabilities

A cluster (`#Cluster` in [`cluster.cue`](../cluster.cue)) states its
capabilities, and each one adds a plane of services. The consumer states what
it needs in its own cluster, not at `up`, and the `launch` target waits on
exactly what those capabilities instantiate. The planes layer as
[invariant 7](../README.md#7-additive-capabilities) states.

## The switches

| capability | default | instantiates | also |
|---|---|---|---|
| `server`, the data plane | on | database, crud, electric | Off, caddy runs alone and serves statics, for a consumer that stores nothing server-side |
| `capture`, the change feed | on where the cluster is given a pipeline or a schedule, off otherwise | redis, mesh-events, conduit; transform when a pipeline is given ([change capture](change-capture.md)) | Refused off where it is given one: the pipeline would never run, and the ticker's wake is addressed to mesh-events. Stated on, it runs without either. Turning it on turns `server` on |
| `auth`, the auth plane | off | auth: WebAuthn, minting `app_user` JWTs ([its contract](../services/auth/README.md)) | crud verifies tokens (`PGRST_JWT_SECRET`) and transform is handed `SERVICE_JWT` ([routing](change-capture.md#routing)). Turning auth on turns `server` on. The `auth_uid()` a policy reads the token's subject with is the tenancy floor's, in every database |
| `blobs`, the blob plane | off | rclone-s3, imgproxy | |
| a name in `state.schedules` | none | ticker, clock ([its contract](../services/ticker/README.md)) | The database gets `schedule`, the table they sweep ([its step](schema.md#how-a-schema-reaches-the-database)), and `capture` turns on. Set by declaring a schedule, not by a flag |

## The blob plane

**rclone-s3** is rclone 1.71.0 running `rclone serve s3` on `:3900` over
`/data`, which is the image's command. Each top-level directory is a bucket.
The entrypoint creates `RCLONE_LOCAL_BUCKET` (`mecha-objects`) at start. The
store has no auth keys, so it accepts any credentials. It mounts no volume
either, so its objects live on the container's writable layer: recreating the
container empties the bucket, just as recreating the database empties the
database. For a cloud bucket, run the same rclone with the command naming a
remote instead of `/data`. On GCS that is `gcs:` with
`RCLONE_CONFIG_GCS_TYPE="google cloud storage"`, which serves every bucket
the service's identity can see as an S3 bucket of the same name
([as deployed](deployment.md#clouds-as-built)).

**imgproxy** v3.31.1 listens on `:8081` and reads its sources over S3 from
`http://rclone-s3:3900`. It is given a placeholder key pair, because its S3
client insists on one, and region `rclone`. It caps a source at 50 megapixels
and passes the source's `Cache-Control` through. An image URL names its source
as `s3://mecha-objects/<key>`. No signing key is set, so imgproxy checks no
signature, and consumers write `insecure` in the signature segment.

**The routes** live in the consumer's Caddyfile ([routes](proxy.md#routes)).
`/blobs/*` goes to `rclone-s3:3900` and `/img/*` goes to `imgproxy:8081`, each
with its prefix stripped. A Caddyfile that keeps these routes while the plane
is off answers them with 502. mecha's own Caddyfile routes `/img` only.

What bites:

- **Nothing on the plane authorizes.** Anyone who reaches `/blobs` can list,
  read, overwrite and delete every object. Anyone who reaches `/img` can make
  imgproxy fetch and transform any of them.
- **A blob is outside the database.** No row-level policy covers it and no
  change is captured for it. A row carries the object's key, and a key is safe
  to put on the bus where a credential is not.
- **`task integrate:blobs` asserts only imgproxy's health.** Its PUT and GET
  against rclone-s3 cannot fail the suite, and it drives neither route through
  the proxy.

At browser tier, `rclone-js` answers the same S3 subset over IndexedDB
([the browser platform](browser.md#what-stands-in-for-what)).

## Beside the cluster

`#Cluster` has no switch for two things mecha's own stack
([`bayt.cue`](../bayt.cue)) runs next to it:

- **Stream processing**: redpanda, `kafka-fanout` (a second rpk pipeline
  teeing `cdc-events` onto Kafka) and Arroyo
  ([streaming joins](streaming-joins.md)).
- **The AI gateway's seat**: `bifrost`, a busybox that holds port 8090. No
  gateway runs there. At browser tier, pipeline calls to a model URL are
  answered in the page, by the models its embedder supplies
  ([the browser platform](browser.md#what-stands-in-for-what)).

Both come up on a bare `up`, not as manual targets.

## Rejected

- **Garage as the object store.** Garage is a distributed store of its own. It
  needs a layout, an RPC secret, and a bootstrap container that creates the
  bucket and key before anything can write. rclone is one binary with no state
  of its own: it fronts the local filesystem in development and the cloud's
  own bucket in production.
- **Compose profiles per plane** (crud, sync, cdc, stream, blobs). The person
  typing `up` chose which services ran. A capability is stated in the
  consumer's cluster, so what a consumer needs travels with its source.
- **Stream processing and the AI seat as manual targets.** A wait on a manual
  target's service is a wait on nothing.
