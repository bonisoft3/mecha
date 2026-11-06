# Durable computations and portable values

[[../services/compute/main.ts|Compute]] separates capture, calculation and
publication. Its Cortex machine coalesces invalidations and retains a claimed
input across retries. [[../services/durex/docs/index|Durex]] dispatches durable
work and commits publication with the completion receipt. The SQL and WASM
stages execute outside the machine reducer;
the machine owns their durable lifecycle.

The executor lives in `services/durex/work.ts` and stores invocation receipts in
`durex.work`. Calculations are pure and publication writes the app's own
PostgreSQL transaction. [[../services/airlock/README|Airlock]] owns external
integration and its separate delivery and reconciliation contract.

A microbatch is a scheduling boundary. It need not correspond to a HOP or TUMBLE
window, which assigns rows to event-time groups. A correction to a historical row
can request a new batch without changing which time interval that row belongs to.

## Pure job reuse

[[../services/compute/workers.ts|The WASM runner]] automatically reuses successful
jobs across captures and service restarts. Its content key includes the exact
module bytes, WASI command name, exact JSON stdin bytes, execution-host sources,
and Deno/V8 version and target. JSON object ordering remains observable to a
command, so the runner does not rewrite stdin. Stable planner serialization
allows unchanged groups to reuse work; changed inputs, explicit seeds, binaries
or execution contracts produce different keys.

[[../services/compute/job-cache.ts|The cache]] stores original stdout JSON in
private PostgreSQL tables. It retains at most 100,000 results and 256 MiB of
UTF-8 payload plus 128 bytes per entry; this is a retention budget, not a limit
on PostgreSQL's index/WAL/disk footprint. Indexed least-recently-used eviction
also applies when reopening the cache. Oversized results still execute and
return normally without retention. Failed execution or invalid JSON never
creates an entry. Database failures fail the calculation; conflicting answers
for one identity fail instead of replacing an answer.

Results may commit before their batch publishes because the WASI host has no
external effects. Eviction only causes recomputation. Durex still owns retained
batch inputs, retries and the publication receipt; its invocation ledger is not
a content cache. Each planning round receives all answers in order before
dependent jobs are planned, and `finish` produces every sink's complete result
for the captured partition (or full snapshot in snapshot mode). Reusing jobs never skips source capture, freshness checks, sink
deletions or transactional completion. It supplies no ratings baseline when a
dependency is absent.

## Typed boundaries

[[../packages/client/src/types.ts|The portable value contract]] defines the
supported vocabulary and transformations. Each consumer supplies its type table;
Mecha does not import an application compiler or own a duplicate default table.

A computation specification can supply:

- `types`: one portable type table shared by its typed boundaries.
- `queryTypes`: complete result fields for selected named DuckDB queries.
- `sinkTypes`: complete fields for every owned sink when typed publication is
  enabled.
- `sinkWrites`: declared sink names mapped to `replace` (default) or `upsert`.
  Upsert preserves omitted IDs and treats empty output as no change. Native
  incremental publication also ignores disappearance deletes for those sinks.
  Both modes retain the same atomic publication and stale-run fences. Historical
  corrections update matching IDs; removals require explicit deletion or a
  reviewed rebuild.

The native reader also accepts an explicit `{types, fields}` boundary for a
query. [[../services/compute/portable.ts|The adapter]] reuses the lake's
projections before conversion to JavaScript, validates row shapes and values,
and adapts canonical bytes for direct PostgreSQL record conversion. Exact int64
and decimal values remain strings; timestamps retain microseconds. Query
declarations are checked even when no rows are returned. Retained inputs are
validated again on replay. Untyped queries retain the numerical API required by
existing WASM computations.

Feldera currently admits typed UUID results through VARCHAR carriers only.
Declared columns and physical carriers are checked before connecting; canonical
UUID values are checked again before calculation and replay. Other typed native
Feldera boundaries remain refused. This does not limit DuckDB typed transport.

Typed queries require compatible physical SQL types before projection. A
floating-point result cannot silently become an exact decimal or integer.
Applications make intended conversions explicit in SQL, including PostgreSQL
domains that the DuckDB extension exposes as text. Values outside the portable
contract, such as calendar-month durations or submicrosecond timestamps, fail.

All fifteen portable types have native transport fixtures: string, bool, int32,
int64, double, bytes, uuid, timestamp, date, time, timezone, duration, decimal,
json and geojson. Transport support is separate from any SQL compiler's supported
operators. Carrying GeoJSON does not provide spatial operations; carrying a
38-digit decimal does not admit that precision to every downstream SQL engine.

