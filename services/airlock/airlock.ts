// The airlock's worker: Graphile's long-lived pool, woken by the `jobs:insert`
// a guard's enqueue notifies at its commit, running every external effect to
// an outcome.
//
// The order is the protocol. A run first commits `entered + 1`, then calls the
// sink, then commits the ledger's outcome, then moves the machine. A process
// dying anywhere leaves a ledger that says what to do next (reentry.ts):
// before the counter, nothing happened; after it, the call may have happened;
// after the outcome, only the move is repeated, and a row already moved is
// left where it is. The ledger's `entered`, not
// Graphile's attempts, decides when an effect runs out of attempts: Graphile
// counts a run when it locks the job and keeps the count across a crash.
//
// A crashed process leaves its jobs locked under its pool. Each process holds
// a session advisory lock under a key of its own for its whole life, and
// records its pool against that key before any run begins. Postgres frees the
// key the moment the process's connection ends, so a sweep that can take a
// pool's key knows the pool is gone and unlocks its jobs through Graphile.

import { run, type Runner, type Task } from "graphile-worker";
import { EventEmitter } from "node:events";
import pg from "pg";
import { type Answer, type Effect, outcome, type Outcome, step } from "./reentry.ts";
import type { Handler, Transport } from "./handler.ts";

export type Airlock = {
  connectionString: string;
  db: pg.Pool;
  effects: Record<string, Effect>;
  handlers: Record<string, Handler>;
  transport: Transport;
  /** The values of each effect's declared secrets, read once at startup. */
  secrets: Record<string, Record<string, string>>;
  /** The header each effect's credential adds to its sink calls, read once;
   * the handler never holds it. */
  headers: Record<string, Record<string, string>>;
};

const q = (name: string) => `"${name}"`;

/** This process's liveness: a session advisory lock under a random key, on a
 * connection the process dies with, since a sweep elsewhere reads the key free
 * the moment that connection ends. The process exits on the spot rather than
 * finish a call another process may now take; what remains is the moment
 * between Postgres ending the session and this process hearing of it. */
export async function hold(connectionString: string): Promise<{ key: string; release: () => Promise<void> }> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const key = crypto.getRandomValues(new BigInt64Array(1))[0].toString();
  const { rows: [r] } = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [key]);
  if (!r.held) throw new Error(`advisory key ${key} is already held`);
  const lost = (e?: Error) => {
    console.error("the connection holding the airlock's liveness is gone", e);
    Deno.exit(1);
  };
  client.on("error", lost);
  client.on("end", lost);
  return {
    key,
    release: async () => {
      client.removeAllListeners("error");
      client.removeAllListeners("end");
      await client.end();
    },
  };
}

/** Unlocks the jobs of every recorded pool whose process is gone, forgets the
 * pool, and notifies `jobs:insert` for what it unlocked, as `add_job` does, so
 * a listening worker takes those jobs at the commit. Answers the pools it
 * freed. */
