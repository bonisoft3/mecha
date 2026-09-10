# ticker

A periodic wake that survives scale-to-zero. One row, a derived key and a dumb
poke.

Four words carry the whole design, and nothing else is a concept:

| | |
|---|---|
| **clock** | The per-tier cadence source. Owns resolution and nothing else. |
| **poke** | A contentless authenticated HTTP request whose only job is to make a scaled-to-zero unit exist. Two of them: the clock pokes the ticker, the ticker pokes the mesh. |
| **tick** | One occurrence of a schedule, as a row in the app's own table, keyed `uuid5(schedule, instant)`. |
| **outcome** | Where a pipeline says it answered a tick. Keyed by the same tick, in a different table, because a source cannot be its own sink. |

`sweep` is the function that runs when poked. It is not a concept.

The argument and the measurements:
[`docs/2026-09-08-a-tick-needs-no-durability.md`](../../docs/2026-09-08-a-tick-needs-no-durability.md).
The design artifact it supersedes still records what was rejected and why —
dapr Jobs, a durable tick stream, fan-out inside the ticker — and is wrong in
eight places about what was built, which that doc lists:
<https://claude.ai/code/artifact/2155e549-4aa8-4712-9ff8-91c3be7fbfaa>

## The shape

Due-ness is a pure function of `(schedule, now, done)`, and everything a
caller is allowed to be careless about follows from that — the design doc
argues why. What it means here: a poke may be lost, duplicated, coarse or
doubled by a second clock, and none of those changes the answer.

- `due.ts` — the pure core: what a schedule owes at an instant. No clock of its
  own, no network. Its header lists the hard cases it decides.
- `main.ts` — the shell. Reads schedules from crud, writes the rows, advances
  the watermark, wakes the unit that reads the WAL.

```sh
just test          # from libraries/mecha; runs these alongside cue vet + buf lint
deno test --allow-read --allow-env .
```

## Contract

`POST /poke` carries no cadence, no schedule name and no payload. What is due is
never the caller's business. Authorised by the cluster's `SERVICE_JWT`, the same
credential every other write carries. `?caller=<label>` is diagnostic: it is
recorded on every tick, so when two clocks are running you can see which is
winning rather than infer it.

The answer is a report. It is `500` when any schedule errored or the wake did
not land — safe, because a retried sweep rewrites the same keys.

```
POST /poke?caller=cloud-scheduler
Authorization: Bearer $SERVICE_JWT

200 {"at":"…","caller":"cloud-scheduler",
     "schedules":[{"schedule":"sweep","emitted":1,"late":0,"held":0,"behind":false}],
     "poke":{"ok":true}}
```

Environment, all required — an unset one refuses to start rather than degrading
into a service that looks healthy and does half its job:

| | |
|---|---|
| `CRUD_URL` | PostgREST directly, not the proxy: the proxy's client-facing `Prefer` injection would clobber the resolution below. |
| `SERVICE_JWT` | Both the incoming poke's credential and the outgoing writes'. |
| `MESH_URL` | daprd's base URL. See **The wake**. |

## One table of mecha's, and the app's own

`schedule` is mecha's mechanism, emitted as `020_schedule.sql` and seeded from
the app's declarations. An app never authors it.

```sql
create table schedule (
  name                 text primary key,
  cron                 text not null,             -- five fields, the only grammar
  time_zone            text not null default 'UTC',
  suspended            boolean not null default false,
  max_lateness_seconds integer not null default 300,
  concurrency_policy   text not null default 'Allow'
                         check (concurrency_policy in ('Allow', 'Forbid')),
  done_entity          text,                      -- Forbid requires both
  done_filter          text,                      -- a PostgREST filter
  emits_entity         text not null,
  emits_values         jsonb not null default '{}',
  last_tick_at         timestamptz,               -- the watermark
  check (concurrency_policy <> 'Forbid'
         or (done_entity is not null and done_filter is not null))
);
```

`suspended` is `not null` because the sweep selects on `suspended=is.false`; a
null would silently drop the schedule.

**A tick is the app's row**, and there is no ledger beside it. The entity named
by `emits_entity` carries whatever the schedule declares plus five columns mecha
writes last, so a declaration can overwrite none of them:

```sql
id        uuid primary key,      -- uuid5(schedule, tick_at); see below
schedule  text not null,
tick_at   timestamptz not null,
late      boolean not null,      -- asked for nothing; a pipeline skips it
caller    text
```