## SQL stages

Source PostgreSQL can normalize values through stored columns and maintain
constraints. Snapshot capture reads the declared source tables from one repeatable-read
snapshot. Native capture uses maintained Feldera deltas as described below.
SQL queries prepare retained inputs for the unchanged numerical module. The module plans WASM jobs and forms complete sink rows. Sink PostgreSQL
owns constraints and transactional completion hooks.

An additional SQL stage must make its inputs, outputs and invalidation
dependencies explicit. A named function that reads an undeclared table is not
automatically a captured dependency. Cross-engine work is not one distributed
transaction: retained inputs and idempotent publication provide recovery.
The current service does not execute arbitrary stage graphs. Its declared computation dependency graph and capture/calculate/publish
boundaries already cover the existing numerical pipeline.

[[../services/compute/portable_test.ts|Native tests]] exercise exact values,
schema refusal, replay and compatibility with untyped numerical queries.
[[../services/compute/portable.integration.ts|The PostgreSQL round trip]]
exercises source values, native DuckDB conversion and typed sink publication in
a disposable database.

## Cloudflare snapshot execution

The Cloudflare release uses the same admitted computation and numerical WASM
modules through private service bindings. [[../../../plugins/pronto/bundle/edge-compute.ts|The packager]]
builds two immutable companion Workers, each with its own Durable Object:

- The Query Worker materializes the retained capture in scratch DuckDB tables,
  inserts at most 32 rows per prepared JSON parameter, executes the declared
  queries and rolls the transaction back. Its DuckDB engine budget is 80 MB;
  this is not a cap on total isolate memory. Its pinned
  [[../packages/duckdb-workerd/docs/index|DuckDB runtime]] statically imports the
  engine, callback modules and JSON/ICU extensions; external access is disabled.
- The Compute Worker consumes those query results in a statically packaged SES
  cage and runs the computation's declared WASM jobs. It supplies no database
  publication authority. Separating these Workers also separates DuckDB's
  allocations from the pure execution realm and its WASM allocations.

Computations may declare a `steps` module for bounded Cloudflare execution.
Its `step(host, checkpoint)` receives read-only `query`, declared `wasm`, and
deterministic `seed` capabilities. It returns scratch SQL statements, sink
upserts, a JSON checkpoint and `done`. The static cage packages this module
with the computation; its compiled bytes participate in the execution version.
Pages and native execution retain the ordinary `plan`/`finish` module.

This path uses disk-backed DuckDB with a 32 MB engine budget instead of the
in-memory query path above. Each capture gets a separate Query Durable Object.
Immutable source relations transfer in chunks of at most 128 rows and 256 KiB;
query results, scratch relations, checkpoints and output remain in DuckDB.
Step queries, ordinary WASM inputs and commits have an 8 MiB limit. Private
WASM stdout may reach 16 MiB inside the Compute Worker; the computation must
compact or page it before committing. Golaberto retains only the odds fields
used by its finish stage in a checkpoint of at most 4 MiB, then emits pages of
at most 256 KiB. Restarting from that checkpoint does not repeat WASM.
A revision compare-and-set
commits each step's scratch SQL, output upserts and checkpoint together, then
checkpoints DuckDB so committed append buffers can be evicted. Replaying a
committed step returns its current state without repeating its writes.
`wasmFromQuery(name, input, {path, sql, orderBy})` fills an existing empty array
inside a small input envelope from an ordered SQL relation. The ordering column
must contain unique nonnegative safe integers; it is transport metadata and is
removed from the WASM rows. Each page is bounded to 4,096 rows and 1 MiB and is
fenced by the capture's execution revision. The host encodes directly into one
24 MiB byte buffer; it never assembles the complete row array or JSON string in
JavaScript. Overflow fails before WASM starts. The ordinary query, job, output
and commit limits remain unchanged. Retries rebuild the input and rerun the same
unmodified WASM; page transfer does not publish partial numerical results.

Physical ASOF joins partition equal keys into 64 hash buckets and union the
results. This trades repeated scans for lower peak memory; a single large key
can still exceed the engine budget and fails rather than returning partial
results. The disk-backed profile disables DuckDB's `window_self_join`
optimizer, which otherwise expands source uniqueness validation into a large
grouping and self-join before these partitions run.