export async function sweep(db: pg.Pool): Promise<string[]> {
  const { rows } = await db.query("SELECT pool, lock::text FROM airlock.pool");
  const freed: string[] = [];
  for (const { pool, lock } of rows) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { rows: [r] } = await client.query("SELECT pg_try_advisory_xact_lock($1::bigint) AS free", [lock]);
      if (r.free) {
        const { rows: [held] } = await client.query("SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE locked_by = $1", [pool]);
        await client.query("SELECT graphile_worker.force_unlock_workers(ARRAY[$1])", [pool]);
        if (held.n > 0) await client.query("SELECT pg_notify('jobs:insert', json_build_object('count', $1::int)::text)", [held.n]);
        await client.query("DELETE FROM airlock.pool WHERE pool = $1", [pool]);
        freed.push(pool);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  return freed;
}

/** The outcome written, then the machine moved. */
async function settle(a: Airlock, key: string, l: { row: Record<string, unknown> }, effect: Effect, settled: Outcome): Promise<void> {
  // The outcome first, in its own commit: a crash past it re-delivers the
  // move alone, and no run calls the sink again for an answer it has.
  await a.db.query(
    "UPDATE airlock.external_effect_ledger SET outcome = $2, settled_at = clock_timestamp() WHERE key = $1 AND outcome IS NULL",
    [key, settled],
  );
  const match = effect.row.map((c, i) => `${q(c)}::text = $${i + 3}`).join(" AND ");
  const args = [settled.target, effect.state, ...effect.row.map((c) => String(l.row[c]))];
  const moved = await a.db.query(
    `UPDATE ${q(effect.table)} SET ${q(effect.field)} = $1 WHERE ${q(effect.field)} = $2 AND ${match}`,
    args,
  );
  if (moved.rowCount !== 1) {
    // The guard holds a row in its invoking state until the outcome lands,
    // so a row still there was not moved by this outcome; one anywhere else,
    // or gone, was moved by an earlier delivery of it and then by the program.
    const where = effect.row.map((c, i) => `${q(c)}::text = $${i + 1}`).join(" AND ");
    const { rows: [row] } = await a.db.query(`SELECT ${q(effect.field)} AS at FROM ${q(effect.table)} WHERE ${where}`, args.slice(2));
    if (row?.at === effect.state) {
      throw new Error(`${key}: ${effect.table} ${JSON.stringify(l.row)} stays in ${effect.state}: its move to ${settled.target} was refused`);
    }
  }
}

/** The jobs Graphile gave up on: past every retry with no outcome (a delivery
 * that never reached an answer: the ledger unreadable, the database away), or
 * with an outcome whose move never landed. The first settle `unknown`, the
 * queue's last error as the outcome's data; the second are moved again. Each
 * key is its own attempt: one that fails is reported and tried at the next
 * sweep, since one bad row is no reason to run no effect at all. Graphile's
 * row stays as the record. Answers the keys it settled. */
export async function settleDead(a: Airlock): Promise<string[]> {
  const { rows } = await a.db.query(`
    SELECT j.key, j.last_error, l.effect, l.row, l.outcome
      FROM graphile_worker._private_jobs j
      JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      JOIN airlock.external_effect_ledger l ON l.key = j.key
     WHERE t.identifier = 'external_effect' AND j.attempts >= j.max_attempts AND j.locked_at IS NULL`);
  const settled: string[] = [];
  for (const r of rows) {
    try {
      const effect = a.effects[r.effect] ?? die(`${r.key}: effect ${r.effect} is not in effects.json`);
      if (r.outcome === null) {
        console.error(`${r.key}: the queue gave up with no outcome, so unknown:`, r.last_error);
        await settle(a, r.key, r, effect, { ...outcome(effect, "unknown", false), data: { dead: r.last_error } });
      } else {
        await settle(a, r.key, r, effect, r.outcome);
      }
      settled.push(r.key);
    } catch (e) {
      console.error(`${r.key}: not settled at this sweep:`, e);
    }
  }
  return settled;
}

/** Wake ticks older than a day: the record of a wake is the job it woke. */
async function pruneWakes(db: pg.Pool): Promise<void> {
  await db.query("DELETE FROM public.airlock_wake WHERE tick_at < now() - interval '1 day'");
}

/** Runs effects as Graphile delivers them, until the runner stops. `key` is
 * this process's held liveness (hold). What dead pools left locked is freed
 * before the first fetch and whenever a fetch comes back empty; the dead jobs
 * and old wakes, which cost a scan of the queue, at start and once a minute. */
export async function start(a: Airlock, key: string, opts: { noHandleSignals?: boolean; housekeepingMs?: number } = {}): Promise<Runner> {
  await sweep(a.db);
  await settleDead(a);
  await pruneWakes(a.db);
  const events = new EventEmitter();
  let recorded: Promise<unknown> | undefined;
  events.on("pool:create", ({ workerPool }) => {
    recorded = a.db.query("INSERT INTO airlock.pool (pool, lock) VALUES ($1, $2::bigint)", [workerPool.id, key]);
  });
  let sweeping: Promise<unknown> | undefined;
  let housekept = Date.now();
  events.on("worker:getJob:empty", () => {
    sweeping ??= sweep(a.db).then(async () => {
      if (Date.now() - housekept < (opts.housekeepingMs ?? 60_000)) return;
      housekept = Date.now();
      await settleDead(a);
      await pruneWakes(a.db);
    }).finally(() => (sweeping = undefined));
  });

  const task: Task = async (payload) => {
    if (recorded === undefined) throw new Error("graphile ran a job before announcing its pool");
    // No run begins before its pool is recorded, so a crash during one leaves
    // a pool a sweep can free.
    await recorded;
    const { key } = payload as { key: string };
    const { rows: [l] } = await a.db.query(
      "SELECT effect, row, input, outcome FROM airlock.external_effect_ledger WHERE key = $1",
      [key],
    );
    if (l === undefined) throw new Error(`airlock.external_effect_ledger holds no ${key}`);
    const effect = a.effects[l.effect] ?? die(`${key}: effect ${l.effect} is not in effects.json`);
    let settled = l.outcome;
    if (settled === null) {
      const { rows: [c] } = await a.db.query(
        "UPDATE airlock.external_effect_ledger SET entered = entered + 1 WHERE key = $1 RETURNING entered",
        [key],
      );
      settled = await perform(a, l.effect, effect, key, l.input, c.entered);
    }
    await settle(a, key, l, effect, settled);
  };

  return await run({
    connectionString: a.connectionString,
    events,
    noHandleSignals: opts.noHandleSignals,
    taskList: { external_effect: task },
  });
}

/** The handler run the ledger's count calls for, as an outcome. A throw is no
 * answer: retried while the ledger counts fewer runs than the effect's
 * attempts, `unknown` on the last, and a run past them calls nothing. */
async function perform(a: Airlock, name: string, effect: Effect, key: string, input: unknown, entered: number) {
  const handler = a.handlers[name] ?? die(`no handler is admitted for ${name}`);
  if (entered > effect.attempts) return outcome(effect, "unknown", false);
  const next = step(effect, entered);
  if (next === "unknown") return outcome(effect, "unknown", false);
  try {
    if (next === "reconcile") {
      const known = await handler.call("reconcile", input, key, a.transport, a.secrets[name], a.headers[name]);
      if (!("absent" in known)) return outcome(effect, known, true);
    }
    return outcome(effect, await handler.call("issue", input, key, a.transport, a.secrets[name], a.headers[name]) as Answer, false);
  } catch (e) {
    if (entered < effect.attempts) throw e;
    console.error(`${key}: no answer after ${entered} runs, so unknown:`, e);
    return outcome(effect, "unknown", false);
  }
}

function die(message: string): never {
  throw new Error(message);
}
