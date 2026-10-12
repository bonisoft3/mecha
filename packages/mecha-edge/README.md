---
type: reference
title: The edge cluster
description: "mecha's cluster in one Cloudflare Durable Object over PGlite: signed guest sessions, row policy per request, Electric's shape protocol held open, and the Worker that routes to the object."
---

# The edge cluster

The [edge tier](../../docs/deployment.md#the-tiers) as built: one Durable
Object per app holds the app's Postgres ([PGlite for workerd](../pglite-workerd/README.md))
and answers the routes a container cluster's auth service, PostgREST and
Electric answer, for every user of the app.

## The routes

[`edgeWorker`](src/worker.ts) sends `/auth/*`, `/crud/*`, `/electric/*` and
`/import/*` to the one object, named `cluster`, and every other path to the
Worker's static assets (`ASSETS`). [`edgeObject`](src/object.ts) is the object's
class, given PGlite's assets and the tables that carry shapes:

| route | answers | needs |
|---|---|---|
| `POST /auth/guest` | a new `app_user` row and its session token | nothing |
| `GET /auth/whoami` | the session's subject | a session |
| `POST /auth/shape` | a shape token naming the table and the `where` the client must send | a session |
| `/crud/*` | postgrest-js, in a transaction carrying the subject's role, `app.scopes` and `request.jwt.claims` | a session |
| `GET /electric/v1/shape` | Electric's shape protocol ([`shapes.ts`](../mecha-browser/shapes.ts)) | a shape token whose `table` and `where` the request repeats |
| `/import/*` | [`DataDirectory.importing`](../pglite-workerd/src/data-directory.ts), before PGlite opens | `IMPORT_TOKEN`, checked by the Worker: an object kept awake keeps the secrets of the version it started on |

Tokens are HS256 under `JWT_SECRET`, with the auth service's claims and
lifetimes ([its contract](../../services/auth/README.md)): a guest's session
lasts 7 days, a shape token 900 s. Guests are the only sign-in; passkeys need
the auth service's ceremonies, which run nowhere here.

## The Worker's cache

Reads the object answered are answered again from the colo's Cache API, with
`x-edge-cache: hit|miss|bypass` saying which:

- **A shape response that is not live** is a prefix of its table's log under
  its handle, true whenever it is replayed: the client reads on from the
  offset it ends at. It is kept 300 s, keyed by its parameters (table, where,
  handle, offset, subset), the Worker's version and the object's epoch, the
  part of every handle a new object changes. The Worker learns the epoch from
  the handles responses carry, a `409 must-refetch` included, before answering
  it, so the refetch that follows never meets a chunk of the old object. It is
  served only behind a shape token the Worker verified for that table and
  `where`. A table whose every row is public by construction (`scope_id`
  generated as `'public:'`) is minted a `where` naming `public:` alone, as the
  auth service mints it, so its chunks are every guest's.
- **A guest's `GET /crud`** is kept 5 s, keyed by its URL, its subject and the
  time of that subject's last write, recorded before the write is answered.
- **Never** a live request, a write, a 4xx or 5xx, or a session other than a
  guest's.
- **The browser** keeps a shape response that is not live under Electric
  1.8's own `cache-control` — a week for a log read from its start, a minute
  (and five more stale) for any other — since Electric's client steps past a
  stale entry with `expired_handle` and a cache buster, which the Worker's
  key includes too. Everything else reaches the browser `no-store`.

## What fixes its shape

- **One connection, many subjects.** PGlite is one connection, so every use
  of it is one link of a promise chain, and a subject is never the session's:
  each `/crud` request sets its role, scopes and claims inside its own
  transaction, and a shape's reach is `subject_scopes` of the token's subject,
  read when the request is served. Row policy is Postgres's own, as on a
  single machine.
- **Nothing migrates here.** The object boots over the data directory a
  release loaded, rls.sql and the app's migrations already applied; it adds
  only the shape triggers ([`shapes.ts`](../mecha-browser/shapes.ts)), on every
  boot.
- **Live sync holds requests open.** A live shape request waits up to 20 s on
  the object, which keeps it awake while a tab is open. Once none is waiting no
  timer is pending, and the platform may evict it.
- **The shape log lives in the isolate.** A new object, after an eviction,
  `ctx.abort()` or a change the log lost, starts a log under new handles, and
  a client holding an old one is told `409 must-refetch` and starts over from
  a snapshot. Sessions outlive it: they are signed, not stored.
- **A boot that fails aborts the object**, so the next request meets a fresh
  one rather than the failure. Until a load completes there is nothing to
  boot over, and the cluster's routes answer 503.
- **A reset replaces live data.** `/import/reset` on an open object drops its
  directory and ends the object once the answer is out; the load that follows
  is a release's like any other.

## Test

`just test` runs [`test/cluster_test.ts`](test/cluster_test.ts) against
[`test/worker.ts`](test/worker.ts) under the pinned `wrangler dev`, over a
fixture ([`test/fixture.sql`](test/fixture.sql)) loaded as a release loads a
data directory: the import's token, refusal without a session, two guests
each reading only their own rows, a shape under its token's predicate, a
held-open request answering with a write confirmed by its `x-txid`, no pending
timer, the Worker's cache (a public table's chunks shared, live never kept,
a guest's read giving way to its own write, a new object's chunks replacing
the old one's), the object resumed after `ctx.abort()` and after an
eviction, and a reset of live data (503 while the new directory loads). It needs `../pglite-workerd/dist` (`just build` there).
