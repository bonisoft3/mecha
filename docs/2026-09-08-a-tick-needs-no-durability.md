# A tick needs no durability

Built on this branch; the sequence at the end is its commit order. It
supersedes the design artifact
<https://claude.ai/code/artifact/2155e549-4aa8-4712-9ff8-91c3be7fbfaa>, which
is still the record of what was considered and rejected and is wrong in eight
places about what was built — those are listed at the end rather than left for
a reader to trip over. The operative reference is
`libraries/mecha/services/ticker/README.md`: contract, DDL, and how to declare
a schedule. This is the argument and the measurements.

The claim: **due-ness is a pure function of `(schedule, now, done)`, so a tick
needs no durability — losing one costs nothing, because the next poke
recomputes the same answer. Everything else falls out. The clock can be
stupid, two clocks can run at once without coordinating, a coarse clock
produces exact instants, and the only durable thing in the system is the row
the app already wanted.**

## The bug

A `trigger: "schedule"` pipeline compiles to a redpanda-connect `generate`
input inside the `transform` service. Above container tier `transform` is a
portless sidecar of a Cloud Run instance at `minInstanceCount: 0`. **A clock
inside the thing being woken cannot wake it.**

Every scheduled pipeline is therefore dead in the cloud, and dead *silently* —
nothing errors, nothing restarts, the work simply never happens. The original
failure was not that the clock was in the wrong place. It was that nothing
could tell.

## Facts not to re-derive

Measured against a live cluster, against Cloud Run and against the eSocial
portal on 2026-09-07 and 2026-09-08. Each cost a probe.

**PostgREST 12.2.3**

- `resolution=ignore-duplicates` answers **201 with `[]`** on a duplicate
  primary key. A *secondary* unique violation answers `23505`/409 — which is
  why the derived id must be the primary key and why
  `unique (schedule, tick_at)` must never be added beside it.
- `or=(last_tick_at.is.null,last_tick_at.lt.X)` is valid, and a conditional
  PATCH carrying it is a no-op when the stored value is newer.
- `select=late` answers `[{"late":false}]`, and `[]` for a row that is absent.
- A `tick_at` written as `…Z` reads back as `…+00:00`. Normalise through
  `Date` before hashing or every tick is emitted twice.

**Cloud Run scale-to-zero — the premise the whole feature rests on**

A throwaway two-container service, `minScale 0`, `cpu-throttling false`, one
container with a port and one without:

```
09:34:18  sidecar heartbeat        (last)
          3m12s of silence         instance gone
09:37:29  one request to the container holding the ingress
09:37:30  sidecar boots            1 second later
```

The portless sibling received no request. It started because the *instance*
started. Total request time 0.54s including the cold start. Idle scale-down
took ~3 minutes, not the ~15 minutes assumed.

**daprd 1.16.1**

- `GET /v1.0/healthz/outbound` answers 204 and is enough to wake the unit.
- With the app channel (`caddy:8080`) **stopped**, `/v1.0/healthz` *also*
  answers 204 — with and without `--enable-app-health-check`, which was the
  one hypothesis tried and rejected. The artifact's claim that it answers 500
  in that state is not reproducible here. The endpoint choice stands on being
  the narrower one, not on that distinction.

**Postgres grants**

`ALTER DEFAULT PRIVILEGES` in `002_grants` reaches every table created after
it, including mecha's own. Before the fix, `app_user` held SELECT, UPDATE and
DELETE on `schedule` and could repoint `emits_entity` and set `suspended`.
That is an escalation rather than a disclosure: the ticker reads those columns
and writes as `service`, which holds `BYPASSRLS`. `ENABLE ROW LEVEL SECURITY`
with no policy closes it — `app_user` sees 0 rows, `service` sees its 1.

**croner**

`n/step` means n to the end of the field: `5/10` in minutes is 5, 15, 25 … 55.
A parser reading a bare value as `lo = hi = n` matches only n, and the DST gap
check then discards the rest — silently, which is the one thing it exists to
prevent.

**eSocial, the first consumer**

The app session expires after 15 idle minutes (`tempoSessaoExpirada = 15`,
warning at 14). A bare GET carrying the exported cookies renews it from
outside any browser: nine touches at 5-minute spacing kept a session alive for
40 minutes after the last browser closed.

## What recomputability buys

Everything the design is allowed to be cheap about traces back to the claim.

**The clock can be stupid.** `POST /poke` carries no cadence, no schedule name
and no payload — only *look at the time*. What is due is never the caller's
business, so no clock owns a schedule, and there is nothing to keep in step
between the four of them.

**Two clocks are free.** They compute the same due set and the derived key
admits one row per tick. A tier migration needs no coordination, and "did
anyone configure the scheduler" stops being a single point of failure. The
only cost is money at cloud tier, where each poke is a billed wake, so one
diagnostic field earns its place: `?caller=` recorded on the tick, to see
which clock is winning rather than infer it.

**A coarse clock produces exact instants.** `tick_at` is the moment the tick
was scheduled *for*, never the moment a poke arrived. Measured: a clock poking
every 10 seconds against a minutely schedule produced exactly one tick per
minute, on the minute — six pokes, one tick, no duplicates.

**Delivery is at-least-once and nobody has to care.** Cloud Scheduler retries,
a nervous CronJob retries, a developer runs the curl twice. The derived key
absorbs all of it.

## The four words

`clock`, `poke`, `tick`, `outcome`. `sweep` is the function that runs when
poked; it is not a concept, and a vocabulary that makes it one has five words
where four will do.

