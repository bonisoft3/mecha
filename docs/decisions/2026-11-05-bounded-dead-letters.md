---
type: decision
title: Bounded dead letters
description: Caps how often Airlock re-delivers a move that keeps failing, parks the key as a dead letter the program can read, and resumes it only by an explicit redrive.
status: unbuilt
---

# Bounded dead letters

**Status: unbuilt, proposed 5 November 2026.**

## The problem

[Airlock](../../services/airlock/README.md#in-a-cluster) commits an effect's
outcome, then moves the machine in a second transaction. When Graphile gives up
on a job, `settleDead` in [[../../services/airlock/airlock.ts]] and its edge copy
in [[../../packages/mecha-edge/src/airlock.ts]] deliver the move again at every
sweep, at start and once a minute, with no count. A move that fails for a
deterministic reason, such as a parser bug in the invoking state's `onDone`
actions, is retried forever and reported only as a log line per sweep. Nothing
the program reads says the key is stuck.

An error in an asynchronous flow belongs in a dead-letter queue unless something
recovers from it. Re-delivering a deterministic failure recovers nothing until the
code changes, and the code changing is an operator's act, not a sweep's.

## Decision

- The ledger counts sweep deliveries per key beside `entered`. An effect declares
  `moves` (default 10), the deliveries a key may receive after Graphile gives up.
- Past the bound the sweep records the last error on the ledger row, marks it dead,
  reports it once and skips it from then on. The invoking row stays in its state.
- `airlock.dead_letter` is a view over dead keys: effect, row key, last error and
  the number of deliveries. Only the service role reads it. A program surfaces it
  through its own machines, for example a deadline on the state that waits for the
  effect's machine.
- `airlock.redrive(key)` clears the mark and the count, and the next sweep delivers
  again. It is called by an operator after a fix ships; nothing calls it on its own.
- Both deliveries the sweep makes are bounded: the recorded outcome's move, and the
  `unknown` settlement of a job that never reached an answer.
- The container and edge airlocks share the rule, as they share `reentry.ts`.

## Alternatives

- **Unbounded re-delivery, as built.** It heals by itself once a fix is deployed,
  which redrive keeps, but it retries a deterministic failure without limit and
  leaves the only record in logs.
- **Moving the row to `onError` after the bound.** The ledger holds a `done`
  outcome; settling the machine as failed would contradict the recorded answer.
- **Expiring dead keys after a duration.** That is a clock deciding; a count of
  deliveries decides the same thing without one.
