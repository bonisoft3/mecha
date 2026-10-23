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
| `/import/*` | [`DataDirectory.importing`](../pglite-workerd/src/data-directory.ts), before PGlite opens; `/import/migrate`, the release's scripts over a directory kept ([`scripts.ts`](../pglite-workerd/scripts.ts)), while nothing else runs | `IMPORT_TOKEN`, checked by the Worker: an object kept awake keeps the secrets of the version it started on |

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

## Drains

The object calls an app's drains as their tables change, by the browser
platform's dispatcher ([drains and the clock](../../docs/browser.md#drains-and-the-clock)):
`edgeObject({ drains })`, the table pronto writes into the Worker from the
app's `.pronto/cluster.json`. The first request, sweep or render after a boot
installs them and calls each once, which is how a wake the evicted isolate
heard and never answered is recovered; a boot that only migrates installs
none, since the release's drains may name a table its migration creates. A
failed call's retry stands at the alarm, which calls it within the alarm, so
an eviction does not lose it.

## The clock

The object runs [the ticker's](../../services/ticker/README.md) sweep
(`services/ticker/sweep.ts`) over mecha's `schedule` table — a cron schedule
the cluster declares, or the one-shot deadline a machine arms (`arm()` in
pronto's `mecha-ports.ts`) — through `/crud` as the `service` role, as the
ticker writes it: the same keys, lateness rule, `Forbid` and watermark. What
differs is the clock, [`clock.ts`](src/clock.ts), and that nothing is woken
past the row: there is no change-capture unit here, the row is in the
database the sweep wrote it to, where a drain naming its table is owed and a
machine's `fire` trigger takes the schedule and wakes the instance in that
same transaction. Every request's
transaction runs serializable, the level a machine's `serial()` demands: one
connection, so the level costs no conflict.

Two clocks, as the ticker asks of every tier, and each tick's `caller` says
which minted it:

- **The alarm** stands at the next instant any unsuspended schedule owes a
  runnable tick (`nextOwed` in the ticker's `due.ts`: a deadline's `due_at`,
  a cron's first calendar occurrence after its watermark or, behind its
  lateness horizon, after that horizon) — set at boot, after a successful
  CRUD write (a machine's settle arms a deadline) and after every sweep.
  After a sweep, what is still owed at the sweep's own instant — a `Forbid`
  hold, a failed schedule, a backlog past the sweep's cap — is owed 30
  seconds later, never at once, or the alarm would sweep, decline and re-arm
  in a loop, and each sweep in a row that leaves it owed doubles the wait up
  to the Cron Trigger's hour; the occurrences a lost span left behind are
  recorded by whatever sweep runs next, never chased one wake at a time.
  The alarm stands at a failed drain's retry when that is earlier. With
  nothing owed the alarm is cleared, so a cancelled deadline boots
  nothing; a schedule row the ticker's `due.ts` refuses arms nothing and is
  reported by name on every sweep. The object
  sleeps between occurrences: a daily schedule costs one wake a day, which
  is what keeps an app with a schedule inside the Workers Free plan's
  duration budget (13,000 GB-s a day), where a minutely poke booting the
  object would hold it awake.
- **The Cron Trigger**, the clock outside the object. The Worker's
  `scheduled` handler (`worker.ts`) pokes `POST /poke?caller=cron-trigger` on
  the object, which answers the ticker's report; an app's release declares it
  where anything can owe a tick, a cron schedule or a machine's deadline. Its cadence is not the clock's
  resolution, which is the alarm's, but the bound on how late a tick can be
  where an alarm was lost — a sweep that failed is retried by the platform
  six times and then dropped, and a reset deletes the alarm — so it is
  hourly, a day of it costing 24 wakes and 24 of the Free plan's 100,000
  daily requests. A publish pokes once with the import's token
  (`POST /poke` on the Worker), so the clock starts at publish rather than at
  the first visitor.

A completed tick advances `last_tick_at` even when its trigger retains the
schedule; ticks and watermarks are kept to the millisecond, so a deadline
re-armed within the same millisecond is not delivered again. A failed
schedule does not stop the rest of the sweep: the report names it in the
object's log, earlier future deadlines keep their wake time, and the retry
above is the whole retry — a thrown alarm would add the platform's six rapid
reruns to it.

For a frozen archive, `edgeObject({ clock: 'disabled', ... })` runs no
clock: boot and alarm delivery clear any standing alarm but a failed drain's
retry, a poke is refused (409), and the schedule rows are kept as they were. The default is
`clock: 'ticker'`. Alarms do not boot an incomplete data directory. Reset
deletes the alarm before replacing the directory.

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
- **A migration keeps it.** `POST /import/migrate` with a release's scripts
  applies the ones the directory's ledger lacks, checkpoints, answers their
  names, and ends the object as a reset does, so the next request boots on
  the new schema under new shape handles; the Worker moves its cache keys as
  after a reset. A directory without the ledger, or one that applied a
  script the release has changed, answers 409 naming it.

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
eviction, and a reset of live data (503 while the new directory loads). It needs `../pglite-workerd/dist` (`just build` there); the harness installs
the ticker's `node_modules`, where wrangler's bundler finds the cron reader. [`test/clock_test.ts`](test/clock_test.ts) runs the
clock over real PGlite: deadlines, a cron schedule's occurrences and late
span, watermarks, retries; [`test/clock-object_test.ts`](test/clock-object_test.ts)
runs it in the object under `wrangler dev`: a failed deadline retrying while a
healthy one fires without requests, the Cron Trigger (`/__scheduled`) and a
publish's poke sweeping a cron schedule, and a frozen archive clearing its
alarms. [`test/drains_test.ts`](test/drains_test.ts) runs
[`test/drains-worker.ts`](test/drains-worker.ts): a row written before the
object listened drained at boot as the service role, a failed drain's retry at
the alarm, and a guest's write calling a mended drain at once.

The same command also runs `test/public-snapshot_test.ts` against real PGlite:
public-only access without a guest, joins and aggregates, direct-write revisions,
concurrent writes, rollback, reader lifetime, and refusal of writes through a
read. The directory generation is additionally exercised by the two-Worker
experiment's reset and reimport check.
