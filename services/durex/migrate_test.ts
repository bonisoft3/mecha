import { assertEquals, assertRejects } from "@std/assert";
import { runMigrations } from "graphile-worker";
import pg from "pg";
import { pgTest, postgres } from "../compute/pg-test.ts";
import { migrateWork } from "./migrate.ts";
import { openWork } from "./work.ts";

async function legacy(connectionString: string, db: pg.Pool) {
  await runMigrations({ connectionString });
  await db.query(await Deno.readTextFile(new URL("./testdata/airlock-work.sql", import.meta.url)));
  await db.query("INSERT INTO airlock.internal_work VALUES ('test', 'test_task', 92301)");
}

pgTest("Durex migration refuses live owners and rolls back when a durable dispatcher remains on Airlock", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  const owner = new pg.Client({ connectionString: server.url });
  await owner.connect();
  try {
    await legacy(server.url, db);
    await owner.query("SELECT pg_advisory_lock(92301::bigint)");
    await assertRejects(() => migrateWork(server.url, () => Promise.resolve()), Error, "stop internal worker test");
    await owner.query("SELECT pg_advisory_unlock(92301::bigint)");
    await db.query(`
      CREATE SCHEMA hybrid_unknown;
      CREATE FUNCTION hybrid_unknown.dispatch() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN PERFORM 1 FROM "airlock" . "internal_work_ledger"; END $$;
    `);
    await assertRejects(() => migrateWork(server.url, () => Promise.resolve()), Error, "upgrade every durable dispatcher");
    assertEquals((await db.query("SELECT to_regclass('airlock.internal_work_ledger')::text AS legacy, to_regclass('durex.work')::text AS current")).rows[0], {
      legacy: "airlock.internal_work_ledger", current: null,
    });
    await assertRejects(() => openWork(server.url, {
      name: "test", taskName: "test_task", lock: "92301", bootstrap: () => Promise.resolve(), task: () => Promise.resolve(),
    }), Error, "explicit internal-work migration");
  } finally {
    await owner.end();
    await db.end();
  }
});

pgTest("Durex migration preserves table identity, pending jobs and committed receipts without touching external effects", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  try {
    await legacy(server.url, db);
    await db.query(`
      CREATE ROLE observer;
      ALTER DEFAULT PRIVILEGES GRANT ALL ON SCHEMAS TO observer;
      ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO observer;
      ALTER DEFAULT PRIVILEGES GRANT ALL ON FUNCTIONS TO observer;
      CREATE TABLE airlock.external_effect_ledger (key text PRIMARY KEY, outcome jsonb);
      INSERT INTO airlock.external_effect_ledger VALUES ('external:1', '{"kind":"unknown"}');
      CREATE TABLE airlock.pool (pool text PRIMARY KEY, lock bigint);
      INSERT INTO airlock.pool VALUES ('live-external', 92302);
      CREATE SCHEMA hybrid_test;
      CREATE TABLE public.delivered (id uuid, event jsonb);
      CREATE FUNCTION hybrid_test.deliver(id uuid, event jsonb) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO public.delivered VALUES (id, event); END $$;
      SELECT airlock.enqueue_work('test_task', 'pending', '{"value":7}', 'test', '00000000-0000-0000-0000-000000000001', 'done', 'failed');
      SELECT airlock.enqueue_work('test_task', 'committed', '{"value":11}', 'test', '00000000-0000-0000-0000-000000000002', 'done', 'failed');
      SELECT airlock.settle_work('committed', 'done');
      INSERT INTO airlock.internal_work_pool VALUES ('dead-internal', 'test');
      UPDATE graphile_worker._private_jobs SET locked_by='dead-internal', locked_at=now(), attempts=1;
      UPDATE graphile_worker._private_jobs SET attempts=max_attempts WHERE payload->>'key'='committed';
      SELECT graphile_worker.add_job('external_effect', '{}', job_key=>'external:1');
      UPDATE graphile_worker._private_jobs SET locked_by='live-external', locked_at=now() WHERE key='external:1';
    `);
    const before = (await db.query("SELECT 'airlock.internal_work_ledger'::regclass::oid AS oid")).rows[0].oid;
    const jobs = (await db.query("SELECT id, key, locked_by FROM graphile_worker.jobs ORDER BY id")).rows;
    await migrateWork(server.url, () => Promise.resolve());
    assertEquals((await db.query("SELECT 'durex.work'::regclass::oid AS oid")).rows[0].oid, before);
    assertEquals((await db.query("SELECT id, key, locked_by FROM graphile_worker.jobs ORDER BY id")).rows, jobs);
    assertEquals((await db.query("SELECT key, input, outcome FROM durex.work ORDER BY key")).rows, [
      { key: "committed", input: { value: 11 }, outcome: { kind: "done", payload: {} } },
      { key: "pending", input: { value: 7 }, outcome: null },
    ]);
    assertEquals((await db.query("SELECT * FROM airlock.external_effect_ledger")).rows, [{ key: "external:1", outcome: { kind: "unknown" } }]);
    assertEquals((await db.query("SELECT * FROM airlock.pool")).rows, [{ pool: "live-external", lock: "92302" }]);
    assertEquals((await db.query(`SELECT
      to_regclass('airlock.internal_work_ledger') AS ledger,
      to_regprocedure('airlock.enqueue_work(text,text,jsonb,text,uuid,text,text,timestamptz,integer)') AS enqueue,
      to_regprocedure('airlock.settle_work(text,text,jsonb)') AS settle,
      has_schema_privilege('observer', 'durex', 'USAGE') AS schema_access,
      has_table_privilege('observer', 'durex.work', 'SELECT,INSERT,UPDATE,DELETE') AS table_access,
      has_function_privilege('observer', 'durex.settle_work(text,text,jsonb)', 'EXECUTE') AS settle_access
    `)).rows[0], { ledger: null, enqueue: null, settle: null, schema_access: false, table_access: false, settle_access: false });
    const ran = Promise.withResolvers<void>();
    const work = await openWork(server.url, {
      name: "test", taskName: "test_task", lock: "92301", pollInterval: 20,
      bootstrap: () => Promise.resolve(),
      task: async (payload, db) => {
        assertEquals(payload, { key: "pending" });
        await db.query("SELECT durex.settle_work('pending', 'done')");
        ran.resolve();
      },
    });
    try {
      await ran.promise;
      assertEquals((await db.query("SELECT count(*)::int AS n FROM public.delivered")).rows[0].n, 2);
      assertEquals((await db.query("SELECT locked_by FROM graphile_worker.jobs WHERE key='external:1'")).rows[0].locked_by, "live-external");
    } finally {
      await work.close();
    }
  } finally {
    await db.end();
  }
});