The disk-backed profile also sets DuckDB's automatic checkpoint threshold to
1 MB. Its default 16 MiB WAL threshold allowed uncheckpointed import buffers
to exhaust the 32 MB engine budget before a checkpoint could allocate its own
working memory. Earlier checkpoints retain the same transaction and replay
semantics; they trade additional checkpoint IO for bounded import memory.

Scratch SQL permits table creation, literal inserts, restricted deletes and
drops only on execution-owned scratch tables. Each statement is prepared
separately before execution; transaction control, multiple statements and
protected metadata mutations are rejected. A statement cannot depend on a
table created earlier in the same step; create that table in a preceding step.
These bounds do not make arbitrary SQL or a single numerical job fit memory.

Generated modules may also export `queryStages`, a physical plan for selected
queries: ordered `{name, sql}` intermediate relations and the final `sql`.
The Feldera-plan translator emits these barriers after joins, aggregates and
shared views without changing expressions or the legacy query strings. Backward
column demand keeps only required fields in each physical stage, while retaining
predicate keys, grouping/distinct semantics and row cardinality. The
paged executor commits one stage and its cursor per call, checkpoints it, and
resumes that cursor after eviction. It drops intermediates when the final
result commits. JSON result and output payload columns use uncompressed storage
to avoid string-compression working memory exceeding the isolate budget.
Legacy snapshot engines continue using `queries`; numerical
modules retain responsibility for their declared input ordering.

The PGlite database object retains the [[../packages/compute-snapshot/docs/index|snapshot coordinator]]'s
transactional state: invalidations, immutable captures, Cortex state, retry deadlines
and publication receipts. A separate `ComputeCoordinator` Durable Object owns
computation alarms and calls the private Compute Worker. Private RPCs carry compact
capture identities; publication commits all sink differences and completion in one
database transaction. Snapshot and output bodies travel as streamed Responses, outside the
32 MiB serialized RPC message limit. Snapshot fetch and decoding failures count
against the retained claim; failure messages are truncated to 16,384 characters.
Generated Cloudflare deployments retain a physical PGlite image under the source
serializer after committing the claim. The filesystem cut copies node metadata;
copy-on-write preimages preserve blocks changed afterward. A `ComputeReader`
Durable Object in its own immutable Worker imports bounded encoded block pages,
opens the immutable database
image, and materializes ordinary logged heap tables in durable ranges of at most 256
PostgreSQL pages per call. Completed tables become readable only after every range
commits. This work runs independently of request serving. Transfer
cursors and materialized relations survive eviction. Publication or supersession
reclaims both the image and reader. Reset fences and reclaims retained readers
before replacing the source directory. Private PostgreSQL relations on the source
stage bounded output chunks. Sealing checks exact chunk and row
counts; publication applies all sinks with the completion receipt atomically.
Receipt reconciliation handles a lost publication response and reclaims the
capture's DuckDB object after publication or supersession within its owning
companion release. Progress and staged outputs carry that immutable Compute
Worker service name; another release starts its own transfer and cannot reuse
its output cursor.

The database object's alarm belongs only to schedules and drains;
requests do not await computation or its scheduling queries. The metadata snapshot
cut and publication serialize against database work; physical transfer, source-row
capture, query execution and pure computation run independently. This first physical
reader implementation transfers the whole database image for each capture, including
tables the computation does not read. It removes the long serving-database capture
transaction, but adds transfer time and duplicated storage. Publication still requires
one source transaction; snapshotting does not make that transaction incremental.

Execution and transport failures are recorded durably and thrown from the computation
alarm. Exhausted captures remain inspectable but have no runnable deadline. They
block only their declared dependents; unrelated computations, auth, CRUD, shape
streams and clock sweeps continue. A new source revision supersedes the exhausted
claim. Wake revisions prevent a notification arriving during an execution from
being lost when its alarm is rearmed. A database-generation token rejects results
from before a reset, even when the restored database reuses a computation revision.
Eviction retains pending captures for retry; successful completion releases them.
An hourly Cron Trigger recovers a lost wake notification, including when app
schedules are disabled. It reconciles retained invalidations, not source-table polling.

Worker names include the computation and execution-contract digest. The release
publisher deploys Query, Compute and Reader before updating the database and app
Workers that bind them. Reader has no binding back to the source; the source pushes
bounded pages through private RPC. Keeping Reader in a distinct Worker matters:
Durable Objects defined in the same Worker may share an isolate and its memory
budget. This default needs no Cloudflare Container. Pages keeps
its browser snapshot/export path, and native deployments keep their selected
DuckDB snapshot or Feldera engine.

