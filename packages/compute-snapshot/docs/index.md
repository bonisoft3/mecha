# Snapshot computation

`createSnapshotCoordinator` coordinates PGlite snapshot batches using the injected
Pronto `compute_batch` Cortex reducer. It contains no runtime dependency on
Pronto, Deno, Node, or a query engine. `execute(snapshot)` belongs to the host.

All database access, including application writes, must use the host's shared
`serialize` chain. Execute runs outside that chain; application writes continue
while a captured batch runs. A host has one active coordinator. Stop its previous
coordinator before replacing its configuration.

## Host lifecycle

Create the coordinator after migrations, subscribe to PostgreSQL channel
`compute_snapshot`, and call `wakeAt()` to arm the next host timer or durable
alarm. On a notification, inspect `wakeAt()` again. At the scheduled instant,
call `resume()`, then rearm from `wakeAt()`, including when execution rejects.
Failures propagate to the caller after their retry deadline is stored.

Arm the durable alarm before awaiting execution. A claimed batch remains due
until its publication commits, so an evicted host resumes the same captured
input. Notifications contain table names but are only wake hints; the private
transactional inbox survives missed notifications. The coordinator never polls
source tables to detect changes.

Source triggers mark the inbox once per nonempty statement transition table,
not once per row. Empty inserts, updates, deletes and conflict no-ops do not
schedule work; truncation does. This keeps bulk publication from repeating
the same table notification for every output row. Trigger installation replaces
the older row triggers transactionally and removes triggers for retired sources.

`wakeAt()` performs durable scheduling and returns an absolute millisecond
deadline or null. It does not execute computations. `resume()` drains currently
due work and returns before future coalescing or retry deadlines. Repeated
`resume()` calls on one coordinator share its in-flight promise. `stop()` waits
for that promise and prevents further execution; the host removes its listener
and timer.

Remote hosts may use `claim()`, `snapshot(identity)`, `publish(identity, output)`
and `reject(identity, error)` without providing a local executor. `claim()` returns
only the capture identity. `manifest(identity)` returns column types and row counts;
`chunk(identity, table, after, limits)` exports retained rows using a stable numeric
sequence cursor. `snapshot(identity)` assembles the same chunks for legacy hosts.
Publication and rejection are fenced by the
active claim; a rejection received after a committed receipt cannot change it.
The Cloudflare host runs this protocol from a separate Durable Object and fences
cross-database-reset responses with the data directory's generation. Its RPC messages
carry compact identities; snapshot and output bodies use streams. Fetching or decoding
a snapshot is part of the claimed attempt, so transport failures retain retry deadlines
and errors just like execution failures.

## Capture and publication

Every computation declares a version, source tables, and exclusive sink tables.
All tables live in `public`. Cycles and multiple writers are rejected. Producer
batches finish before dependent snapshots are captured. Bootstrap schedules one
batch on first installation and on version change; reopening an unchanged
coordinator only resumes retained work.

By default, a capture copies every declared source into private typed PostgreSQL relations in
one claim transaction. No source rows pass through JavaScript during capture.
The relation's sequence and internal column names cannot collide with source
columns. A small manifest retains the original column names, types and row counts.
The first execution and retries read the same retained relations. Legacy JSONB
captures migrate transactionally when the coordinator opens. Column types use
PostgreSQL `format_type`; every non-null value crosses the transport as PostgreSQL
text. This preserves bigint, decimal, JSON numeric literals, and microseconds.
Temporal text uses UTC and ISO formatting. The executor must reject unsupported
physical types rather than guess conversions. Pending captures, reducer states,
retries, and receipts live in `compute_snapshot_private`, inaccessible to PUBLIC.
Export chunks contain at most 128 rows and 256 KiB of JSON row payload; callers
may request smaller limits. PostgreSQL checks encoded sizes before returning row
values, and an oversized row fails explicitly. `after` starts at zero;
`next` resumes after the returned rows and `done` marks the table's end. The
manifest and every chunk validate the full capture identity. `snapshot()` still
assembles all rows in memory and belongs only to hosts whose inputs fit.

A host may instead supply `retainSnapshot(identity)`. The coordinator commits only
claim metadata, then calls this hook before releasing the shared serializer. The
hook must durably retain the committed database image and reuse it on every retry;
a lost acknowledgement must never replace the image. The capture identity becomes
visible only after retention succeeds. If a crash precedes the first retained image,
the retry may include later writes; those writes also remain scheduled for the next
batch. The revision identifies scheduling coverage, not an exact source commit.

