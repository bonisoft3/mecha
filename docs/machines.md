---
type: concept
title: State machines
description: Trigger-driven statechart reducers inside PostgreSQL — deterministic transitions, relational effects, timeouts, and ticker sweeps.
---

# State machines

mecha executes state machines inside PostgreSQL. When an entity carries a
lifecycle — challenge lobbies, turn clocks, wager settlements, or ledger
workflows — the statechart reducer runs synchronously in the database during the
`BEFORE UPDATE` or `BEFORE INSERT` trigger phase of the write transaction.

An illegal transition raises an exception and rolls back the write. No invalid
state ever lands on disk, on the sync shape (Electric), or on the WAL
([change capture](change-capture.md)).

```
User / API write ──► PostgREST / CRUD ──► PostgreSQL
                                              │
                      ┌───────────────────────┴───────────────────────┐
                      │  BEFORE INSERT / UPDATE Trigger Reducer       │
                      │                                               │
                      │  1. Check transition (OLD.status ─► NEW.status)│
                      │  2. Verify guards & timeout bounds            │
                      │  3. Execute Level-3 Relational Effects        │
                      │     (create, ensure, upsert, accumulate,      │
                      │      update, delete, call, notify)            │
                      └───────────────────────┬───────────────────────┘
                                              │
                                              ▼ Committed WAL
                                       Electric / Conduit
```

## The execution model

A state machine governs a single column (by convention `status`) on an entity
table. Its definition derives four database objects:

1. **Check constraints**: Restricts the column strictly to declared states and
   constrains initial insertions to declared initial states.
2. **Transition guard**: A `BEFORE UPDATE` trigger function that compares
   `OLD.status` to `NEW.status`. Only transitions explicitly declared on the
   active state are permitted. Any undeclared transition immediately executes
   `RAISE EXCEPTION`.
3. **Relational effects**: Level-3 SQL side effects that execute inside the same
   ACID transaction before the row is committed.
4. **Timers**: Entering a state with `after` arms a one-shot schedule the
   ticker delivers; the tick takes the timed transition.

## The grammar and relational effects

State machines declare deterministic side effects that run inside the transition
boundary. Because effects run before commit, any failure rolls back the entire
state transition:

| effect | operation | SQL execution | purpose |
|---|---|---|---|
| `create` | Append | `INSERT INTO <table> (...) VALUES (...)` | Appending immutable audit or ledger records. |
| `ensure` | Idempotent insert | `INSERT INTO <table> (...) VALUES (...) ON CONFLICT DO NOTHING` | Guaranteeing existence of dependent records without duplicate errors. |
| `upsert` | Replace | `INSERT INTO <table> (...) VALUES (...) ON CONFLICT (<pk>) DO UPDATE SET ...` | Updating child or summary records keyed by primary key. |
| `accumulate`| Aggregation | `INSERT INTO <table> (...) VALUES (...) ON CONFLICT (<group>) DO UPDATE SET count = count + 1, sum = sum + EXCLUDED.amount` | Incremental materialized views and ledger totals without separate workers. |
| `update` | Absolute update | `UPDATE <table> SET ... WHERE <predicate>` — the rows `where`/`rawWhere` name, else the row the values' key names, else every row | Patching a sibling row's columns to stated values, keyed by the row and not by a conflict. |
| `delete` | Cascade/Prune | `DELETE FROM <table> WHERE <predicate>` | Cleaning up transient child records upon terminal state. |
| `call` | Stored procedure| `PERFORM <function>(...)` | Invoking domain-specific procedural logic. |
| `notify` | Signaling | `PERFORM pg_notify('<channel>', <payload>)` | Waking a daemon inside the cluster; nothing is recorded. |
| `stream` | DuckStream Signal | `PERFORM pg_notify('duckstream_<name>', ...)` | Signaling incremental streaming views or refreshing computations. |

## Invoking an external effect

None of the effects above leaves the cluster. A state reaches outside by *invoking* a
declared external effect, and only that effect's outcome leaves the state:

```cue
charging: invoke: {src: "charge", onDone: "settled", onError: "failed"}
```

Every transition into `charging` claims a row in `airlock.external_effect_ledger`, keyed by
the effect and the row, and enqueues a Graphile job for the airlock, all in its own commit. A
key already in the ledger was performed, so entering again under it raises. Leaving
`charging` requires the ledger to hold an outcome naming the new state, which only the airlock
writes, and the arrows' actions read it as `outcome`. The grammar, the handler and the
alternatives are in pronto's [external effects](../../../plugins/pronto/docs/decisions/2026-10-03-external-effects.md).

## Timeouts and the ticker

A timer is XState's `after`, and its delay a duration: milliseconds, or a name
the machine's `delays` gives to milliseconds or to the row's `duration` field.

```cue
delays: review: "review_window"
states: pending: after: {review: "expired", "60000": "reminded"}
```

