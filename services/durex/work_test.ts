import { assert, assertEquals, assertRejects } from "@std/assert";
import pg from "pg";
import { pgTest, postgres } from "../compute/pg-test.ts";
import { getWork, openWork, settleWork, type Work } from "./work.ts";

async function until(ready: () => Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("internal work did not reach the expected state");
}

async function transaction(db: pg.Pool, body: (client: pg.PoolClient) => Promise<void>) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await body(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const instance = "00000000-0000-0000-0000-000000000001";
async function schema(db: pg.Pool) {
  await db.query(`
    CREATE SCHEMA hybrid_test;
    CREATE TABLE output (value int NOT NULL);
    CREATE TABLE delivered (instance uuid, event jsonb, tx text);
    CREATE FUNCTION hybrid_test.deliver(id uuid, event jsonb) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT FROM durex.work WHERE instance = id AND outcome->>'kind' = 'done') THEN
        RAISE EXCEPTION 'outcome missing before machine delivery';
      END IF;
      IF event->'payload'->>'reject' = 'true' THEN RAISE EXCEPTION 'transition refused'; END IF;
      INSERT INTO public.delivered VALUES (id, event, pg_current_xact_id()::text);
    END;
    $$;
  `);
}
async function enqueue(db: pg.Pool, key = "test:1", input: unknown = { value: 7 }) {
  await db.query("SELECT durex.enqueue_work('test_work', $1, $2, 'test', $3, 'finished', 'failed')", [key, JSON.stringify(input), instance]);
}

pgTest("internal work bootstrap precedes dispatch; receipt, machine and output commit together", async () => {
  await using server = await postgres();
  let bootstrapped = false;
  const work = await openWork(server.url, {
    name: "test",
    lock: "81201",
    taskName: "test_work",
    pollInterval: 20,
    bootstrap: async (db) => {
      await schema(db);
      await enqueue(db);
      bootstrapped = true;
    },
    task: async (payload, db) => {
      assert(bootstrapped);
      await transaction(db, async (client) => {
        const delivery = await getWork(client, (payload as { key: string }).key);
        if (delivery.outcome) return;
        await client.query("INSERT INTO output VALUES ($1)", [(delivery.input as { value: number }).value]);
        await settleWork(client, delivery.key, "done", { answer: 7 });
      });
    },
  });
  try {
    await until(async () => (await work.db.query("SELECT count(*)::int n FROM delivered")).rows[0].n === 1);
    const { rows: [receipt] } = await work.db.query("SELECT outcome, xmin::text AS tx FROM durex.work");
    const { rows: [output] } = await work.db.query("SELECT value, xmin::text AS tx FROM output");
    const { rows: [delivered] } = await work.db.query("SELECT * FROM delivered");
    assertEquals(output, { value: 7, tx: receipt.tx });
    assertEquals(delivered, { instance, event: { kind: "finished", payload: { answer: 7 } }, tx: receipt.tx });
    assertEquals(receipt.outcome, { kind: "done", payload: { answer: 7 } });
    await until(async () => (await work.db.query("SELECT count(*)::int n FROM graphile_worker.jobs")).rows[0].n === 0);
    await enqueue(work.db);
    assertEquals((await work.db.query("SELECT count(*)::int n FROM graphile_worker.jobs")).rows[0].n, 0);
    await assertRejects(() => enqueue(work.db, "test:1", { value: 8 }), Error, "incompatible input");
    await transaction(work.db, (client) => settleWork(client, "test:1", "done", { answer: 7 }));
    await assertRejects(() => transaction(work.db, (client) => settleWork(client, "test:1", "failed")), Error, "different outcome");
    await work.db.query("SELECT graphile_worker.add_job('test_work', '{\"key\":\"test:1\"}'::json)");
    await until(async () => (await work.db.query("SELECT count(*)::int n FROM graphile_worker.jobs")).rows[0].n === 0);
    assertEquals((await work.db.query("SELECT count(*)::int n FROM output")).rows[0].n, 1);
    assertEquals((await work.db.query("SELECT count(*)::int n FROM delivered")).rows[0].n, 1);
  } finally {
    await work.close();
  }
});

pgTest("refused machine delivery rolls back publication and internal receipt", async () => {
  await using server = await postgres();
  const work = await openWork(server.url, {
    name: "rollback",
    lock: "81202",
    taskName: "not_test_work",
    bootstrap: schema,
    task: () => Promise.resolve(),
  });
  try {
    await enqueue(work.db);
    await assertRejects(
      () =>
        transaction(work.db, async (client) => {
          const delivery = await getWork(client, "test:1");
          await client.query("INSERT INTO output VALUES (7)");
          await settleWork(client, delivery.key, "done", { reject: true });
        }),
      Error,
      "transition refused",
    );
    assertEquals((await work.db.query("SELECT * FROM output")).rows, []);
    assertEquals((await work.db.query("SELECT * FROM delivered")).rows, []);
    assertEquals((await work.db.query("SELECT outcome, settled_at FROM durex.work")).rows, [{ outcome: null, settled_at: null }]);
    await transaction(work.db, async (client) => {
      await getWork(client, "test:1");
      await client.query("INSERT INTO output VALUES (7)");
      await settleWork(client, "test:1", "done");
    });
    assertEquals((await work.db.query("SELECT * FROM output")).rows, [{ value: 7 }]);
  } finally {
    await work.close();
  }
});

pgTest("publication committed on the last attempt survives death before Graphile acknowledgement", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  const definition = {
    name: "committed",
    lock: "81208",
    taskName: "test_work",
    bootstrap: () => Promise.resolve(),
    task: () => Promise.reject(new Error("a committed receipt must not execute again")),
  };
  let work = await openWork(server.url, definition);
  try {
    await schema(db);
    await work.close();
    await enqueue(db);
    await transaction(db, async (client) => {
      await getWork(client, "test:1");
      await client.query("INSERT INTO output VALUES (7)");
      await settleWork(client, "test:1", "done");
    });
    await db.query("INSERT INTO durex.pool (pool, owner) VALUES ('committed-before-ack', 'committed')");
    await db.query("UPDATE graphile_worker._private_jobs SET attempts = max_attempts, locked_at = now(), locked_by = 'committed-before-ack'");
    work = await openWork(server.url, definition);
    assertEquals((await db.query("SELECT * FROM graphile_worker.jobs")).rows, []);
    assertEquals((await db.query("SELECT * FROM output")).rows, [{ value: 7 }]);
    assertEquals((await db.query("SELECT count(*)::int n FROM delivered")).rows[0].n, 1);
  } finally {
    await work.close();
    await db.end();
  }
});