A separate entity holds the **outcome**, keyed by the same `id` — separate
necessarily, for the reason in **A fan-out schedule** below. `done_entity` +
`done_filter` are how `Forbid` asks it whether the previous tick was answered.

Retention is not mecha's business. A tick table that should be trimmed declares
an ordinary predicate-driven pipeline to trim it, the way `apps/thenote` purges
notes — level-triggered, idempotent, and the app's own policy.

**Do not add `unique (schedule, tick_at)` to the tick table.** It looks like
belt and braces and it breaks idempotency: `resolution=ignore-duplicates`
resolves against the primary key, so a duplicate `id` comes back as `[]` with
201, while a *secondary* unique violation comes back `23505` with 409. Probed
against a live cluster. The derived id already is that uniqueness.

## What the mechanism guarantees

**The key is derived.** `uuid5(mecha-namespace, "<schedule>\n<tick_at>")`, and it
is the primary key of the tick row and of the outcome that answers it, so the
two join on it. A redelivery, a second clock and a retried sweep all write the
same row — see `tickId` for the normalisation that keeps two spellings of one
instant hashing alike.

**The write order is load-bearing.** Emit, record, wake, *then* advance the
watermark — see `sweep` in `main.ts` for why each boundary is where it is. Die
anywhere before the last step and the next poke recomputes the same ticks,
rewrites the same keys, gets empty bodies back and knocks again. Die after and
nothing is owed. It converges from either side, at the cost of a set of absorbed
duplicates instead of a transaction this layer cannot hold.

**`tick_at` is the instant the tick was scheduled for**, never the instant a poke
arrived. That is what makes redelivery recognisable, clock skew harmless, and a
coarse clock produce exact instants.

**Three bounds, all deliberate.** `TICKS_PER_SWEEP = 64` in `main.ts` is the most
work one poke does; the watermark moves by what was resolved, so a backlog
drains across pokes instead of running past the caller's deadline and repeating
forever. `WALK_CAP = 512` in `due.ts` guards a pathological expression.
`CALL_TIMEOUT_MS = 10_000` means a hung upstream fails the poke rather than
holding the pass open until something else kills it mid-write.

## Time, decided once

Each of these is pinned by a test in `due_test.ts`, because implementations
differ on exactly these cases.

- **The hour that does not exist** (spring forward). Never due. The guard asks
  whether an instant's local wall time is one the expression *names*, so it
  holds for `30 2,4 * * *` as well as `30 2 * * *`, and correctly admits 03:30
  under `30 * * * *` — that expression names 03:30 in its own right.
- **The hour that happens twice** (fall back). Fires once, at the first instant.
- **Ticks missed while nothing listened.** Older than `max_lateness_seconds` is
  written `late` and not run: a keep-alive forty minutes late is not a
  keep-alive. A pipeline reading the tick table skips those rows, and `Forbid`
  never waits on one — nothing answered it because nothing was asked. One entry
  per poke, so a long outage on a sparse schedule drains across pokes.
- **A run that outlives its cadence.** `Forbid` asks the `done_filter` whether
  the previous tick's row reached a terminal state and declines to emit while it
  has not, without advancing the watermark — so it delays rather than drops.
- **Delivery is at-least-once by design.** The derived key absorbs all of it.

## A fan-out schedule, end to end

The shape every keep-alive-like consumer wants: one tick, N rows, one row per
tenant. `apps/esocial`'s session keep-alive is the worked example, and the
numbers below are its measurements, not defaults to copy blindly — the portal
declares `tempoSessaoExpirada = 15` minutes with a warning at 14, and a bare
GET carrying the exported cookies renews it from outside any browser.

```cue
schedules: "session-keepalive": {
    cron:               "*/5 * * * *"   // three touches inside the 15m window
    maxLatenessSeconds: 300             // never wider than the cadence
    concurrency:        "Allow"
    emits: {entity: "SessionTouch", values: {status: "requested"}}
}
```

**Cadence 5 minutes against a 15-minute expiry.** Three touches inside the
window, so two can be lost before a session is. A cadence equal to the expiry
has no margin at all, and one at half leaves none for the fan-out's own jitter.