Both HTTP calls are **pokes** — the clock pokes the ticker, the ticker pokes
the mesh — because they are one idea: a contentless request whose only job is
to make a scaled-to-zero unit exist. The README's table is the reference.

## Edge and level, and why two of three consumers vanished

The distinction that settled the most arguments here.

An **edge** is an occurrence at a named instant. It can be missed, it must not
double-fire, and it wants identity, a watermark and a lateness rule. That is a
tick.

A **level** is a predicate to re-assert: *make this false, repeatedly*. It
needs none of those, and running it twice is free. A level wants a guard at
the point of use, not a clock.

Three consumers motivated this work. `apps/esocial` designed two of them away
before the ticker landed, and was right to: the **lease reaper** and the
**stale-claim sweep** are both levels, replaced by a conditional PATCH guarded
on unheld-or-expired — the next claimer *is* the reclaim, so there is no
process to own and no clock to configure. `apps/thenote`'s `purge` and
`remind-due` are levels too.

The **session keep-alive** is the survivor and is genuinely an edge: a touch
that arrives after the next one was due has defended nothing, which is exactly
what `maxLatenessSeconds` expresses.

The lesson worth carrying: reach for a tick only when lateness changes the
answer. Most periodic work is a level wearing a cron expression.

## Where the artifact is now wrong

It is a good record of what was rejected — dapr Jobs (delivers to the app's own
endpoint, so the app must already be awake), a durable tick stream (persists
something reconstructible), fan-out inside the ticker (a resumable cursor and
an all-or-nothing bulk insert). Those arguments hold. These do not:

1. **`schedule_run`**, its second table. Deleted. A tick *is* the app's row,
   with mecha's five columns written last.
2. **`historyLimit`** goes with it. Retention is a level the app declares.
3. **`POST /ticks`** is `POST /poke`. The caller is not delivering ticks.
4. **`done: string`**, a filter over the *emitted* entity, is impossible: that
   table is a CDC source, and the publication is the loop breaker, so a
   pipeline cannot write the answer back to the table it read. `done` is
   `{entity, filter}` naming a *different* entity, and `#emit` refuses them
   being the same.
5. **`schedule:`** as the cron field is `cron:`.
6. **The compose clock** as an `rpk generate` input *inside* `transform` is the
   very shape this document opens by rejecting. It is its own container.
7. **`/v1.0/healthz` answering 500** with the app channel down — not
   reproducible; see above.
8. **Three esocial consumers** are one; see above.

Items 4 and 6 are not drift. They are things learned by running it.

## Not built

The k8s, host and browser clocks. The cloud clock exists as a contract in the
README rather than as code, because it cannot be exercised before the ticker
has a URL — and it carries one open choice: Cloud Scheduler signs OIDC against
an internet-facing Cloud Run URL, so the bearer the compose clock sends is the
wrong credential there and the ticker's own check has nothing left to verify.

Four of the five compile-time refusals. The one that is built is the one that
would have caught the original bug: a tier above container that declares a
schedule must name its clock in `meta.clocks`.

**The poke's credential is the database's.** `/poke` is routed on every app's
public gateway, and the only thing guarding it is `SERVICE_JWT` compared
byte-for-byte — the same token the ticker then uses to write as `service`,
which holds `BYPASSRLS`. So the secret that has to reach Cloud Scheduler, and
that travels on a public request, *is* cross-tenant write access. "One
credential, identical at every tier" is a real property and it is being traded
against a large blast radius. A poke-specific credential costs one env var and
makes a leak survivable; the cloud contract's OIDC answers it at that tier
only. Worth settling before esocial's deployment carries the token.

**`Forbid` degrades to `Allow` if a tick row is pruned.** `priorFinished`
reads an absent prior row as finished business, which is right for a late tick
and wrong for a deleted one — and a tick table is an ordinary app table an app
may well trim. Absence and "answered" should probably not be the same answer.

Known and unfixed: `TICKS_PER_SWEEP` bounds one schedule rather than the pass,
and a pass killed part-way commits no watermarks at all; a DST-skipped instant
stalls the late-branch drain; a schedule producing only late ticks never wakes
its reader; nothing checks that an emits entity carries `#tickFields`; and a
tick landing exactly on the lateness horizon is neither run nor recorded.

## The sequence

```
fe4f953c9  when a schedule is due, as a pure function
74ef1c267  a ping arrives carrying nothing, and what is due gets a row
da96c4d22  the tick wakes the unit that reads the WAL
9b0747baf  the gap check asks the calendar for every expression, not just two
3b41153ba  one ping does bounded work, and a failed sweep says so
ac405b0c8  what the ticker is, what it guarantees, and what is left
5f20bf3d4  a step is a range, and the gap check binds on both paths
b7e02b903  a tick is the app's row, and nothing is paid for until the wake lands
13c0fd20e  task test runs the ticker's tests
54ab6693a  four words, and sweep is not one of them
44051149c  the ticker runs as a container behind caddy
d297bed03  the wake goes to the sidecar that carries the CDC path
7b754f0c9  an app declares which occurrences it wants
d32d6f34e  an app that declares a schedule gets a clock
d62deaeb3  the compose tier has a clock
f74660f91  why the wake is required at a tier that does not need it
e2eb24424  the clock is a declared pipeline, not a shell loop
ac8d1ce2a  the schedule table is mecha's, and the grants said otherwise
8fb201d05  a cloud tier that declares a schedule must declare its clock
```