Open that image in an isolated database with the same computation declarations and
call `materialize(identity)` until it returns true. Each call copies at most 256 PostgreSQL heap blocks from one source (2 MiB
with the pinned 8 KiB block size). Typed target creation and its sequence index,
row insertion, and a durable block cursor commit together. Row sequences remain
contiguous across calls; completed source metadata becomes readable only after
its final range commits. Empty sources complete without a scan. Retrying after
an eviction resumes at the committed block cursor; removal and supersession
also reclaim partially copied relations. Reading an incomplete capture fails.

Physical range copying requires immutable ordinary logged PostgreSQL heap tables without
inheritance or partition membership. Views, materialized views, partitioned
parents, and inherited tables are unsupported. Unlogged tables are rejected
because PostgreSQL can reset their contents during crash recovery. The source relation identity,
file identity, and frozen block count must remain unchanged. The host must
prevent source writes, rewrites, refreshes, and maintenance that moves tuples
while materialization runs; CTID ranges belong to this frozen image. Large
TOAST values can exceed the heap-range byte size and remain subject to the
exported-row byte limit. Do not downgrade a reader with partial materialization
progress; finish or reclaim its captures first. Publication remains on the original database and uses the original identity
and receipt fence. External retention cannot be combined with a local `execute`.
The host owns image transfer, reclamation after publication or supersession, and
fencing/reset of retained readers when replacing the source database.

Successful publication deletes its capture relations in the receipt transaction; removed,
replaced, and superseded claims also release their captures. Receipts and a
per-name revision watermark remain after removal, so reinstalling the same
version cannot reuse an old execution identity or accept its late response.

Publication requires exactly the declared sinks and uniform row columns, unique
text IDs, and finite JSON values. Use strings for integers outside JavaScript's
safe range. PostgreSQL validates physical casts and canonical key uniqueness.
Generated columns, identity columns, `scope_id`, `txid`, and unknown columns are
not writable. Missing required writable columns are rejected. Upserts retain
omitted database-owned columns and skip unchanged rows. `sinkWrites` maps declared
sink names to `replace` (the default) or `upsert`. Replacement deletes absent IDs;
upsert retains them, including when the new output is empty. Upsert is suitable
for historical observations, not a current-membership snapshot. Removing a
previously published observation requires an explicit deletion or reviewed
rebuild; disappearance from a computation does not delete it.
Normal service-role triggers and optional `onComplete` run inside the same
transaction as all sink diffs, the durable receipt, and reducer completion.

Remote executors can return output with `outputChunk(identity, attempt, sink,
ordinal, rows)`, `sealOutput(identity, attempt, manifest)`, and
`publishStaged(identity, attempt)`. Output chunks have the same row and byte
ceilings, consecutive zero-based ordinals, and an attempt identifier. Identical
chunk replay succeeds; conflicting replay and duplicate IDs across chunks fail.
The seal names every sink with exact `{chunks, rows}` counts, including empty
sinks. Only sealed output publishes, using the same atomic sink diffs, completion
hook and receipt as `publish()`. Retained seals survive restart; receipt replay
cannot apply changes twice. Completing, replacing, removing or superseding a
capture also reclaims every unpublished output attempt.

Staged publication filters identical target rows before the insert. The conflict
update still checks equality, but that check alone would lock every conflicting
row, changing heap lock metadata even when no values change. The prefilter avoids
those writes; comparing the staged and target relations still requires reads.

These PostgreSQL relations are immutable input handoff and atomic publication
staging. The executor owns its intermediate data and numerical working storage.

Writes received while execution runs queue the following coalesced batch. They
do not prevent the current immutable batch from publishing. A replaced version,
obsolete claim, or existing receipt prevents a late response from publishing.
Failures retry the identical capture with bounded backoff; after `maxAttempts`
(default 25), the failure and capture remain recorded and that batch is excluded
from runnable work. Each failed execution rejects explicitly; inspecting a deadline
does not repeat the execution failure. Unrelated batches remain runnable.
Fix the executor or publication failure before resuming: a subsequent
source change supersedes an exhausted capture, or a new
version starts a fresh batch. A blocked producer also blocks its dependents.

## Validation

The coordinator runs a batch machine it is handed, and pronto compiles the one
it ships (`compute/machine.ts`), so the suite is pronto's:
`mecha-snapshot.test.ts` and `mecha-snapshot-materialize.test.ts` there run
that machine against PGlite, including publication rollback, replay, restart,
overlapping source writes, late responses and materialization in physical
ranges.