**`maxLatenessSeconds` no wider than the cadence.** A touch that arrives after
the next one was already due has defended nothing. At 300 a late tick is
recorded and skipped, which is the honest outcome: the session it was
protecting either survived on a later touch or is already gone, and running it
manufactures a success that hides the loss. **A late tick must be skipped by
the pipeline, not acted on** — it is a row like any other in the emits table,
wearing `late`, and the mapping opens by dropping those.

**`Allow`, deliberately, and this is the one that bites.** A missed touch is
harmless; a wedged schedule is not. `Forbid` holds the watermark until the
previous tick is answered, so one slow or broken tenant stops every subsequent
touch for every tenant — the failure mode is total where the risk was partial.
Reach for `Forbid` only where a second run would do damage.

**Jitter belongs beside the fan-out, never on the schedule.** Calendar cron
fires every tenant on the same instant, so the pipeline offsets each row by a
value derived from the tenant's own id — deterministic, therefore stateless and
reproducible. Keep it under 2 minutes: it is bounded by the lateness budget, and
a tenant whose offset exceeds it is dropped every single time, silently, and
always the same tenants.

### What the emits entity carries

`durability: "server"`, so CDC sees it, and `list.Concat([#tickFields, [...]])`
so mecha's five columns are there. Beyond them a fan-out tick needs nothing —
the tick names an instant, not a tenant. **Which tenants are live is a question
for the pipeline**, asked when it runs, against rows that may have changed since
the tick was minted. Putting a tenant list on the tick would freeze it at mint
time and reintroduce the fan-out this design moved out.

### What the outcome row looks like when the touch is a GET

The signal is thin on purpose: an eSocial touch succeeds when it is **not**
redirected to the login door. So the outcome is not "200 OK" — a login page is
also 200. It is the absence of a redirect, or the presence of a marker only an
authenticated page carries.

```cue
SessionTouchOutcome: {
    durability: "live"          // the publication excludes it; see below
    writers:    "pipeline"
    fields: [
        {name: "id", type: "uuid", pk: true, default: "uuidv7()"},
        // The tick answered, and never the key: a fan-out writes one row
        // per tenant per tick, and a shared key makes one upsert address
        // the same row twice.
        {name: "tick_id", type: "uuid", ref: "<the emits entity>"},
        {name: "employer_id", type: "uuid", ref: "employer"},
        {name: "renewed", type: "bool"},        // not redirected to the door
        {name: "checked_at", type: "timestamptz"},
    ]
}
```

One row per tenant per tick, naming the tick it answers, with
`uniques: [{cols: ["tick_id", "employer_id"]}]` and the upsert targeting that
pair (`?on_conflict=tick_id,employer_id`). `renewed: false` is the interesting row: the session lapsed and the next
operation needs a fresh challenge. Nothing retries a touch — the next tick is
five minutes away and recomputes the same answer.

The outcome must be `durability: "live"` and a **different entity from
`emits`**. That is not stylistic: the emits table is a CDC source, and pronto's
publication carries `server` and excludes `live` precisely so a pipeline cannot
feed itself the answer it just wrote. `#emit` refuses the two being the same.

### Reading a restricted table from the pipeline

The keep-alive needs each tenant's session cookies, and those cannot sit in a
`public-read` table. **This needs nothing from mecha.** The pipeline reads
PostgREST directly at `CRUD_URL` — never the gateway — carrying `SERVICE_JWT`,
and that token resolves to the `service` role, which holds `BYPASSRLS`. A
`service-only` entity is therefore readable by the pipeline and by nothing a
browser can reach: RLS denies `anon` and `app_user`, and the service role
bypasses it.

So the whole thing is the app's own declaration:

- the cookie store is an ordinary entity with `access: {mode: "service-only"}`
- the pipeline's `transform.aggregate` selects from it like any other table
- no grant, no policy and no mecha change is involved

`service-only` settles the query path and only the query path. **A row's
contents reach the bus whatever its policy says**: every `durability: "server"`
entity is in the publication, conduit reads it by logical replication, and
logical decoding answers to no RLS. So a credential in
a column is a credential in Redis and in every consumer group on `cdc-events`,
whether that column sits on the emits entity or on the restricted table beside
it. The emits entity only makes it worse, by putting it there on every tick
rather than on every write.

The way out is not a policy. Keep the credential out of Postgres: store it
wherever the app already keeps blobs and let the row carry its key, since a key
on the bus is not a credential. Where it genuinely must be a column, `live`
durability keeps it off this publication at the cost of putting it on
Electric's, which is the browser's sync path — a trade, not an answer.

