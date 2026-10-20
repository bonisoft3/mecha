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

Read metadata includes the shell schema's field references. PostgreSQL views
carry no foreign-key constraints, so their declared `ref` fields supply the
relationships for embedded reads, using each target's actual primary key.
Both snapshot and API joins still execute under the request's PostgreSQL role;
unknown or ambiguous relationships fail.

## Public snapshots for rendering

An `edgeObject` subclass can use its protected `readPublic(use)` method to render
public HTML. The callback receives `{ revision, read(path) }`; `read` accepts a
PostgREST GET path such as `/board?select=title`. It runs under `app_user`, with
only `public:` in `app.scopes` and no subject in `request.jwt.claims`. It creates
no guest and uses the same read planner and row policies as CRUD.
Shape metadata and change-notification triggers are initialized only on the
first API request, before any API write; anonymous SSR does not pay that cost.
An incomplete import raises `DataDirectoryLoading`; the HTTP renderer returns
503 with `Retry-After` and `Cache-Control: no-store` until the directory is ready.

The callback holds one read-only, repeatable-read transaction, serialized with
the cluster's other database operations. It can pass the reader to another
Durable Object over RPC and await rendering there. The reader is valid only during
the callback; the owner drains pending reads and revokes the reader before closing
the transaction. Any failed read rejects the snapshot, including
a failure the callback caught. Writes wait while a render holds the snapshot.

`revision` combines PostgreSQL's full `pg_current_snapshot()` value with the
data directory's persistent generation. Ordinary committed writes invalidate it;
resetting and importing even an older directory changes the generation. Read-only
transactions do not advance it. Boot-time DDL and unrelated writes may invalidate
it conservatively. This is a revision of MVCC data, not of clocks, randomness,
external services or sequence state. A renderer must account for any such inputs
separately, alongside its release, route, parameters and locale.

Every saved-document lookup must first obtain a snapshot revision. `readPublic`
does not change the existing HTTP routes or their caches. The native release
renderer and experiments are described in [[../../../../plugins/omnishell/docs/native-worker-ssr]].

## Machines

An app's machines (pronto's hybrid machines,
emitted by pronto's `mecha-reducer.ts`) step in the object. Their migration
declares each `hybrid_<name>.step` over a `hybrid_<name>.engine` it leaves to
the tier: PostgreSQL's is plv8, inside the migration's `-- tier: container`
fence; the object's is `pgl_step`, [PGlite for workerd](../pglite-workerd/README.md)'s
host import, which calls the step installed under `globalThis.__pgliteStep`
([`machines.ts`](src/machines.ts)). `edgeObject` takes the machines by name,
each an `execute` over the same rules and runtime PostgreSQL would run, which
pronto's `edge.ts` renders into the release as `src/machines.js`; the first
boot over a data directory creates `public.pgl_step` and each machine's engine
over it. A step's failure crosses back as a value `pgl_step` raises, so the
command's transaction aborts as it would under plv8, and a step that spends its
fuel is one such failure. Every step evaluates fresh rules and charges initialization
and the final fuel check, as plv8 does.

## The clock

A deadline a machine arms is a one-shot `schedule` row (`arm()` in pronto's
`mecha-ports.ts`), which the container tier's [ticker](../../services/ticker/README.md)
sweeps. Here it is the object's alarm ([`clock.ts`](src/clock.ts)): the alarm
stands at the earliest unconsumed `due_at`, set at boot and after successful
CRUD writes, and when
it fires the object writes the tick rows the deadlines owe through `/crud` as
the `service` role, as the ticker writes them, and the machine's `fire` trigger
takes the schedule and wakes the instance in that same transaction. Every
request's transaction runs serializable, the level a machine's `serial()`
demands: one connection, so the level costs no conflict. A cron schedule is
refused at boot; the edge runs no ticker.

A completed tick advances `last_tick_at` even when its trigger retains the
schedule. Completion uses the tick key’s millisecond resolution; rescheduling
within that same tick does not create another delivery. A failed schedule does
not stop the rest of the sweep. After reporting aggregate failures, the object
retains an alarm: overdue failures retry after 30 seconds, while earlier future
deadlines keep their wake time. This prevents one broken schedule from
stranding later work after the platform exhausts automatic retries.

Alarms do not boot an incomplete data directory. Reset deletes the alarm before
replacing the directory.

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
- **A guest's `GET /crud`** is kept 5 s, keyed by its URL and last write:
  a public-only read (every base table it reaches has `scope_id` generated as
  `'public:'`, executed under the `public:` scope alone) is shared across
  guests, while any other read is keyed by the guest's `sub`; writes advance
  both write markers.
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
  the shape triggers ([`shapes.ts`](../mecha-browser/shapes.ts)) on every
  boot, and the machines' engines on the first.
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

The same command also runs `test/public-snapshot_test.ts` against real PGlite:
public-only access without a guest, joins and aggregates, direct-write revisions,
concurrent writes, rollback, reader lifetime, and refusal of writes through a
read. The directory generation is additionally exercised by the two-Worker
experiment's reset and reimport check.
