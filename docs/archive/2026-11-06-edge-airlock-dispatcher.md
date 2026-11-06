---
type: decision
title: The edge airlock's dispatcher Worker
description: Runs Cloudflare effects in a queue-consuming Worker apart from the Durable Object that holds the database, which claims, leases and settles them, so rendering and commits never wait on an effect's network.
status: built
---

# The edge airlock's dispatcher Worker

**Status: built 6 November 2026.** The contract is
[[../../packages/mecha-edge/README#Effects|the edge cluster's]].

## The problem

The edge airlock ran inside the `Cluster` Durable Object, beside PGlite and the
renderer: a drain claimed a run, called the effect's handler, waited on its sink
— Workers AI, an image model, an origin — and settled the outcome, all in the
object's isolate and its 128 MB. The object is the online path: documents,
CRUD, shapes and commits. An effect is the asynchronous path, and an image that
takes a minute held memory and a concurrency slot in the isolate that answers
every reader.

## Decision

The object keeps what needs its database; a separate Worker runs what needs the
network.

- **The object** claims through Graphile as before, and settles in place what
  needs no call: an outcome already recorded, a bridge not deployed on the edge,
  a run the reentry policy settles `unknown`. Any other run is leased with a
  Graphile job keyed by the ledger key and committed, then sent after the
  commit, outside any transaction, under a token naming that dispatch (the
  lease job's id and revision). The ledger and the job are the outbox the
  transition already committed, so a send that fails or never happens is sent
  again by the lease. It never waits on the effect, and never holds a
  transaction across the network.
- **The dispatcher Worker**, the queue's consumer, claims the run back from the
  object over RPC (`effectClaim`, which redeems the current token once: it counts
  the run in `entered`, decides it against the reentry policy as the container
  does when a run begins, and renews the lease for as long as the run can still
  call its sink; a stale token, or a second delivery of a message, counts
  nothing, while the same delivery asking again after a lost reply gets the run
  it counted), runs
  the handler in the same cage, sink and endowments, stows answered bytes
  in R2, and answers (`effectAnswer`).
- **An answer** settles in the object: an outcome is recorded once and the row
  moved by the recorded one, whichever run produced it, and the lease removed; an
  error of the current run schedules the next one after Graphile's backoff, or
  settles `unknown` on the effect's last attempt.
- **Redelivery is the lease's.** The queue never redelivers (`max_retries: 0`): a
  lost message, a dispatcher that died or a run past its bound leaves the lease
  to run out, and the object's next drain sends the run again, counted when it is
  claimed, as the container airlock counts a rerun when it begins. At-least-once delivery, the ledger
  as the truth, no double settle.

## Alternatives

- **A service binding, fire and forget.** The callee's `waitUntil` ends about 30
  seconds after it responds, short of an image run's bound, and a dispatch lost
  to an eviction has no record outside the object. A queue consumer runs for
  minutes and is decoupled from the caller's lifetime.
- **Queue retries instead of the lease.** Only the object can tell a message
  that still names the key's current dispatch from a stale one; the lease, with
  a token per dispatch, keeps that decision in the ledger's database.
- **Counting a run as it is sent, in the transaction that sends it.** That held
  the object's database across the queue's round-trip, behind which every read
  and commit waited. Counting at the claim spends nothing on a lost send.
- **The consumer in the object's own script.** Smaller to deploy, but the
  user-facing release and the effects would share secrets and a deploy; a
  separate script holds only the keys its effects and their providers need.
- **Moving the ledger or Graphile out of the object.** The settle must move the
  machine in the same database the row lives in, which is the object's.
