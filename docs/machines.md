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
                      │     (insert, ensure, upsert, accumulate,      │
                      │      delete, call, notify)                    │
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
4. **Timeout predicates**: For transitions triggered after a duration (`after`),
   the trigger validates elapsed wall-clock time via `clock_timestamp()`.

## The grammar and relational effects

State machines declare deterministic side effects that run inside the transition
boundary. Because effects run before commit, any failure rolls back the entire
state transition:

| effect | operation | SQL execution | purpose |
|---|---|---|---|
| `insert` | Append | `INSERT INTO <table> (...) VALUES (...)` | Appending immutable audit or ledger records. |
| `ensure` | Idempotent insert | `INSERT INTO <table> (...) VALUES (...) ON CONFLICT DO NOTHING` | Guaranteeing existence of dependent records without duplicate errors. |
| `upsert` | Replace | `INSERT INTO <table> (...) VALUES (...) ON CONFLICT (<pk>) DO UPDATE SET ...` | Updating child or summary records keyed by primary key. |
| `accumulate`| Aggregation | `INSERT INTO <table> (...) VALUES (...) ON CONFLICT (<group>) DO UPDATE SET count = count + 1, sum = sum + EXCLUDED.amount` | Incremental materialized views and ledger totals without separate workers. |
| `delete` | Cascade/Prune | `DELETE FROM <table> WHERE <predicate>` | Cleaning up transient child records upon terminal state. |
| `call` | Stored procedure| `PERFORM <function>(...)` | Invoking domain-specific procedural logic. |
| `notify` | Signaling | `PERFORM pg_notify('<channel>', <payload>)` | Emitting ephemeral Level-4 signals across the cluster. |

## Timeouts and the ticker

Timeouts operate across two complementary paths: passive enforcement and active
sweep.

### Passive enforcement (on write)

When a state transition is conditioned on an elapsed duration (`after: { "60000": "expired" }`),
the trigger enforces the temporal guard:

```sql
IF (EXTRACT(EPOCH FROM (clock_timestamp() - OLD.created_at)) * 1000) < 60000 THEN
    RAISE EXCEPTION 'Transition to expired before timeout of 60000ms elapsed';
END IF;
```

A client attempting to force an early timeout transition is rejected by the
database catalog.

### Active sweep (on schedule)

Passive enforcement requires a write to fire. To transition abandoned rows where
no user interaction occurs, mecha's [ticker](../services/ticker/README.md)
sweeps overdue rows on a fixed schedule.

The ticker pokes the database or executes an automated sweep query:

```sql
UPDATE challenge
SET status = 'expired'
WHERE status = 'pending'
  AND (EXTRACT(EPOCH FROM (clock_timestamp() - created_at)) * 1000) >= 60000;
```

Because the sweep issues an `UPDATE`, the state machine's `BEFORE UPDATE`
trigger fires for every overdue row, validating the transition and executing any
configured relational effects (such as releasing reserved wagers or notifying
opponents) in a single atomic transaction.

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
- **Clock references**: `CURRENT_TIMESTAMP` and `now()` return the timestamp of
  the start of the transaction. High-precision timeout assertions use
  `clock_timestamp()` to reflect real wall-clock time at evaluation instant.

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