pgTest("crashed internal pool recovers immediately without unlocking a live owner or external effect", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  const release = Promise.withResolvers<void>();
  const began = Promise.withResolvers<void>();
  const live = await openWork(server.url, {
    name: "live",
    lock: "81203",
    taskName: "live_task",
    pollInterval: 20,
    bootstrap: async (db) => {
      await db.query("CREATE TABLE probe (stage text)");
      await db.query("SELECT graphile_worker.add_job('live_task', '{}'::json, job_key => 'live')");
    },
    task: async () => {
      began.resolve();
      await release.promise;
    },
  });
  let recovered: Work | undefined;
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/crontab`, "invalid ambient cron must never be loaded");
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--config",
      new URL("./deno.json", import.meta.url).pathname,
      `
        import { openWork } from ${JSON.stringify(new URL("./work.ts", import.meta.url).href)};
        const work = await openWork(${JSON.stringify(server.url)}, {
          name: "crashed", lock: "81204", taskName: "crashed_task", pollInterval: 20,
          bootstrap: async (db) => { await db.query("SELECT graphile_worker.add_job('crashed_task', '{}'::json, job_key => 'crashed')"); },
          task: async (_payload, db) => {
            await db.query("INSERT INTO probe VALUES ('entered')");
            await new Promise(() => {});
          },
        });
        await work.promise;
      `,
    ],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let killed = false;
  try {
    await began.promise;
    await until(async () => (await db.query("SELECT count(*)::int n FROM probe")).rows[0].n === 1);
    const { rows: [deadPool] } = await db.query("SELECT pool FROM durex.pool WHERE owner = 'crashed'");
    const { rows: [livePool] } = await db.query("SELECT pool FROM durex.pool WHERE owner = 'live'");
    assertEquals((await db.query("SELECT locked_by FROM graphile_worker.jobs WHERE key = 'crashed'")).rows[0].locked_by, deadPool.pool);
    await db.query("SELECT graphile_worker.add_job('external_effect', '{}'::json, job_key => 'external')");
    await db.query("UPDATE graphile_worker._private_jobs SET locked_by = 'external-pool', locked_at = now() WHERE key = 'external'");
    await assertRejects(() => openWork(server.url, {
      name: "crashed",
      lock: "81204",
      taskName: "crashed_task",
      bootstrap: () => Promise.reject(new Error("bootstrap should never run")),
      task: () => Promise.resolve(),
    }), Error, "singleton lock");
    child.kill("SIGKILL");
    killed = true;
    const result = await child.output();
    assert(!result.success);
    recovered = await openWork(server.url, {
      name: "crashed",
      lock: "81204",
      taskName: "crashed_task",
      pollInterval: 20,
      bootstrap: async (db) => {
        assertEquals((await db.query("SELECT locked_by FROM graphile_worker.jobs WHERE key = 'crashed'")).rows[0].locked_by, null);
        assertEquals((await db.query("SELECT locked_by FROM graphile_worker.jobs WHERE key = 'live'")).rows[0].locked_by, livePool.pool);
        assertEquals((await db.query("SELECT locked_by FROM graphile_worker.jobs WHERE key = 'external'")).rows[0].locked_by, "external-pool");
      },
      task: async (_payload, db) => {
        const { rows: [registered] } = await db.query("SELECT pool FROM durex.pool WHERE owner = 'crashed'");
        assertEquals((await db.query("SELECT locked_by FROM graphile_worker.jobs WHERE key = 'crashed'")).rows[0].locked_by, registered.pool);
        await db.query("INSERT INTO probe VALUES ('recovered')");
      },
    });
    await until(async () => (await db.query("SELECT count(*)::int n FROM probe")).rows[0].n === 2);
    assertEquals((await db.query("SELECT pool FROM durex.pool WHERE pool = $1", [deadPool.pool])).rows, []);
  } finally {
    if (!killed) {
      child.kill("SIGKILL");
      await child.output();
    }
    release.resolve();
    await recovered?.close();
    await live.close();
    await db.end();
    await Deno.remove(dir, { recursive: true });
  }
});

pgTest("internal retry exhaustion stays visible across restart and owner tasks cannot be shared", async () => {
  await using server = await postgres();
  const definition = {
    name: "exhausted",
    lock: "81205",
    taskName: "broken_task",
    pollInterval: 20,
    bootstrap: () => Promise.resolve(),
    task: () => Promise.reject(new Error("broken calculation")),
  };
  const work = await openWork(server.url, definition);
  try {
    const rejected = assertRejects(() => work.promise, Error, "retries exhausted");
    await work.db.query("SELECT graphile_worker.add_job('broken_task', '{}'::json, max_attempts => 1)");
    await rejected;
    await until(async () => (await work.db.query("SELECT locked_by IS NULL AS released FROM graphile_worker.jobs")).rows[0].released);
    assert((await work.db.query("SELECT last_error FROM graphile_worker.jobs")).rows[0].last_error.includes("broken calculation"));
    await assertRejects(() => openWork(server.url, { ...definition, name: "other", lock: "81206" }), Error, "duplicate key");
    await work.close();
    await assertRejects(() => openWork(server.url, definition), Error, "retries exhausted");
    await assertRejects(() => openWork(server.url, { ...definition, taskName: "different_task" }), Error, "incompatible task");
  } finally {
    await work.close();
  }
});

pgTest("internal work remains private under caller default grants", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  await db.query(`
    CREATE ROLE observer;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON SCHEMAS TO observer;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO observer;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON FUNCTIONS TO observer;
  `);
  const work = await openWork(server.url, {
    name: "private",
    lock: "81207",
    taskName: "private_task",
    bootstrap: () => Promise.resolve(),
    task: () => Promise.resolve(),
  });
  try {
    const { rows: [grants] } = await db.query(`
      SELECT
        has_schema_privilege('observer', 'durex', 'USAGE') AS schema,
        has_table_privilege('observer', 'durex.work', 'SELECT,INSERT,UPDATE,DELETE') AS ledger,
        has_table_privilege('observer', 'durex.pool', 'SELECT,INSERT,UPDATE,DELETE') AS pool,
        has_function_privilege('observer', 'durex.enqueue_work(text,text,jsonb,text,uuid,text,text,timestamptz,integer)', 'EXECUTE') AS enqueue,
        has_function_privilege('observer', 'durex.settle_work(text,text,jsonb)', 'EXECUTE') AS settle
    `);
    assertEquals(grants, { schema: false, ledger: false, pool: false, enqueue: false, settle: false });
  } finally {
    await work.close();
    await db.end();
  }
});