## The wake

A row INSERT reaches PostgREST and never the bus, so the sweep knocks on the
door of the unit that reads the WAL — and the wake is an HTTP request, not a
publish. Above container tier daprd, conduit and transform are three containers
of one Cloud Run instance at `minInstanceCount: 0`, and only daprd holds the
ingress, so a request to daprd is what starts the other two.

Publishing to `/v1.0/publish/…/cdc-events` would do the opposite of what it
looks like: it puts a message on the bus and wakes neither puller, and every
emitted CDC pipeline opens by dropping a message whose `.data` is not a
non-empty string, so it would be discarded on arrival too.

The endpoint is `GET /v1.0/healthz/outbound`, dapr's own readiness, and
deliberately not `/v1.0/healthz`, which is scoped to the app rather than to
daprd's own outbound path. Verified in mecha's compose stack: a poke to
`/v1.0/healthz/outbound` answers 204 and is enough to wake the unit.

The two endpoints do not distinguish themselves the way an earlier reading of
them claimed; the measurement and what it leaves open are in the design doc.
The choice stands on `outbound` being the narrower one.

It fires only when the sweep emitted something, and no watermark moves until it
lands: a wake that fails leaves every schedule owing the same ticks, so the
retry rewrites the same keys and knocks again rather than stranding a durable
row nothing will read. On a unit pinned to `cpuIdle: false` a wake nobody needs
is a billed cold start.

Below cloud tier nothing scales to zero, so the wake delivers nothing: conduit
is already tailing the WAL and a tick reaches its pipeline whether or not
anything knocked. It is still required, and a failed one still holds every
watermark. That is the point. A wake aimed at the wrong sidecar is invisible to
the tests, invisible to the data — the rows travel regardless — and would
surface first in production, where it is the only thing keeping the pipeline
alive. Requiring it everywhere turns that into a DNS error on a laptop.

Because those containers rise together, a tick drains whatever the CDC path had
backed up, not merely the row it just wrote. An app with a schedule keeps its
own pipeline alive; an app with none has nothing waking that path at all.

## State

It runs. `#Schedule` declares an app's occurrences, `emit.cue` seeds the
`schedule` table from them, the app cluster gets a ticker whenever an app
declares one, and the compose tier has a clock. Verified against a live cluster
end to end: a poke writes a tick, the row travels the CDC path, a pipeline
answers it, and `Forbid` gates on that answer.

Its first consumer is `apps/esocial`'s session keep-alive, whose numbers are in
**A fan-out schedule, end to end** above. The other two cases that motivated
this — the lease reaper and the stale-claim sweep — that app designed away: a
conditional PATCH guarded on unheld-or-expired means the next claimer is the
reclaim, and neither needs a clock. Both were level-triggered, which is the
distinction worth carrying: a predicate to re-assert wants a guard at the point
of use, and only an occurrence at a named instant wants a tick.

What is not built: the k8s, host and cloud clocks, and the browser tier. The
cloud one is the only one esocial needs, and its contract is above.

One shape at every tier: a contentless `POST /poke` from something outside the
unit. What varies is only who sends it and how coarse it is. Deliberately not an
`rpk generate` input inside transform — a clock co-located with the unit it
wakes cannot wake it, and a dev tier shaped differently from prod in exactly
that way proves nothing.

| Tier | Clock | Resolution | State |
|---|---|---|---|
| docker compose | a `clock` service: rpk `generate` → POST | 60s (`POKE_INTERVAL`) | wired |
| k8s | one cluster-wide CronJob | 60s | not written |
| host (process-compose) | the same container | 60s | not written |
| cloud | Cloud Scheduler | 60s | not written |
| browser (wasm) | `setInterval` | ms | needs a different shell |

### The cloud clock, as a contract

Not written, because it cannot be exercised before the ticker has a URL. What
follows is the whole of it, so an app's own deployment can carry it without
deciding anything.

Declared beside the app's other Cloud Run resources — the same tree that holds
`crossplane-mesh.yaml` and `crossplane-pubsub.yaml` for `guis/iris` — as one
`CloudSchedulerJob`, cluster-wide rather than one per schedule. The moment
scheduler objects hold schedules, the missed and overlap policies belong to
Cloud Scheduler at that tier and to mecha everywhere else, which is the
one-behaviour-per-tier split this design exists to prevent.