Companion Workers are retained across deployments so in-flight work and rollback
bindings remain valid. Automatic garbage collection is not implemented. They
count against the account's Worker quota; operators must retire obsolete
companions only after confirming no retained deployment binds them and no work
is executing there. The coordinator preserves other releases' capture records
and ownerless records from older deployments. Its private `status()` RPC lists
them under `retainedPaged`, including the storage key, owning Compute Worker
service (or `null` when unknown), and capture identity. These records do not
block current computations. Rolling back to an owning release resumes its
pending work or reclaims its completed and superseded captures.

Reader imports have their own durable ownership ledger on the source. Its private
`computeReaders()` RPC lists each retained capture and immutable Reader Worker
name. The ledger survives source-directory reset. Cleanup touches only the bound
Reader owner; a redeployment cannot silently discard another release's imported
database. Rebinding the owning release reclaims its completed or obsolete imports.
Unbound reader records remain visible for manual retirement. Staged publication
releases the bound reader and physical snapshot after the receipt commits, without
waiting for another claim. A lost publication or cleanup acknowledgement retains
a coordinator wake; already committed work is not marked as failed.

Manual retirement must remove the obsolete companion's Durable Object storage
as well as its Worker deployment. An ownerless record requires identifying the
original deployment before applying the retirement checks above. Coordinator metadata remains visible
after manual retirement until explicitly removed through administrative storage
maintenance. A deployment change or a failed service request never acknowledges
retirement.

The database retains transactional job state; the coordinator
retains its independent alarm, failures keyed by computation and database
generation, and a separate coordinator transport/scheduling failure. A successful
publication clears only that computation's failure in the same generation; independent
success cannot hide an exhausted computation. A claim from a replacement database
generation retires the preceding generation's failure records.

The deployed acceptance checks used a Paid account. Removing Containers does not
prove Free-plan compatibility: the generated companions request a 300-second
CPU limit, and Free-plan quotas and admission still need a separate check.