Entering the state arms one schedule per delay in the entering transaction, due
at the entry's `machine_clock()` plus the delay; the field is read once, as the
state is entered. Leaving the state, or re-entering it, cancels the visit's
schedules. Mecha's [ticker](../services/ticker/README.md) inserts a
`machine_timer_tick` once a schedule is due; its trigger locks the row, checks
that the same visit still stands, and takes the timed transition through the
machine's own trigger, guards, actions and relational effects included, in one
transaction. The tick's instant is the only time the fire reads, so a test
delivers a future tick by naming its instant, and a deadline already past fires
on the next sweep. A client cannot write a tick or a schedule.

## Bounded reducer machines

Pronto's `#MechaReducerMachine` executes bounded pure reductions in Mecha and
uses the existing `#MechaAction` compiler for relational effects, `spawn`,
`send`, named SQL hatches, notifications and rejection. Incoming browser events
do not transfer authoritative write ownership. `state.mecha.reducers` holds
reducer declarations (`machine`, `rules`), and
`state.mecha.rows` holds transactional row declarations (`entity`). Both belong
to Mecha; their execution bindings remain separate, avoiding a CUE disjunction
over two independently derived machine schemas.

The persisted `hybrid_<name>` PostgreSQL schemas and their protocol markers are
storage identifiers retained for existing databases. They do not name another
kind of machine; changing them requires a database migration.

