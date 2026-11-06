# Durex

Durex executes durable functions for Cortex machines. Cortex chooses the
lifecycle, dependencies and scheduling policy; a task performs its computation;
Durex owns persisted invocations, delivery, retries, crash recovery and completion
receipts. Its current PostgreSQL adapter runs inside the compute service.

Temporal is the model for durable execution that survives a process. Airlock's
direction is the Camel model of external integration: declared destinations,
transport adapters and routing. These are responsibility boundaries, not claims
of either product's feature coverage. Durex currently provides keyed tasks and
transactional completion; it does not replay arbitrary function histories or
provide Temporal's workflow SDK. [[../../airlock/README|Airlock]] currently
provides declared sinks and restricted effect handlers, not Camel's connector
catalogue or routing DSL.

## Execution boundary

[[../work.ts]] exports three operations:

- `openWork(connectionString, spec)` registers an owner, task and singleton lock,
  recovers that owner's dead pools, calls `bootstrap(db)` before dispatch, then
  runs `task(payload, db)`. Its returned `promise` exposes worker failure and
  `close()` stops the worker before releasing its lock.
- `getWork(client, key)` locks the persisted invocation. A caller checks its
  outcome before repeating publication. The caller owns the transaction.
- `settleWork(client, key, kind, payload)` records an outcome and delivers the
  declared machine event in the caller's transaction. Publication, completion
  and receipt therefore commit or roll back together.

[[../work.sql]] owns the private `durex` schema: `worker` binds an owner to one
task and singleton lock, `pool` records its Graphile pools before jobs can be
locked, and `work` retains invocation input and outcome. A compiled state entry
calls `durex.enqueue_work` in its transition transaction. Exact duplicate
submissions preserve the first invocation; conflicting input fails. Cortex
requires a fresh invocation key whenever it enters the invoking state.

Graphile provides delivery and retry with one worker per owner, no ambient cron
and no prefetched local queue. A recorded outcome authorizes the completion
event. Repeating that outcome is harmless; a conflicting outcome fails. Recovery
releases only that owner's pools, and committed outcomes dispose of jobs left
behind before acknowledgment, including last-attempt deliveries. Unsettled
exhaustion fails visibly. Invocation receipts have no automatic retention policy.

Internal tasks can publish to their own PostgreSQL transaction. External calls
cross [[../../airlock/README|Airlock's boundary]], where a process can die after
the sink acts and before recording its answer. That path keeps its separate
external-effect ledger, handler cage, sink restrictions and reconciliation
semantics. A durable task is not permission to bypass those restrictions.

[[../graphile.sql]] is the shared Graphile foundation used by both executors.
[[../graphile_sql.ts]] renders it from the pinned Graphile migrations;
`task generate:graphile` refreshes it. Airlock owns only its external-effect
schema and execution policy.

## Upgrade from internal Airlock work

Fresh databases install Durex directly. Startup refuses the old internal-work
tables; it does not create an empty registry beside pending work. Existing
databases require an explicit migration while all internal task producers and
workers are stopped. External Airlock workers may remain running.

For the shipped compute machine, set `DATABASE_URL` to its database owner
connection and run from the repository root with the new sources:

```sh
deno run --config libraries/mecha/services/compute/deno.json --frozen \
  --allow-read --allow-env --allow-net --allow-sys \
  libraries/mecha/services/compute/migrate-durex.ts
```

[[../../compute/migrate-durex.ts|The compute upgrade]] checks the exact supported
old compiled-machine fingerprint, installs the new dispatcher and records its
new fingerprint. The reducer, instance revisions, retained inputs and machine
receipts stay intact. An unknown machine version fails instead of accepting a
possibly incompatible program.

Pending claims survive this namespace upgrade when the computation program and
captured-input contract remain the same. A deployment that also changes that
program or contract must first drain its old work, or provide a separate explicit
input-contract migration. The computation version check still rejects unfinished
inputs from an incompatible program.

[[../migrate.ts|The storage migration]] acquires every recorded owner singleton
lock and moves the three internal tables into `durex`, preserving their OIDs,
rows, constraints and Graphile job identities. It removes the old internal
routines; no compatibility aliases remain. It calls a supplied machine-upgrade
function in the same transaction and refuses to commit while stored routines
still reference the old internal tables or routines. Additional durable
machines need their own explicit dispatcher upgrades. The shipped adapter
supports the emitted SQL references; authored dynamic SQL must be reviewed by
its owner before migration.

Any failed check rolls back the schema move and dispatcher changes. After a
successful migration, start the new workers: they recover recorded dead pools
and continue pending inputs or clear already-committed deliveries. Never restart
an old worker after committing the migration. The external ledger and external
worker pools are untouched.

## Evidence

`task test:durex` checks actual SIGKILL recovery, coexisting workers, atomic
publication, redelivery, retry exhaustion, private-object grants and migration
rollback. The compute migration test runs the compiled PLV8 machine through an
upgrade with both a frozen pending claim and a committed last-attempt delivery.
The [[../../../../../plugins/pronto/compute/docs/index|compute coordinator]] is
the first consumer.
