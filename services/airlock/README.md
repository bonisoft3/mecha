# airlock

Airlock handles external integrations. It is the one way out of a cluster:
a machine state *invokes* an effect; the
airlock performs it against the effect's sink and returns the answer as the
machine's next event. Like an airlock, it never has both doors open: the claim
commits before the call.

Its direction follows Camel's integration boundary: declared destinations,
transport adapters and routing. The built contract below provides restricted
effect handlers and sinks. [[../durex/docs/index|Durex]] owns internal durable
execution, retries and transactional completion for Cortex machines.

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
- [read.ts](read.ts): a read, an effect that is an HTTP GET: its request,
  got and its cache, and its outcome.
- [admit.ts](admit.ts): the admission alone, as pronto's `lint` runs it, so a
  handler the airlock would refuse fails before it is deployed.
- [dapr.yaml](dapr.yaml): the airlock daprd's configuration, the bindings API
  and nothing else.
- [[../activepieces/README|Activepieces runner]]: standard pieces in application container hatches.
- [[../durex/graphile.sql|Graphile's shared schema]], written by [[../durex/graphile_sql.ts|its generator]]
  (`task generate:graphile`): Graphile Worker's schema as one initdb step.

```sh
task test:airlock        # from libraries/mecha: the pure suites
task integrate:airlock   # postgres, Graphile, the cluster's daprd and a sink; needs Docker
```

pronto's `mecha-airlock.integration.test.ts` generates a bayt project holding
a cluster with two effects and boots the plane bayt lowers for it, below.

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
- `sink.fetch(path, {method, body, headers})` takes an absolute path in plain characters: no
  `%` before the query, no empty or dot segment. It answers `{status, body}`, the body
  parsed when the sink answers JSON. `headers` are the handler's own, such as
  tsbifrost's `X-Bf-Passthrough-Extra-Params`: names daprd forwards (uppercase first),
  never one HTTP or the host sets, and visible ASCII values (`sinkHeaders` in
  `reentry.ts`, which the edge airlock applies too).
- The host sends the request as an invocation of the effect's HTTPEndpoint on daprd,
  `/v1.0/invoke/<effect>/method/<path>`, with the handler's headers, the `Idempotency-Key`
  and the content type as its own. The endpoint's `baseUrl` is the declared origin, and
  daprd hands the body, the headers and the sink's status through unchanged, so a refusal
  is an answer. A credential the sink reads from a
  header is the effect's `credential: {header, scheme?, secret}`: the airlock reads the
  variable once and adds the header to every call, and the handler never holds it. A
  client certificate is not declared yet.
- A sink that takes no JSON declares `contentType`, and its handler sends the body already
  encoded, as a string, which arrives as it was sent.
- daprd's own failure is also a 500, told from a sink's by `errorCode: ERR_DIRECT_INVOKE`. An
  open breaker called nothing, so it ends the run, gives the ledger's count back and leaves the
  queue's backoff to bring the job again; it spends no attempt. Any other daprd failure may
  have reached the sink and counts as a throw. A breaker met after a call in the same run has
  reached the sink is a throw too.
- The third argument holds the values of the environment variables the effect declares
  in `secrets`, read by the host at startup and written nowhere, not the manifest and
  not the ledger; the cluster refuses to start the airlock without them. It also holds,
  under the field's name, the value of each `secretFields` entry: a secret field of the
  invoking row, which its writer typed (a PIN), opened in memory just before the call
  ([sealed values](#sealed-values)).
- What a handler answers or throws is recorded as it is: its answer in the ledger, its
  error in the queue and the log. A handler never puts a value of its third argument in
  either, as itself or transformed; one that does has it recorded.
- Past the language a handler reaches only what its effect declares in `endowments`
  (`../compute/language.ts`'s `ENDOWABLE`), as an omnishell module declares `Intl`: a
  handler that signs declares `Crypto`, WebCrypto's operations that are deterministic by
  their specification (`../compute/crypto.ts`), and `TextEncoder`; one that writes a PDF
  declares `Pdf` ([pdf.ts](pdf.ts)), and one that writes a spreadsheet `Xlsx`
  ([xlsx.ts](xlsx.ts)). An endowment it uses without declaring throws where it is used.
- A throw, or no answer within 60 seconds, is no answer.
- Bytes are answered as `{"$blob": {base64, type}}` anywhere in the answer (`blobs.ts`),
  or as `{"$blob": {bytes, type}}` with a `Uint8Array` a handler made itself, since the
  cage has no `btoa`: PNG, JPEG or WebP, or a PDF, which only the raw route serves. Before the outcome settles, the host stores each in the cluster's
  blob plane under its content key, `effects/<sha256 hex>.<extension>`, which a later
  effect reads with `sink.blob` once a row carries it, and the outcome carries the URL the plane
  serves it at: `/img/insecure/plain/s3://mecha-objects/<key>` through imgproxy in
  compose, written over the airlock daprd's `blobs` binding (dapr's S3 binding on
  rclone-s3); the same URL on the Worker's R2 bucket at the edge. Bytes never
  reach the ledger or a row: inline, a level's pictures outgrew the edge's in-memory
  database. A cluster with no blob plane refuses the answer.
- Bytes are read with `sink.blob(key)`, and only by a content key,
  `[effects/]<sha256 hex>[-<suffix>].<extension>` ([the record](../../docs/decisions/2026-11-05-content-addressed-blobs.md)):
  the host reads the plane (the same binding's `get`, R2 at the edge) and fails the run
  when the bytes do not hash to the key, so the input carries keys and a repeated run
  reads what the first one read. Bytes a handler puts in a JSON body are sent as base64.
- `sink.origin` is the release's origin, for a sink that links or calls back: the door's
  `ORIGIN` in a container cluster, `https://<domain>` at the edge. It never follows the host
  a request came by, so every run of a release names the same one; a release without one
  fails the run that reads it.

## A read

A read is an effect that is an HTTP GET, in effects.json's `reads` beside `effects`
(`parseReads` in [read.ts](read.ts)). It has no handler and no ledger row: a GET is safe
(RFC 9110 §9.2.1), so nothing is claimed before the call, no idempotency key is sent and
no count of runs ends in `unknown`. Like every effect it is a machine's: a screen asks one
by writing the row whose state invokes it, and sees the answer land in that row.

```json
"reads": {
  "rate": {
    "request": {"method": "GET", "path": "/rates/{currency}{?day}"},
    "invoke": {"table": "expense", "field": "status", "state": "pricing", "onDone": "priced", "onError": "unpriced", "row": ["id"], "count": "pricings"},
    "cacheControl": "max-age=3600",
    "credential": {"header": "Authorization", "scheme": "Bearer", "secret": "RATES_KEY"}
  }
}
```

- The path is an RFC 6570 template over the input: `{var}` a path segment, its value
  percent-encoded and refused where an octet would decode to `/`, `\`, `.` or `%`, and
  `{?a,b}` and `{&a,b}` the query. It is sent as `GET /v1.0/invoke/<read>/method<path>` to
  the airlock's daprd, the effect's `credential` added as a write's is.
- got sends it, with a fresh connection per read: on a kept-alive socket Deno's
  `node:http` sent a timed-out GET twice and got's timeout never fired. `got` in the
  manifest is got's own `retry` and `timeout` options, as far as JSON spells them; absent,
  two retries on 408, 429, 5xx and network errors, honouring `Retry-After` up to 5 s, and
  5 s a request. `READ_TIMEOUT_MS`, 20 s, bounds a read whole. got follows no redirect.
- The cache is RFC 9111's, in this process's memory, shared by every row's read: a
  thousand answers, none over 1 MiB and none without a `Content-Length`, each exact path
  in a partition of its own (got's key is the URL as normalize-url rewrites it, with no
  `utm_` parameter and a space as `+`), so a credential is never part of a key. As a
  shared cache it keeps no `private` answer and no answer to an authorized request unless
  the answer says `public`, `s-maxage` or `must-revalidate` (RFC 9111 §3.5).
  `cacheControl` is applied, in got's `beforeCache` hook, to an answer with neither
  `Cache-Control` nor `Expires` whose status RFC 9110 §15.1 lets a cache give a freshness.
- A row takes a new `incarnation` uuid at its insert, so one made again under a deleted
  one's key is another row. Entering the invoking state, which a request's anonymous role
  may not, adds one to the row's `count` column; no other write may change either column.
  It enqueues an `external_read` job `{effect, row, incarnation, n, key, input, digest}`,
  the input evaluated once: `n` the count, `key` `<effect>:<row's key>:<incarnation>:<n>`
  (the row's key as the ledger's), `digest`
  the MD5 of the input's text. Five runs at most. A 2xx is `{target: onDone, kind: done,
  data: <body>}`; any other answer `{target: onError, kind: failed, data: {status, body}}`;
  a run with no answer throws, and the last delivers `failed` with the error. A job
  Graphile gave up on is delivered `failed` with its last error at the next sweep, and
  completed.
- Delivery (`deliverRead` in [airlock.ts](airlock.ts)) is one transaction: it sets
  `airlock.read` to the outcome with the job's effect, row, incarnation and `n`, moves the
  row where it still waits in the state on that `n` in that incarnation, and writes `{key,
  effect, row, incarnation, n, digest, outcome}` to `airlock.read_journal`. The interpreter believes `airlock.read` only from
  the owner of the `airlock` schema, for that row, and skips an answer to another entry.
  An answer no row waits on any more, the job run twice or after its row was deleted and
  made again, writes nothing; the row is not deleted while it waits.
- The journal is replay's record of the world outside: a replay re-runs a row's
  transitions, reaches the same `n` and so the same key, and is answered from `outcome`
  (`replay: true` on the airlock: `journaled` in [airlock.ts](airlock.ts)), never asking
  the sink. The digest is a check: a key the journal holds under another digest, or does
  not hold, is a history that diverged, and the run stops there (`ReadDiverged`) rather
  than hand back an answer to another request; a replay settles no dead job. A row made
  again under a deleted one's key is another incarnation, so its keys are its own. The
  housekeeping sweep drops the entries of incarnations that are gone, which have no
  history left to re-run. The table is in
  [job_key.sql](job_key.sql), which also runs at every release (#AirlockUpgradeSql), so a
  database built before it takes it.

## Sealed values

A secret field (pronto's `#Field.secret`) is sealed by the page to the airlock's public key
([seal.ts](seal.ts)): RSA-OAEP with SHA-256 over a 3072-bit key, labelled with the table,
field and row it was typed for, as `seal1.<kid>.<ciphertext>`. Only that crosses the door,
crud and the database. The write's first trigger refuses anything else and leaves the
column NULL, and a trigger after the write keeps the sealed value in `airlock.secret`
under the row's key for five minutes. The airlock brings that table and `airlock_seal` at
its start ([seal-tables.ts](seal-tables.ts)), so a database that outlived a release needs
no migration. At a run the airlock reads it while unexpired and opens it with its private key; it
deletes it in the commit that records the outcome, unless another effect naming the field
still awaits its outcome for the row (claimed in the ledger, unsettled): the last of them
to settle deletes it, settles taking the value's row lock in turn. Housekeeping sweeps what
expired. A run that
finds none, or one that does not open (sealed to another row, to a key it does not hold),
settles `failed`, `{secrets, reason: "absent" | "unsealable"}`, when nothing was asked of
the sink before, and `unknown` when an earlier run may have reached it.

| | |
|---|---|
| `AIRLOCK_SEAL_KEY` | Base64 PKCS#8, required where an effect reads a secret field. The airlock publishes its public half in `public.airlock_seal` at start, which every client role reads through crud and none writes. `deno run seal-key.ts` prints a new one. No release makes one: it comes from the release's environment, or the target's secret store, and the airlock does not start without it. The local stack alone falls back to the repository's development key (`dev-seal.key`), which every release refuses. |
| `AIRLOCK_SEAL_KEY_PREVIOUS` | The key a rotation replaced, which still opens what was sealed to it. |

Only ciphertext is stored, so the table is logged: an effect in flight keeps its value
across a crash or a failover, and the WAL, a replica or a backup holds nothing that opens
without the key, which no database or program holds.

### Rotating the seal key

Set the new key as `AIRLOCK_SEAL_KEY` and the old one as `AIRLOCK_SEAL_KEY_PREVIOUS`, and
restart the airlock: it publishes the new public half, which a page reads at every seal,
and what was sealed to the old one still opens. After five minutes nothing
sealed to the old key is left, and `AIRLOCK_SEAL_KEY_PREVIOUS` is dropped. On gcp the old
key is a secret mapped as `GCP.airlock.secrets.AIRLOCK_SEAL_KEY_PREVIOUS`, by hand; on
cloudflare a publish whose environment carries both sets them on the dispatcher, beside
the object's new public half.

### At the edge

The edge's object keeps a sealed value in its instance's memory alone, never its storage,
the queue or its database: the write's crud request reaches the database without it, and
the claim hands it to the dispatcher Worker, which holds `AIRLOCK_SEAL_KEY` and opens it.
An eviction before the call loses it, which its effect meets as a value never written.
The object publishes `AIRLOCK_SEAL_PUBLIC`, `{kid, key}`, which the release sets beside
the dispatcher's key (pronto's `bundle/edge-seal.ts`).

## A bridge not deployed

An effect whose sink is a bridge carries where the bridge runs in `effects.json`
(`bridge: {name, targets, simulated}`): the release targets its container is
deployed on, and whether the local stack runs a simulator in its place. The
airlock knows its own target: `AIRLOCK_TARGET` in a cluster, which compose sets to
`local`, and `cloudflare` at the edge. An airlock told none refuses to start
where any bridge names its targets. Locally a bridge is deployed as its
simulator; on a release target, where it names that target: as a process of
the docker appliance, or as a Cloudflare Container of the edge's dispatcher
Worker, called through its binding
([container bridges](../../../../plugins/pronto/docs/container-bridges.md#targets)).
Where it is not, a claimed effect settles at once, before its run is counted:
outcome `failed`, data `{bridge, target, reason: "not deployed"}`, target
`onError`. Neither handler nor sink is called, the ledger's `entered` stays 0
and no dead letter follows (`undeployed` in [reentry.ts](reentry.ts)).

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
| `airlock-mesh` | Its daprd, holding one HTTPEndpoint per effect, the wall, and a breaker per endpoint (`#AirlockResiliency`). Declaring a policy turns off daprd's built-in retries, so a call is made once and `entered` counts every attempt; a sink's 4xx counts toward the trip, which no policy can filter. It runs under [dapr.yaml](dapr.yaml) and goes out on `airlock-egress`, a network nothing else joins. |
| Bridge container | `state.bridges` names an existing container target and its HTTP port (default 8080). The daprd waits on that target and calls `http://<container>:<port>`. Runtime lowering attaches the target to `airlock-out` and `bridge-<name>-egress`; it grants no default network, database credential or callback permission. |
| `011_graphile_worker.sql`, `012_airlock.sql`, `013_airlock_job_key.sql` | Graphile's schema; then the ticker's schedule table with its `airlock` row, the tables above and `airlock_wake`; then `airlock.job_key`, the ledger key's digest every enqueue keys its job by (Graphile caps a key at 512 bytes), and the read journal, staged in the database image. They take the first digits after the steps a caller opens with, so every caller step that can write a row, held seed included, runs after them and finds the table its interpreter re-arms ([the order](../../docs/schema.md#how-a-schema-reaches-the-database)). A cluster that also declares a schedule runs the schedule table's text again at 020, where every statement holds. |

**The wall keeps mistakes in.** Its purpose is that declared destinations are the
only ones reached by accident; it guards against mistakes in trusted code and is
not a security boundary. The airlock stands on the internal `airlock`
network with the database and its daprd, so it reaches the world
only through that daprd, and on `airlock-wake` with the ticker alone, whose
wake reaches its health port and nothing of its daprd. daprd forwards an
invocation whose target is a full URL, with no setting to turn that off, so a
`routerchecker` rule (`#AirlockWall`) passes only `/v1.0/invoke/<a declared
effect>/method/...`, the blob plane's binding and daprd's health, and `api.allowed`
removes every other Dapr API. It does not stop a deliberate `dapr-app-id` header on
an allowed path, which was measured reaching an undeclared host, and gRPC proxying
under that metadata was not settled. It goes out on `airlock-egress`, which nothing else
joins, and stands nowhere on the default network, where every other service
is, so no other service can call it and perform an effect with no
claim. Its endpoints are the program's
declarations, so what it reaches by accident is a declared endpoint. An origin is spelt as an https DNS name of two labels or more, which
refuses `database` and an address; a declared name that resolves inward is not
refused, since the daprd dials what its endpoint names, nor is a redirect a
declared sink answers, which daprd follows; those are the residual
pronto's record states. bayt writes no network, so a consumer
declares the cluster's `surface.networks` in its compose model; pronto writes
them to `compose.networks.yaml`, which every closure and the root include.

**A bridge is a container role.** The application supplies the target through
its container hatch. The role adds the internal `airlock-out` network shared
with the daprd and other bridges, plus `bridge-<name>-egress`. An explicitly
configured hatch network is preserved; an undeclared default network is not
added. The role does not confine the process or enforce its outbound domains.
A missing, removed or unbuilt target fails runtime lowering.

**One container holds them all in pronto's docker appliance.** The airlock, its
daprd and each docker bridge run there as processes on one loopback address
under their compose names, so the walls above are not there: the daprd's
bindings-only API and the airlock's `--allow-net` remain, and a bridge's own
destination policy carries the rest
([[../../../../plugins/pronto/docs/release-targets#docker|the docker target]]).

Mecha's `#ActivepiecesContainer` supplies the generic action runner. Pronto
instantiates it from a container hatch's `activepieces` definition and scopes
each bridge to one action alias. Applications select local or pinned catalogue
pieces and own their fixed inputs, contracts and credential references. See
[[../../../../plugins/pronto/docs/activepieces-hatches|Activepieces hatches]].
The optional [[../../pieces/mail/README|mail piece]] implements SMTP; no mail
transport knowledge is built into the runner. Past a bridge, as past any sink,
external delivery remains subject to the effect's reentry policy.

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
is repeated after a crash past the outcome, and it moves only the invocation
its ledger key names: a row whose key fields, as the guard spells the key
(`ledgerKeySql` in [reentry.ts](reentry.ts)), still make that key. A row no
longer in the invoking state, or back in it for another invocation, was moved
by the earlier delivery and then by the program, wherever that took it,
deletion included, and the delivery is done. Only a row still in the state
under this key refuses: its move was refused. The manifest carries each
effect's `key` fields for this.
