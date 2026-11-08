import { run, runMigrations, type Runner } from "npm:graphile-worker@0.18.0";
import { EventEmitter } from "node:events";
import pg from "npm:pg@8.16.3";

export type WorkSpec = {
  name: string;
  lock: string;
  taskName: string;
  pollInterval?: number;
  bootstrap(db: pg.Pool): Promise<void>;
  task(payload: unknown, db: pg.Pool): Promise<void>;
};

export type Work = {
  db: pg.Pool;
  promise: Promise<void>;
  close(): Promise<void>;
};

export type WorkDelivery = {
  key: string;
  task: string;
  input: unknown;
  machine: string;
  instance: string;
  done_event: string;
  failed_event: string;
  outcome: { kind: "done" | "failed"; payload: unknown } | null;
};

export async function getWork(client: pg.PoolClient, key: string): Promise<WorkDelivery> {
  const { rows: [work] } = await client.query<WorkDelivery>("SELECT * FROM durex.work WHERE key = $1 FOR UPDATE", [key]);
  if (!work) throw new Error(`durex.work holds no ${key}`);
  return work;
}

export async function settleWork(client: pg.PoolClient, key: string, kind: "done" | "failed", payload: unknown = {}): Promise<void> {
  await client.query("SELECT durex.settle_work($1, $2, $3::jsonb)", [key, kind, JSON.stringify(payload)]);
}

export async function openWork(connectionString: string, spec: WorkSpec): Promise<Work> {
  if (!spec.name || !spec.taskName) throw new Error("internal work requires an owner and task name");
  if (!/^-?\d+$/.test(spec.lock)) throw new Error("internal work lock must be a bigint");
  if (!Number.isFinite(spec.pollInterval ?? 1000) || (spec.pollInterval ?? 1000) <= 0) {
    throw new Error("internal work pollInterval must be positive");
  }
  const db = new pg.Pool({ connectionString });
  const lock = new pg.Client({ connectionString });
  const failure = Promise.withResolvers<never>();
  failure.promise.catch(() => {});
  db.on("error", failure.reject);
  let runner: Runner | undefined;
  let closing: Promise<void> | undefined;
  let connected = false;
  const lost = () => {
    throw new Error(`${spec.name} singleton connection lost`);
  };
  function close(): Promise<void> {
    return closing ??= (async () => {
      try {
        if (runner) await runner.stop();
      } finally {
        try {
          await db.end();
        } finally {
          lock.off("error", lost);
          lock.off("end", lost);
          if (connected) await lock.end();
        }
      }
    })();
  }

  try {
    await lock.connect();
    connected = true;
    const { rows: [held] } = await lock.query("SELECT pg_try_advisory_lock($1::bigint) AS held", [spec.lock]);
    if (!held.held) throw new Error(`another ${spec.name} instance holds the singleton lock`);
    lock.on("error", lost);
    lock.on("end", lost);
    await runMigrations({ connectionString });
    await db.query(await Deno.readTextFile(new URL("./work.sql", import.meta.url)));
    await db.query("INSERT INTO durex.worker (name, task, lock) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING", [
      spec.name,
      spec.taskName,
      spec.lock,
    ]);
    const { rows: [owner] } = await db.query("SELECT task, lock::text FROM durex.worker WHERE name = $1", [spec.name]);
    if (owner.task !== spec.taskName || owner.lock !== BigInt(spec.lock).toString()) {
      throw new Error(`internal work ${spec.name} has incompatible task or singleton lock`);
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const { rows: pools } = await client.query("SELECT pool FROM durex.pool WHERE owner = $1", [spec.name]);
      for (const { pool } of pools) await client.query("SELECT graphile_worker.force_unlock_workers(ARRAY[$1])", [pool]);
      await client.query("DELETE FROM durex.pool WHERE owner = $1", [spec.name]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await spec.bootstrap(db);
    await db.query(
      `SELECT graphile_worker.complete_jobs(ARRAY(
        SELECT j.id FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        JOIN durex.work l ON l.key = j.payload->>'key' AND l.task = t.identifier
        WHERE t.identifier = $1 AND l.outcome IS NOT NULL
      ))`,
      [spec.taskName],
    );
    const { rows: exhausted } = await db.query(
      `SELECT j.id, j.payload, j.last_error FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE t.identifier = $1 AND j.attempts >= j.max_attempts`,
      [spec.taskName],
    );
    if (exhausted.length) throw new Error(`${spec.name} retries exhausted: ${JSON.stringify(exhausted)}`);

    const events = new EventEmitter();
    let recorded: Promise<unknown> | undefined;
    events.on("pool:create", ({ workerPool }) => {
      recorded = db.query("INSERT INTO durex.pool (pool, owner) VALUES ($1, $2)", [workerPool.id, spec.name]);
      recorded.catch(failure.reject);
    });
    events.on("job:failed", ({ job, error }) => failure.reject(new Error(`${spec.name} retries exhausted for ${job.id}`, { cause: error })));
    runner = await run({
      connectionString,
      taskList: { [spec.taskName]: (payload) => spec.task(payload, db) },
      parsedCronItems: [],
      concurrency: 1,
      noHandleSignals: true,
      pollInterval: spec.pollInterval ?? 1000,
      events,
      preset: {
        worker: { localQueue: { size: -1 } },
        plugins: [{
          name: "DurexPoolRegistration",
          version: "1",
          worker: {
            hooks: {
              startWorker: async () => {
                // Recovery must identify the pool before Graphile locks a job.
                if (!recorded) throw new Error("Graphile did not announce its internal work pool");
                await recorded;
              },
            },
          },
        }],
      },
    });
    return { db, promise: Promise.race([runner.promise, failure.promise]), close };
  } catch (error) {
    await close();
    throw error;
  }
}