This is full snapshot execution, not incremental SQL maintenance. A small seeded
demo and a whole historical archive have different capture, query, result and
numerical working sets. Every isolate has a
[128 MB memory limit](https://developers.cloudflare.com/workers/platform/limits/#memory),
including JavaScript and WASM; the limits of separate Workers cannot be pooled
for one oversized query or job. DuckDB's configured engine memory limit does
not include the entire isolate. Global ratings or high-cardinality aggregates
still require capacity measurements on their actual inputs; deployment support
does not establish archive-scale throughput or memory safety.

The native coordinator records the exact compiler output fingerprint. An upgrade
is admitted only between explicitly supported fingerprints and installs its SQL
in the same transaction as initialization and the new fingerprint. Failed
initialization rolls back the upgrade; frozen captures, jobs and publication
receipts survive compatible upgrades. Unknown versions require an explicit
schema migration.

## Query engines

`DUCKSTREAM_ENGINE` selects `duckdb-snapshot` (the default) or `feldera`.
Feldera mode requires `FELDERA_URL` and a generated `feldera` descriptor file
for every computation. The descriptor contains the authored SQL, projected
input queries and typed materialized output views. Its bytes and engine choice
participate in the computation version, so a deployment cannot reinterpret
retained inputs after changing engines. Computations without a descriptor keep
the existing snapshot contract.

`FELDERA_COMPILATION_PROFILE` accepts `optimized` (the default) or `unoptimized`.
Disposable test runners use `unoptimized` to reduce cold Rust compilation time;
the pinned container strips symbols for that profile before Feldera copies and
checksums its executables. These test binaries lack symbolic native backtraces.
Direct launches and production retain `optimized`. The profile changes compiler
optimization, not the computation version or retained-input contract.

Snapshot mode reads one repeatable-read PostgreSQL snapshot. Native mode uses
Feldera's PostgreSQL CDC connector. Row-local PostgreSQL projections maintain
private current-row carrier tables in the source transaction, including deletes
and truncation. These tables normalize UUID limbs, calendar values and numerical
carriers; they contain current state, not queued jobs. Installation fences writes
while backfilling once per computation version. Steady-state projection work is
indexed by the changed source key.

Each declared output maps rows to a computation partition. Feldera maintains
`stream EXCEPT ALL captured` and its inverse. The coordinator pauses input readers and reads every difference and validation
view in one query against a single consistent circuit snapshot. Pause alone does
not drain buffered work. It updates only affected retained partition inputs in
the claim transaction, then resumes and acknowledges that captured baseline.
Acknowledgment is after commit: a crash cannot discard uncaptured work. Pure
calculation uses immutable retained inputs while CDC continues accumulating the
next difference. Publication writes changed sink keys and commits partition
ownership, outputs and the Durex receipt in one PostgreSQL transaction. First
adoption reconciles legacy sink rows. A computation-version change repeats that
full reconciliation under the new sink policy, with its pending publication
retained across capture and restart. A sink key cannot belong to two
partitions. Indexed sink guards mark an owned partition for repair when a write
or foreign-key cascade changes its rows. Repair reasserts its desired rows;
equal live rows are not rewritten. Owned sink identities are immutable. Rows inserted by another producer
without partition ownership are outside this repair contract. This guard metadata is separate from source
ingestion and does not turn source tables into a work queue. The current Durex worker executes one computation at a time; changes continue
accumulating in Feldera while it runs. WASM job parallelism remains inside the
calculation runner.

Golaberto odds use phase partitions because game importance combines groups in
a phase. Ratings remain global; their numerical algorithm can require global
work. Plausible partitions visitor sessions, filter summaries and corpus counts.
The WASM algorithm and content cache are unchanged. Work is proportional to
changed relational outputs and affected computation partitions; a change to a
global dependency can legitimately affect every partition.

Native CDC connectors have independent per-table progress. The single capture
query gives a stable Feldera cut, **not a PostgreSQL-wide transaction-consistent cut**. A join
can transiently observe one table's committed changes before another table's.
This path provides the published connector's eventual relational semantics;
it is not admitted for computations requiring atomic multi-table source reads.
Sink publication is still atomic and retries cannot overwrite newer completed
work. pg_duckpipe independently feeds the lake and does not supply this runtime's
input frontier.

The singleton coordinator owns the pipeline. An OSS restart reconstructs source
state using fresh publications and replication identities, then restores the
last durably captured baseline. It does not reuse a consumed cursor with lost
relational state. Unchanged reconstruction runs no numerical calculation.
Retained claims finish with their original inputs. Owned old replication slots,
publications and obsolete carrier schemas are retired; unrelated resources are
preserved. Startup also retires removed or renamed computations from the ownership
registry, stopping their recorded pipelines before removing slots, publications,
carrier schemas and repair triggers. Registry records survive failed retirement
so the next startup can resume it. Epochs created before pipeline endpoints were
recorded require `FELDERA_URL` during retirement. New and reused carrier schemas
strip nonowner grants and enable RLS; owner-run replication and source triggers
retain access.

Source rescan and baseline transfer are restart costs, not per-batch
costs. Deleted historical events cannot be reconstructed from current rows.

This boundary admits booleans, strings, small/int/safe-number big integers,
finite doubles and UTC microsecond timestamps, including nulls. Typed native
UUID results use VARCHAR carriers. Other typed native boundaries remain refused;
DuckDB portable transport stays available. An unexpected incarnation or ambiguous
acknowledgment fails the service and requires reconstruction; no engine fallback
is implicit. PostgreSQL crash durability additionally requires durable database
settings: the local development stack's disabled fsync is not a production
exactly-once guarantee.

[[../../../plugins/pronto/bundle/derived.ts|Pages export]] selects DuckDB snapshot
mode and removes Feldera from its disposable computation stack. The exported
page contains derived rows; it does not host a native Feldera process.

The opt-in native regressions start isolated PostgreSQL and pinned Feldera
containers. From the repository root:

```sh
NATIVE_FELDERA_INTEGRATION=1 mise exec -- deno test -A \
  --config libraries/mecha/services/compute/deno.json \
  libraries/mecha/services/compute/native-feldera_test.ts \
  libraries/mecha/services/compute/native-capture_test.ts
```

They check restart and resource ownership, publication repair, and agreement
between detail rows and aggregates captured during concurrent source updates.
Set `FELDERA_COMPILATION_PROFILE=unoptimized` to exercise the native CDC runtime
regression with the test-runner compilation profile.
The capture regression also requires one HTTP SQL request for all relations and
validation checks, so asynchronous pause cannot reintroduce mixed snapshots.

### Feldera credentials

The generated PostgreSQL connector URI is always `${env:FELDERA_DATABASE_URL}`.
The pinned Feldera engine resolves it in its own process; pipeline SQL and API
program text contain no database password. Docker supplies the same URI as the
compute service. Kubernetes and GKE construct both from the same database Secret.
Feldera's administrative API remains private: secret references prevent accidental
program-text disclosure, but do not make an administrator an untrusted caller.
