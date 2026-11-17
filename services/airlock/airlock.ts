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
import { type Answer, type Effect, ledgerKeySql, outcome, type Outcome, step, undeployed } from "./reentry.ts";
import { BreakerOpen, type Handler, type Transport } from "./handler.ts";
import { type BlobStore, stowed } from "./blobs.ts";
import { get, type Read, READ_JOURNAL_SQL, ReadCache, readOutcome } from "./read.ts";
import { openFields, type Opened, type SealKeys } from "./seal.ts";
import { PUBLISH_SEAL_SQL, SEAL_TABLES_SQL } from "./seal-tables.ts";

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
  /** The cluster's blob plane, where an answer's bytes go and a handler's
   * content keys are read; absent without one. */
  blobs?: BlobStore;
  /** The door's origin, a handler's sink.origin. */
  origin?: string;
  /** The release target this airlock runs on, which a bridge naming its
   * targets is checked against. */
  target?: string;
  /** The reads (read.ts) and the cache they share. */
  reads?: Record<string, Read>;
  cache?: ReadCache;
  /** Replay: a read is answered from the journal alone, never asked of its
   * sink, and a request the journal holds no answer to, or holds one to
   * other input, stops it. */
  replay?: boolean;
  /** The airlock's daprd, which a read calls through got. */
  mesh?: string;
  /** The key a secret field's value is sealed to (seal.ts), and the one a
   * rotation replaced; absent where no effect reads a secret field. */
  seal?: SealKeys;
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
async function settle(a: Airlock, key: string, l: { row: Record<string, unknown> }, effect: Effect, settled: Outcome, consumed: string[] = []): Promise<void> {
  // The outcome first, in its own commit: a crash past it re-delivers the
  // move alone, and no run calls the sink again for an answer it has. The
  // sealed values this run opened go in the same commit, and only those and
  // only by the commit that records the outcome: a value its reader typed
  // since, for the row's next invocation, is that one's. A value another
  // effect naming its field still awaits on this row (claimed, unsettled) is
  // kept for that one, until the last of them settles or it expires.
  if (consumed.length === 0) {
    await a.db.query("UPDATE airlock.external_effect_ledger SET outcome = $2, settled_at = clock_timestamp() WHERE key = $1 AND outcome IS NULL", [key, settled]);
  } else {
    // Which effects name each field of this table, by the field.
    const naming: Record<string, string[]> = {};
    for (const [n, e] of Object.entries(a.effects)) {
      if (e.table === effect.table) for (const f of e.secretFields ?? []) (naming[f] ??= []).push(n);
    }
    const client = await a.db.connect();
    try {
      await client.query("BEGIN");
      // Settles of two effects on one row's value take its lock in turn, so
      // the second reads the first's outcome committed and deletes.
      await client.query("SELECT 1 FROM airlock.secret WHERE tbl = $1 AND row = $2 AND value = ANY($3) FOR UPDATE", [effect.table, l.row, consumed]);
      await client.query(
        `WITH done AS (UPDATE airlock.external_effect_ledger SET outcome = $2, settled_at = clock_timestamp() WHERE key = $1 AND outcome IS NULL RETURNING key)
         DELETE FROM airlock.secret s WHERE EXISTS (SELECT 1 FROM done) AND s.tbl = $3 AND s.row = $4 AND s.value = ANY($5)
           AND NOT EXISTS (SELECT 1 FROM airlock.external_effect_ledger o
                            WHERE o.key <> $1 AND o.outcome IS NULL AND o.row = $4
                              AND o.effect IN (SELECT jsonb_array_elements_text($6::jsonb -> s.field)))`,
        [key, settled, effect.table, l.row, consumed, JSON.stringify(naming)],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  const match = effect.row.map((c, i) => `${q(c)}::text = $${i + 4}`).join(" AND ");
  const keyed = ledgerKeySql(key.slice(0, key.indexOf(":")), effect);
  const args = [settled.target, effect.state, key, ...effect.row.map((c) => String(l.row[c]))];
  const moved = await a.db.query(
    `UPDATE ${q(effect.table)} SET ${q(effect.field)} = $1 WHERE ${q(effect.field)} = $2 AND ${keyed} = $3 AND ${match}`,
    args,
  );
  if (moved.rowCount !== 1) {
    // The guard holds a row in its invoking state until the outcome lands,
    // so a row still there under this key was not moved by this outcome; one
    // anywhere else, gone, or back in the state for another invocation, was
    // moved by an earlier delivery of it and then by the program.
    const where = effect.row.map((c, i) => `${q(c)}::text = $${i + 2}`).join(" AND ");
    const { rows: [row] } = await a.db.query(
      `SELECT ${q(effect.field)} AS at, ${keyed} = $1 AS ours FROM ${q(effect.table)} WHERE ${where}`, [key, ...args.slice(3)]);
    if (row?.at === effect.state && row.ours) {
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
 * row stays as the record. A job Graphile stripped of its key when a lease
 * replaced it is superseded, not the key's. Answers the keys it settled. */
export async function settleDead(a: Airlock): Promise<string[]> {
  const { rows } = await a.db.query(`
    SELECT l.key, j.last_error, l.effect, l.row, l.outcome
      FROM graphile_worker._private_jobs j
      JOIN graphile_worker._private_tasks t ON t.id = j.task_id
      JOIN airlock.external_effect_ledger l ON l.key = j.payload->>'key'
     WHERE t.identifier = 'external_effect' AND j.key IS NOT NULL AND j.attempts >= j.max_attempts AND j.locked_at IS NULL`);
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

/** What a machine's interpreter enqueues for a read: the effect, the row's
 * primary key, its incarnation (a row made again under its key has another),
 * `n`, the row's count of entries into the invoking state this request was
 * made at, the invocation's key `<effect>:<row's key>:<incarnation>:<n>`, the
 * input, and the digest of the input's text. */
export type ReadJob = { effect: string; row: Record<string, unknown>; incarnation: string; n: number; key: string; input: Record<string, unknown>; digest: string };

/** A read's outcome: where the row goes, and what it carries. */
export type ReadSettled = { target: string; kind: string; data: unknown };

/** A replay that reaches a request the journal holds no answer to, or holds
 * one to other input: the history being re-run is not the one recorded. */
export class ReadDiverged extends Error {}

/** A machine's read, delivered: its outcome set for this transaction alone,
 * where the interpreter reads it, the row moved, and the answer journaled,
 * all in one commit, and only where the row, in the incarnation the request
 * was made in, still waits on its `n`.
 * Only the airlock's own session is believed (emit.cue's outcome check). An
 * answer the row no longer waits on (it was deleted, or the job ran twice)
 * writes nothing. False when no row took it. */
export async function deliverRead(a: Airlock, job: ReadJob, settled: ReadSettled): Promise<boolean> {
  const invoke = a.reads?.[job.effect]?.invoke ?? die(`read ${job.effect} is invoked by no machine in effects.json`);
  const client = await a.db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('airlock.read', $1, true)", [JSON.stringify({ effect: job.effect, row: job.row, incarnation: job.incarnation, n: job.n, ...settled })]);
    const match = invoke.row.map((c, i) => `${q(c)}::text = $${i + 5}`).join(" AND ");
    const moved = await client.query(
      `UPDATE ${q(invoke.table)} SET ${q(invoke.field)} = $1 WHERE ${q(invoke.field)} = $2 AND ${q(invoke.count)} = $3 AND ${q(invoke.incarnation)}::text = $4 AND ${match}`,
      [settled.target, invoke.state, job.n, job.incarnation, ...invoke.row.map((c) => String(job.row[c]))],
    );
    // The key names the row's incarnation, so no other history shares it.
    if (moved.rowCount === 1 && !a.replay) {
      await client.query(
        `INSERT INTO airlock.read_journal (key, effect, row, incarnation, n, digest, outcome) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (key) DO NOTHING`,
        [job.key, job.effect, JSON.stringify(job.row), job.incarnation, job.n, job.digest, JSON.stringify(settled)],
      );
    }
    await client.query("COMMIT");
    return moved.rowCount === 1;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** The journal's answer to a job: the outcome recorded under its key. Its
 * digest is a check: the same key over other input is a history that
 * diverged, refused rather than answered. Undefined where none is recorded. */
export async function journaled(a: Airlock, job: ReadJob): Promise<ReadSettled | undefined> {
  const { rows } = await a.db.query("SELECT digest, outcome FROM airlock.read_journal WHERE key = $1", [job.key]);
  if (rows.length === 0) return undefined;
  if (rows[0].digest !== job.digest) throw new ReadDiverged(`read ${job.key}: the journal answered other input, so this history diverged from the recorded one`);
  return rows[0].outcome;
}

/** A machine's read run once: asked of the sink, its answer delivered. A run
 * with no answer is retried on Graphile's backoff; the last one delivers
 * `failed`, since a GET that never answered changed nothing. In replay the
 * journal answers instead, and a request it never answered stops the run. */
export async function performRead(a: Airlock, job: ReadJob, last: boolean): Promise<void> {
  const read = a.reads?.[job.effect] ?? die(`read ${job.effect} is invoked by no machine in effects.json`);
  if (a.replay) {
    const recorded = await journaled(a, job);
    if (recorded === undefined) throw new ReadDiverged(`read ${job.key}: the journal holds no answer, so this history diverged from the recorded one`);
    await deliverRead(a, job, recorded);
    return;
  }
  let settled: ReadSettled;
  try {
    settled = readOutcome(read.invoke, await get(job.effect, read, job.input, { mesh: a.mesh ?? die("a read needs the airlock's daprd"), headers: a.headers[job.effect] ?? {}, cache: a.cache ??= new ReadCache() }));
  } catch (e) {
    if (!last) throw e;
    console.error(`read ${job.key}: no answer on the last run, so failed: ${e instanceof Error ? e.message : e}`);
    settled = { target: read.invoke.onError, kind: "failed", data: { error: e instanceof Error ? e.message : String(e) } };
  }
  await deliverRead(a, job, settled);
}

/** Reads Graphile gave up on, the process having died in the last run or the
 * delivery having failed: each delivered `failed`, the queue's last error as
 * its data, then completed, since a read leaves no claim to keep. A replay
 * settles none: a history that diverged stops where it diverged. Answers how
 * many it settled. */
async function settleDeadReads(a: Airlock): Promise<number> {
  if (a.replay) return 0;
  const { rows } = await a.db.query(`
    SELECT j.id, j.payload, j.last_error
      FROM graphile_worker._private_jobs j
      JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     WHERE t.identifier = 'external_read' AND j.attempts >= j.max_attempts AND j.locked_at IS NULL`);
  let settled = 0;
  for (const r of rows) {
    try {
      const job = r.payload as ReadJob;
      const invoke = a.reads?.[job.effect]?.invoke ?? die(`read ${job.effect} is invoked by no machine in effects.json`);
      await deliverRead(a, job, { target: invoke.onError, kind: "failed", data: { dead: r.last_error } });
      await a.db.query("SELECT graphile_worker.complete_jobs(ARRAY[$1::bigint])", [r.id]);
      settled++;
    } catch (e) {
      console.error(`read job ${r.id}: not settled at this sweep:`, e);
    }
  }
  return settled;
}

/** The journal's entries whose row is gone, in the incarnation they were
 * taken in. The journal is replay's record of the answers rows took, so an
 * entry lives as long as its row: a deleted row has no history left to
 * re-run. */
export async function pruneJournal(a: Airlock): Promise<void> {
  if (a.replay) return;
  for (const [name, r] of Object.entries(a.reads ?? {})) {
    const same = r.invoke.row.map((c) => `t.${q(c)}::text = j.row->>'${c}'`).join(" AND ");
    await a.db.query(`DELETE FROM airlock.read_journal j WHERE j.effect = $1 AND NOT EXISTS (SELECT 1 FROM ${q(r.invoke.table)} t WHERE ${same} AND t.${q(r.invoke.incarnation)}::text = j.incarnation)`, [name]);
  }
}

/** Wake ticks older than a day: the record of a wake is the job it woke. And
 * secrets past their time, which no run reads: a value typed for an effect
 * that never ran is gone at the next housekeeping after it expires. */
async function prune(a: Airlock): Promise<void> {
  await a.db.query("DELETE FROM public.airlock_wake WHERE tick_at < now() - interval '1 day'");
  if (Object.values(a.effects).some((e) => e.secretFields !== undefined)) {
    await a.db.query("DELETE FROM airlock.secret WHERE expires_at <= clock_timestamp()");
  }
}

/** Runs effects as Graphile delivers them, until the runner stops. `key` is
 * this process's held liveness (hold). What dead pools left locked is freed
 * before the first fetch and whenever a fetch comes back empty; the dead jobs
 * and old wakes, which cost a scan of the queue, at start and once a minute. */
export async function start(a: Airlock, key: string, opts: { noHandleSignals?: boolean; housekeepingMs?: number } = {}): Promise<Runner> {
  await a.db.query(READ_JOURNAL_SQL);
  if (Object.values(a.effects).some((e) => e.secretFields?.length)) {
    if (a.seal === undefined) throw new Error("an effect reads a secret field, and the airlock holds no seal key (AIRLOCK_SEAL_KEY)");
    await publishSeal(a.db, a.seal);
  }
  await sweep(a.db);
  await settleDead(a);
  await settleDeadReads(a);
  await prune(a);
  await pruneJournal(a);
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
      await settleDeadReads(a);
      await prune(a);
      await pruneJournal(a);
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
    let settled = l.outcome ?? undeployed(effect, a.target);
    const consumed: string[] = [];
    if (settled === null) {
      const { rows: [c] } = await a.db.query(
        "UPDATE airlock.external_effect_ledger SET entered = entered + 1 WHERE key = $1 RETURNING entered",
        [key],
      );
      settled = await perform(a, l.effect, effect, key, l.input, c.entered, l.row, consumed);
    }
    await settle(a, key, l, effect, settled, consumed);
  };

  return await run({
    connectionString: a.connectionString,
    events,
    noHandleSignals: opts.noHandleSignals,
    taskList: {
      external_effect: task,
      external_read: async (payload, helpers) => {
        if (recorded === undefined) throw new Error("graphile ran a job before announcing its pool");
        await recorded;
        await performRead(a, payload as ReadJob, helpers.job.attempts >= helpers.job.max_attempts);
      },
    },
  });
}

/** The handler run the ledger's count calls for, as an outcome. A throw is no
 * answer: retried while the ledger counts fewer runs than the effect's
 * attempts, `unknown` on the last, and a run past them calls nothing. An open
 * breaker spends no attempt. */
async function perform(a: Airlock, name: string, effect: Effect, key: string, input: unknown, entered: number, row: Record<string, unknown>, consumed: string[]) {
  const handler = a.handlers[name] ?? die(`no handler is admitted for ${name}`);
  if (entered > effect.attempts) return outcome(effect, "unknown", false);
  const next = step(effect, entered);
  if (next === "unknown") return outcome(effect, "unknown", false);
  const typed = await secretsOf(a, effect, row, consumed);
  if (typed.missing !== undefined) {
    // Expired, never written, or sealed to no key this airlock holds: a first
    // run asked nothing of the sink, so the effect failed; a later one may
    // have reached it before, so no one knows.
    if (entered > 1) return outcome(effect, "unknown", false);
    return outcome(effect, { failed: typed.missing }, false);
  }
  const secrets = { ...a.secrets[name], ...typed.values };
  // A reconcile that answered reached the sink, so a breaker its issue meets is a throw.
  let reached = false;
  try {
    if (next === "reconcile") {
      const known = await handler.call("reconcile", input, key, a.transport, secrets, a.headers[name], { blobs: a.blobs, origin: a.origin });
      reached = true;
      if (!("absent" in known)) return outcome(effect, await stowed(known, key, a.blobs), true);
    }
    const answer = await handler.call("issue", input, key, a.transport, secrets, a.headers[name], { blobs: a.blobs, origin: a.origin }) as Answer;
    return outcome(effect, await stowed(answer, key, a.blobs), false);
  } catch (e) {
    if (e instanceof BreakerOpen && !reached) {
      // Nothing was asked of the sink, so the run the ledger counted did not
      // happen; the queue's backoff brings it back.
      await a.db.query("UPDATE airlock.external_effect_ledger SET entered = entered - 1 WHERE key = $1", [key]);
      throw e;
    }
    if (entered < effect.attempts) throw e;
    console.error(`${key}: no answer after ${entered} runs, so unknown:`, e);
    return outcome(effect, "unknown", false);
  }
}

/** The values of the effect's secret fields the row's reader typed, opened
 * in memory while they last; or why one is missing, as the failure an outcome
 * records. */
async function secretsOf(a: Airlock, effect: Effect, row: Record<string, unknown>, consumed: string[]): Promise<Opened> {
  const fields = effect.secretFields ?? [];
  if (fields.length === 0) return { values: {} };
  const { rows } = await a.db.query(
    "SELECT field, value FROM airlock.secret WHERE tbl = $1 AND row = $2 AND field = ANY($3) AND expires_at > clock_timestamp()",
    [effect.table, row, fields],
  );
  const sealed = Object.fromEntries(rows.map((r) => [r.field as string, r.value as string]));
  consumed.push(...Object.values(sealed));
  return await openFields(a.seal ?? die("an effect reads a secret field, and the airlock holds no seal key"), effect.table, String(row[effect.row[0]]), fields, sealed);
}

/** The secret field's tables brought up to date and the public half of the
 * current key published, where the screen reads what to seal to, in one
 * commit (seal-tables.ts). */
async function publishSeal(db: pg.Pool, keys: SealKeys): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(SEAL_TABLES_SQL);
    await client.query(PUBLISH_SEAL_SQL, [keys.current.kid, keys.current.public]);
    // crud started before the table may have been made: it reads its schema
    // again at this commit, or it answers the page's key read 404.
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function die(message: string): never {
  throw new Error(message);
}