```yaml
schedule:  "* * * * *"          # the floor; resolution, never cadence
timeZone:  "Etc/UTC"            # the tick's zone is the schedule row's, not this
httpTarget:
  uri:         "https://<app>-<hash>-<region>.run.app/poke?caller=cloud-scheduler"
  httpMethod:  POST
  body:        ""               # contentless: what is due is never the caller's
  oidcToken:                    # NOT the bearer, see below
    serviceAccountEmail: "<app>-clock@<project>.iam.gserviceaccount.com"
    audience:            "https://<app>-<hash>-<region>.run.app"
retryConfig:
  retryCount: 0                 # a lost poke costs resolution; the next recomputes
```

Three things it fixes rather than copies from the compose clock.

**`?caller=cloud-scheduler`.** Recorded on every tick this job mints. It is the
only way to tell which clock is winning during a tier migration rather than
infer it, and running two is safe by construction.

**Auth is OIDC, not the bearer.** The compose clock sends
`Authorization: Bearer $SERVICE_JWT` because everything inside the cluster
network already carries that credential. A Cloud Run URL is internet-facing,
and a permanently valid service token on a public path is a worse trade than
two auth mechanisms. So: Cloud Scheduler signs an OIDC token for its own
service account, the ticker's Cloud Run service is `--no-allow-unauthenticated`
with that account granted `roles/run.invoker`, and Cloud Run verifies the token
before the request reaches the container. **The ticker's own `SERVICE_JWT`
check then has nothing to verify** — it must either accept an
already-authenticated request at cloud tier, or the job must carry both, which
is the choice to make when this lands.

**`retryCount: 0`.** Cloud Scheduler's default retry would queue pokes behind
an unreachable ticker for no gain: due-ness is recomputed from the expression,
so the next minute's poke produces the same answer as the retry would.

The job must exist wherever `meta.tiers` names `cloud` and the app declares a
schedule — and `meta.clocks` is where the program says it does, which `#emit`
now refuses to compile without.

The binding floor is 60s, from Cloud Scheduler and CronJob. Local and compose
may be told to go finer, which is the dangerous direction: a schedule that
keeps pace on a laptop and never does in the cloud. The refusal that would
catch it is step 2 below and is not written.

At k8s, deliberately **one** CronJob rather than one per schedule: the moment
k8s objects hold schedules, the missed and overlap policies are k8s's at that
tier and mecha's everywhere else.

## Next steps

Ordered, and each independently landable. What is built is in **State** above.

**1. The cloud clock**, per the contract above, with esocial's deployment. It
is the only tier esocial needs, and until it exists the ticker fires nowhere
that matters.

**2. The remaining compile-time refusals.** These make the original class of
bug loud instead of silent. `meta.clocks` is done. Still to write: a schedule
finer than the finest declared tier's resolution, validated against
`meta.tiers` rather than the tier that happens to be running, or it passes
locally exactly when it matters least; `Forbid` without a `done`, which the
CUE conditional already requires but the seeded row does not re-check; a
schedule under `capabilities.server: false`, which has nothing to wake; and an
hour-pinning expression with no `timeZone`, because "3am" is not a time until
you say whose.

**3. An integration test** against a live cluster, alongside
`apps/*/tests/contract.test.ts`: a schedule seeded, a poke posted, one row
emitted, a second poke producing nothing. Everything this branch verified was
verified by hand, and none of it would catch a regression.

**4. The k8s and host clocks**, when a tier needs one. Both run the same
container as compose; only `?caller=` differs.

**5. Browser tier.** `due.ts` ports unchanged; `main.ts` does not — no Deno, no
daprd to wake, and crud is the wasm PostgREST-subset. Blocked on the first open
question below.

## Open

- Does the browser's PostgREST-subset implement `resolution=ignore-duplicates`?
  The whole idempotency claim rests on it. Real PostgREST is confirmed; the
  browser is a separate implementation, and if it differs, browser tier needs
  its own branch.
- Cloud Scheduler → wake → drain, measured end to end. Stand transform up at
  `minInstanceCount: 0`, confirm a `generate` pipeline does not run, then measure
  a POST waking it and the stream draining once.
- Five-field cron cannot say "last business day", which eSocial deadlines may
  eventually want. That is the moment to reach for RFC 5545 RRULE, and the
  ceiling is worth knowing before it is hit.
