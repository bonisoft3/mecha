# airlock

The one way out of a cluster. A machine state *invokes* an external effect; the
airlock performs it against the effect's sink and returns the answer as the
machine's next event. Like an airlock, it never has both doors open: the claim
commits before the call.

Why the design has this shape, what it rejected and what it measured, is
pronto's [external effects](../../../../plugins/pronto/docs/decisions/2026-10-03-external-effects.md).
This file is the contract.

| | |
|---|---|
| **ledger** | `airlock.external_effect_ledger` ([airlock.sql](airlock.sql)), in a schema only its owner may use: one row per effect performed, keyed `<effect>:<key fields>`, holding the instance's primary key, the input frozen at the claim, how many runs began, and the outcome. |
| **claim** | The interpreter's insert of that row, in the transition's own commit, with the Graphile job enqueued beside it only if the insert added a row. |
| **run** | One handler call. It commits `entered + 1` before it calls the sink. |
| **outcome** | `{target, kind, data, reconciled}`, `kind` being `done`, `failed` or `unknown`. Committed on its own, then the machine is moved to `target`; a crash between the two re-delivers the move alone. |

## The shape

- [reentry.ts](reentry.ts): the pure core. What a run does given the ledger's count and
  the effect's declaration, and the outcome an answer becomes.
- [handler.ts](handler.ts) and [cage.ts](cage.ts): a handler admitted, run in a fresh
  permissionless worker under compute's realm (`../compute/realm.ts`), and the only
  network it has.
- [airlock.ts](airlock.ts): Graphile's long-lived worker over the queue, and
  the process's liveness its crash recovery reads.
- [main.ts](main.ts): the shell. It loads, admits, holds its liveness and runs
  the worker.
- [admit.ts](admit.ts): the admission alone, as pronto's `lint` runs it, so a
  handler the airlock would refuse fails before it is deployed.
- [dapr.yaml](dapr.yaml): the airlock daprd's configuration, the bindings API
  and nothing else.
- [mail.ts](mail.ts): mecha's mail bridge, and [inward.ts](inward.ts), the
  address check it makes of the server it connected.
- [graphile.sql](graphile.sql), written by [graphile_sql.ts](graphile_sql.ts)
  (`task generate:graphile`): Graphile Worker's schema as one initdb step.

```sh
task test:airlock        # from libraries/mecha: the pure suites
task integrate:airlock   # postgres, Graphile, the cluster's daprd and a sink; needs Docker
```

`tests/airlock_test.ts` generates a bayt project holding a cluster with two
effects and boots the plane bayt lowers for it, below.

## Contract

Nothing calls the airlock. Its worker listens on Graphile's `jobs:insert`, which
`add_job` notifies when the interpreter's transaction commits, so an effect starts as its
transition commits, and a rolled-back transition wakes nothing. A retry follows
Graphile's backoff. Port 9997 opens once every handler is admitted and the worker
runs, for the cluster's healthcheck; it serves nothing. On SIGTERM Graphile returns
the jobs it holds and the process ends.

Environment, all required:

| | |
|---|---|
| `DATABASE_URL` | Postgres as the owner of the ledger and of `graphile_worker`. The ledger is closed to every other role, `service` included, and Graphile's migrate check, which runs at every start, alters its schema after an upgrade. |
| `MESH_URL` | The airlock's daprd. |
| `AIRLOCK_DIR` | The program's `services/airlock/effects.json` and the handlers it names. |

At startup the airlock parses `effects.json` and admits every handler, and it dies on
one it refuses; `admit.ts <effects.json> <dir>` runs the same admission and exits.

## A handler

`effects/<name>.js` in the program: one ES module, importing nothing, in compute's
language (no clock, no `Math.random`, no host time zone or locale). It exports exactly
`issue`, plus `reconcile` where its sink is not idempotent and reconciles:

```js
export async function issue(input, sink, secrets) {
  const r = await sink.fetch("/v1/charges", { method: "POST", body: input });
  if (r.status === 402) return { failed: r.body };     // the sink refused: onError, kind failed
  if (r.status >= 300) throw new Error(`${r.status}`); // no answer: retried, then unknown
  return { done: r.body };                             // onDone
}

export async function reconcile(input, sink) {
  const r = await sink.fetch(`/v1/charges?key=${encodeURIComponent(sink.key)}`);
  return r.status === 404 ? { absent: true } : { done: r.body };
}
```