A rule is XState's one argument, `({context, event}) => …`: the event holds
its `type`, its payload's fields, and what the runtime states on it, each
under the underscore SCXML reserves for the platform: who sent it (`_origin`,
which an event the machine's own tier sends does not carry), the step's
`_time` and its `_entropy`. A rule's contract lists the fields it reads, and the runtime hands
it no other. A guard answers a boolean, as XState's does, and anything else is
a program error; a transition names one guard or several, tried in order, and
the first to answer false refuses the event with the `reason` its declaration
in `setup` states. The initializer is XState's context factory, `({input})`,
and the runtime adds the step's `_time` to the input where its caller states one.

A transition's `requires`, a list of `{sql, reason}` tried in order, checks its
relational precondition under the declared locks. A false or null result records a refusal without
applying its reduction or actions. Actions run after a successful pure
reduction and before state, private projections and the receipt commit.
An SQL exception aborts all of them. Pure local execution tests only the
reduction; PostgreSQL integration tests must exercise relational behavior.
Automatic transitions remain pure.

Relational effects can name a `schema` for private tables. A `#MechaReadLock`
names a table, key and nonempty list of values, with an optional SQL `when`
condition. It locks existing rows in key order; it does not lock absent rows
or prove a global lock order. Entity machines use it as an action. Bounded
machines declare preparation `locks` before their own instance lock and
recheck the instance revision afterward. Their transition actions cannot
assign reducer state or acquire additional declared preparation locks.
Raw expressions use `game` (the locked instance), `request`, `actor` and
`reduced`; trigger-only `NEW`, `OLD` and stream raises are not supported.

Each bounded machine exposes a private `deliver(instance_id, event)` receiver
for synchronous Mecha calls. It uses the same dispatcher and requires an
accepted result; a refusal aborts the caller's transaction. It is not a
network delivery mechanism. A caller's durable receipt prevents its actions
from being repeated after a lost reply. The Truco challenge machine is an
example: [[../../../apps/truco/machines/challenge.cue]].

`spawn` names a bounded machine, its instance ID, initializer input and seat-to-
actor mapping. The target's pure initializer runs in the bounded executor;
input shape, initial phase, state shape and invariant must hold before any row
is inserted. Membership and initial private projections commit with the spawn.
`send` names a Mecha event and uses the target's generated receiver. The app
schema refuses undeclared targets, missing initializers and browser-owned
send events. These actions are also available to native entity machines.

### The surface and its ports

A reader reaches a bounded machine only through rows: the live entities the
app declares beside it (Pronto's `mecha-surface.ts` checks them) and the
triggers the compiler attaches to them. The seat table holds each member's
private view, written by the machine at every accepted step; a command row's
insert dispatches it and stamps the receipt on the row; an open row's insert
runs the admission or the join; a public table holds what the rules publish;
a lease row's writes admit and renew, and its delete leaves. A reader can
write only its own command, open and lease rows, never a seat, a receipt or a
listing. The machine's `ports` describe the operations behind those rows. See
[[../../../apps/truco/machines/admission.cue|Truco's declarations]].

- `admission` declares parameters, an instance identity, initializer input,
  memberships, preparation locks and ordered preconditions. An open row calls
  it with the instance its row names and the other parameters from its input.
  A private receipt binds that identity to its creator and exact request.
  Concurrent first calls serialize on the receipt; retries return the stored
  outcome. Exceptions roll back the reservation, so the same request can retry
  after repair.
- `join` locks the instance, accepts an existing member again, admits the
  declared seat only in the allowed phases, then sends a Mecha event. Seat
  uniqueness and all-or-nothing delivery are PostgreSQL constraints.
- `lease` names the events a lease row's writes and delete deliver. Its
  machine is admitted by a parameterless admission keyed by the reader.
- `reads` declares private SQL queries used by relational preconditions.
  SQL expressions remain trusted authored code, not a proof of authorization
  or concurrency correctness.

Admission locks precede receipt locks and instance creation. A timer's fire
holds the instance before it reads whether its schedule stands. Lock declarations still need a consistent order across all participating
operations; the compiler does not prove global deadlock freedom.

Composition reuses existing execution paths: a relational action can update
an entity into an invoking state, whose native machine claims and enqueues
through [[../services/airlock/README|Airlock]] in the same transaction. CDC
[[../../../plugins/pronto/docs/pipelines-and-schedules|pipelines]] consume
committed source changes with their existing delivery semantics. Neither
requires another queue or distributed transaction engine in Cortex. Airlock
is for external effects; eventual projections cannot arbitrate exclusive
seat admission. Cortex composition should select these Mecha operations,
not implement their locks, writes or delivery protocols again.

### Timers

A bounded machine's timers are XState v5's `after`, kept by the
[ticker](../services/ticker/README.md). A delay is a number of milliseconds or
a name in the setup's `delays`, whose value is milliseconds or the context
field holding them:

```cue
config: states: playing: after: turn: {target: "resolving", actions: "timeout"}
setup: delays: turn: "turn_ms"
```

Entering the state starts each timer, measured from the step's time; the
runtime reads a named delay off the context the state is entered with, and a
value that is not a duration fails the step. Leaving the state cancels them. A
step that stays in the state, with no target or with the state as its target,
moves nothing; only re-entering it, as a transition with `reenter: true` does,
starts them again. The step leaves to its host the actions XState leaves:
each entry's delayed `xstate.raise` and each exit's `xstate.cancel`. The host
arms a one-shot schedule per raise, due its delay after the step's time and
named by the step's revision, and deletes the state's schedules on a cancel.

A compound state, XState's nested one, holds its children one level deep;
a phase is the atomic state's path (`racing.closing`), and a child takes the
events its parent does. The parent's timers start when it is entered and
stand while its children are entered and left, so a parent's `after` and a
child's run together and the earlier decides; leaving the parent cancels
both.

The tick delivers the timer's event, `xstate.after.<delay>.<state>`, which only
the machine's own tier may send. Its fire holds the instance, then takes the
schedule it names; a schedule its state's exit already deleted delivers
nothing. The step runs at the later of the instant the ticker found it due
and the fire's own `clock()`, so a late tick starts the next state's timers
from when it was decided. It takes the delay's first arrow whose guards hold,
as XState does; with none, the timer is spent and nothing moves. A timer's
transition runs the rules' guards and actions only: the database's have no
delayed form.

## Tenancy and runtime safety

State machine triggers execute under the database user's transaction context:

- **Tenancy floor**: Triggers run with `SECURITY INVOKER` or `SECURITY DEFINER`
  under the active session, honoring [row-level security](../services/database/rls/README.md).
- **Trigger loop prevention**: Triggers specify `WHEN (OLD.status IS DISTINCT FROM NEW.status)`
  so updates to non-state columns bypass machine evaluation completely.
- **Statement limits**: All mecha PostgreSQL connections operate under finite
  timeouts (`statement_timeout = '60s'`, `lock_timeout = '5s'`), preventing
  deadlocks or cascading effect storms from blocking the connection pool.

## What bites

- **Self-referential mutations**: An effect cannot execute `UPDATE` or `DELETE`
  on the row currently executing the `BEFORE UPDATE` trigger without risking
  recursion or deadlock. Effects must target child, ledger, or projection
  tables, while modifications to the entity itself are applied by setting
  `NEW.<col>`.
- **Clock references**: a machine reads time through `machine_clock()`, the
  transaction's time, which a test database replaces to move time. A guard or
  an expression calling `now()`, `CURRENT_TIMESTAMP` or `clock_timestamp()` is
  refused by `pronto check replay`.

## Rejected

- **Application-tier statechart runners (Node, Go, Python)**: Storing state in the
  database while driving transitions in an application service introduces network
  round trips, requires distributed locks to prevent split-brain races, and
  permits invalid states if an application crashes midway through side effects.
- **Hand-rolled PL/pgSQL triggers**: Hand-written trigger functions duplicate
  boilerplate across migration files, easily drift from application schema, and
  lack compile-time validation. Declarative schemas generate uniform, audited
  SQL triggers.
- **Asynchronous cron jobs updating states without database guards**: Allowing
  unconstrained writes from workers allows invalid intermediate states in the
  database before the worker executes. Database triggers guarantee that no
  write can enter an illegal state regardless of the source.
- **In-transaction sleep (`pg_sleep`)**: Stalling database connections to wait
  for timeouts consumes pool connections and violates mecha's scale-to-zero
  model. Timeouts must be evaluated against timestamps, not paused threads.