- `input` is XState's word: the effect's `input`, frozen. `sink.key` is the ledger key, also sent as every request's
  `Idempotency-Key`.
- `sink.fetch(path, {method, body})` takes an absolute path in plain characters: no
  `%` before the query, no empty or dot segment. It answers `{status, body}`, the body
  parsed when the sink answers JSON.
- The host sends the request as a call of the effect's output binding on daprd,
  `/v1.0/bindings/<effect>`, with the path, the `Idempotency-Key` and the content type
  as the binding's metadata, so the host alone sets headers. The binding's `url` is
  the declared origin, and daprd answers the sink's status in `Metadata.statuscode`
  (the binding is declared with `errorIfNot2XX` off). A credential the sink reads from a
  header is the effect's `credential: {header, scheme?, secret}`: the airlock reads the
  variable once and adds the header to every call, and the handler never holds it. A
  client certificate is not declared yet.
- The third argument holds the values of the environment variables the effect declares
  in `secrets`, read by the host at startup and written nowhere, not the manifest and
  not the ledger; the cluster refuses to start the airlock without them.
- Past the language a handler reaches only what its effect declares in `endowments`
  (`../compute/language.ts`'s `ENDOWABLE`), as an omnishell module declares `Intl`: a
  handler that signs declares `Crypto`, WebCrypto's operations that are deterministic by
  their specification (`../compute/crypto.ts`), and `TextEncoder`. An endowment it uses
  without declaring throws where it is used.
- A throw, or no answer within 60 seconds, is no answer.

## After a crash

Graphile locks a running job under its pool's id, random per process, and on its own
treats the lock as abandoned only after four hours. Each airlock process holds a
session advisory lock under a random key for its whole life, on a connection the
process dies with, and records its pool against that key in `airlock.pool` before any
run begins. Postgres frees the key the instant that connection ends. Before the first
fetch, and whenever a fetch comes back empty, the airlock sweeps: a recorded pool whose
key it can take belongs to a process that is gone, so its jobs are unlocked through
Graphile's `force_unlock_workers`, `jobs:insert` is notified, and they run again at once.
A pool whose process lives is never touched, however many processes run. A process whose
liveness connection ends exits on the spot, since another may now take its jobs; what
remains is the moment between Postgres ending that session and the process hearing of
it, in which a call already begun can be met by a re-entry that does not see it. A process that crashes between creating its
pool and recording it holds no run yet, and what Graphile locked in that instant waits
out the four hours.

A run then reads the ledger:

| the ledger shows | the run |
|---|---|
| an outcome | delivers it again; the interpreter ignores a machine that already left |
| `entered` = 1 after its own increment | calls `issue` |
| more, and the sink is idempotent | calls `issue` again, with the same key |
| more, `reentry: reconcile` | asks `reconcile`; calls `issue` only on `{absent: true}` |
| more, `reentry: unknown` | settles `unknown` without calling |
| more, `reentry: repeat` | calls `issue` again; the effect's `note` says why a duplicate is acceptable |

The ledger's `entered`, not Graphile's attempt count, is what runs out: Graphile counts
a run when it locks the job and keeps that count across a crash and an unlock. A throw
is retried with Graphile's backoff while `entered` is below the effect's `attempts`,
and settles `unknown` on the last; a run the ledger counts past them settles `unknown`
without calling. The interpreter gives Graphile the effect's attempts plus 25 as its own
ceiling, so the queue never refuses a run the ledger still counts.

## In a cluster

A cluster places the airlock only where the program declares an effect
(`state.effects` in [cluster.cue](../../cluster.cue)), as it places the ticker
only where one declares a schedule. It brings two services, the ticker and
clock, two initdb steps, and crud verifying
the service token the ticker writes with:

| | |
|---|---|
| `airlock` | This service, FROM mecha's `airlock-image`, with the program's `effects.json` and handlers copied to `/airlock` and watched. Its own `--allow-net` is the database, its daprd and port 9997, the healthcheck's and the ticker's wake (`GET /healthz`). |
| `airlock-mesh` | Its daprd, holding one HTTP output binding per effect and nothing else: no Redis component and no resiliency policy, so a call is made once and `entered` counts every attempt. It runs under [dapr.yaml](dapr.yaml), the bindings API alone over HTTP and gRPC, and goes out on `airlock-egress`, a network nothing else joins. |
| Bridge container | `state.bridges` names an existing container target and its HTTP port (default 8080). The daprd waits on that target and calls `http://<container>:<port>`. Runtime lowering attaches the target to `airlock-out` and `bridge-<name>-egress`; it grants no default network, database credential or callback permission. |
| `011_graphile_worker.sql`, `012_airlock.sql` | Graphile's schema; then the ticker's schedule table with its `airlock` row, the tables above and `airlock_wake`, staged in the database image. They take the first digits after the steps a caller opens with, so every caller step that can write a row, held seed included, runs after them and finds the table its interpreter re-arms ([the order](../../docs/schema.md#how-a-schema-reaches-the-database)). A cluster that also declares a schedule runs the schedule table's text again at 020, where every statement holds. |

**The wall is the allowlist.** The airlock stands on the internal `airlock`
network with the database and its daprd, so it reaches the world
only through that daprd, and on `airlock-wake` with the ticker alone, whose
wake reaches its health port and nothing of its daprd. The daprd offers the bindings API alone, over HTTP
and over the gRPC it always serves: service invocation, which would forward a
full URL to any origin, does not exist on it, nor do state, pubsub, secrets,
metadata or shutdown. It goes out on `airlock-egress`, which nothing else
joins, and stands nowhere on the default network, where every other service
is, so no other service can call its bindings and perform an effect with no
claim. Its bindings are the program's
declarations, so the only traffic it can originate is a call of a declared
binding. An origin is spelt as an https DNS name of two labels or more, which
refuses `database` and an address; a declared name that resolves inward is not
refused, since the daprd dials what its binding names, nor is a redirect a
declared sink answers, which the HTTP binding follows; those are the residual
pronto's record states. bayt writes no network, so a consumer
declares the cluster's `surface.networks` in its compose model; pronto writes
them to `compose.networks.yaml`, which every closure and the root include.

**A bridge is a container role.** The application supplies the target through
its container hatch. The role adds the internal `airlock-out` network shared
with the daprd and other bridges, plus `bridge-<name>-egress`. An explicitly
configured hatch network is preserved; an undeclared default network is not
added. The role does not confine the process or enforce its outbound domains.
A missing, removed or unbuilt target fails runtime lowering.

Mecha's `#MailContainer` supplies the existing SMTP implementation as a reusable
target. Its `image` is the pinned Airlock image (or build reference), followed
by `server`, `tls`, `domain` and optional paired `user`/`password` environment
variable names. Install its `target` under the container hatch's name and point
the bridge at that name, port 8080. Its Deno permissions still admit only its
HTTP listener and declared SMTP server, and it refuses an inward connected
address before sending mail. Those are the mail implementation's guarantees,
not guarantees granted to arbitrary bridges. Past a bridge, as past any sink,
nothing is the platform's to promise.

**The wake is the ticker's.** Inside a running cluster the airlock is
reactive: it hears every enqueue at its commit. For a cluster scaled to zero,
the interpreter that enqueues also re-arms the ticker's one-shot row named `airlock`
([a one-shot row](../ticker/README.md#a-one-shot-row)); the next sweep emits a
tick into `airlock_wake` and GETs this service's `/healthz`, which is what
brings it up, and its first fetch finds what was enqueued meanwhile. An effect
therefore places the ticker and clock as a schedule does. `airlock_wake` is
closed to the cluster's client roles as `schedule` is, since a tick's instant
is when some tenant's row entered an invoking state.

**A dead letter is a row the machine sees.** A job Graphile gave up on with no
outcome (the ledger unreadable, the database away, past every retry) would
otherwise hold its row in the invoking state in silence; one it gave up on
with an outcome recorded still owes the move. At start and once a minute, the
airlock settles the first `unknown` with the queue's last error as the
outcome's `data`, moves the second, and prunes wake ticks older than a day;
Graphile's row stays as the record. Each key is its own attempt, so one the
sweep cannot settle is reported and tried again at the next.

**The move, delivered again, finds the row the program's.** An outcome's move
is repeated after a crash past the outcome; a row no longer in the invoking
state was moved by the earlier delivery and then by the program, wherever that
took it, deletion included, and the delivery is done. Only a row still in the
state refuses: its move was refused.
