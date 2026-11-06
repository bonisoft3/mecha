import { assertEquals, assertRejects } from "@std/assert";
import { runMigrations } from "graphile-worker";
import pg from "pg";
import { openBatches } from "./batches.ts";
import { migrateComputeWork } from "./migrate-durex.ts";
import { pgTest, postgres } from "./pg-machine-test.ts";

pgTest("explicit Durex upgrade preserves frozen compute work, publication receipts and machine identities", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  try {
    await runMigrations({ connectionString: server.url });
    await db.query(await Deno.readTextFile(new URL("../durex/testdata/airlock-work.sql", import.meta.url)));
    const source = await Deno.readTextFile(new URL("./batch-machine.sql", import.meta.url));
    const previous = source.replaceAll("durex.work", "airlock.internal_work_ledger").replaceAll("durex.enqueue_work", "airlock.enqueue_work");
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(previous)));
    const fingerprint = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    await db.query(previous);
    await db.query("CREATE SCHEMA compute; CREATE TABLE compute.machine_version (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), fingerprint text NOT NULL)");
    await db.query(await Deno.readTextFile(new URL("./batches.sql", import.meta.url)));
    await db.query(`
      CREATE TABLE output (value integer PRIMARY KEY);
      INSERT INTO airlock.internal_work VALUES ('compute', 'compute_batch', 7267885012713041);
      INSERT INTO airlock.internal_work_pool VALUES ('dead-compute', 'compute');
    `);
    await db.query("INSERT INTO compute.machine_version(fingerprint) VALUES ($1)", [fingerprint]);
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, name] of ["pending", "committed"].entries()) {
      await db.query(`INSERT INTO hybrid_compute_batch.instance(id, version, state)
        SELECT $1, 1, hybrid_compute_batch.step($2::jsonb)->'state'`, [ids[index], JSON.stringify({
        initialize: true, payload: { name, coalesce: 0, attempts: 25, revision: 0 }, context: { tier: "mecha", actor: null, now: 0 }, viewers: [],
      })]);
      await db.query("INSERT INTO compute.capture(instance_id) VALUES ($1)", [ids[index]]);
      await db.query("INSERT INTO compute.definition(name,instance_id,version,reads,parents,ordinal) VALUES ($1,$2,'v1','{games}','{}',$3)", [name, ids[index], index]);
    }
    const client = await db.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SELECT compute.invalidate(NULL)");
      for (const [index, id] of ids.entries()) {
        await client.query("SELECT hybrid_compute_batch.deliver($1, '{\"kind\":\"claim\",\"payload\":{}}')", [id]);
        await client.query("UPDATE compute.capture SET inputs=$2::jsonb WHERE instance_id=$1", [id, index === 0 ? "7" : "11"]);
      }
      await client.query("INSERT INTO output VALUES (11)");
      await client.query("SELECT airlock.settle_work('compute:committed:1', 'done')");
      await client.query("UPDATE compute.capture SET inputs=NULL WHERE instance_id=$1", [ids[1]]);
      await client.query("SELECT compute.after_work('committed', true)");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    await db.query("UPDATE graphile_worker._private_jobs SET locked_by='dead-compute', locked_at=now(), attempts=1");
    await db.query("UPDATE graphile_worker._private_jobs SET attempts=max_attempts WHERE payload->>'key'='compute:committed:1'");
    const states = (await db.query("SELECT id, revision, state FROM hybrid_compute_batch.instance ORDER BY id")).rows;
    const receipts = (await db.query("SELECT count(*)::int n FROM hybrid_compute_batch.receipt")).rows[0].n;
    await db.query("UPDATE compute.machine_version SET fingerprint='unknown'");
    await assertRejects(() => migrateComputeWork(server.url), Error, "not the supported pre-Durex version");
    assertEquals((await db.query("SELECT count(*)::int n FROM airlock.internal_work_ledger")).rows[0].n, 2);
    await db.query("UPDATE compute.machine_version SET fingerprint=$1", [fingerprint]);
    await migrateComputeWork(server.url);
    assertEquals((await db.query("SELECT id, revision, state FROM hybrid_compute_batch.instance ORDER BY id")).rows, states);
    assertEquals((await db.query("SELECT count(*)::int n FROM hybrid_compute_batch.receipt")).rows[0].n, receipts);
    const batches = await openBatches(server.url, ["pending", "committed"].map((name) => ({
      name, version: "v1", reads: ["games"], to: [name],
      capture: () => Promise.reject(new Error("migration must retain frozen input")),
      calculate: (input: unknown) => Promise.resolve(input),
      publish: async (client: pg.PoolClient, output: unknown) => {
        await client.query("INSERT INTO output VALUES ($1)", [output]);
      },
    })), { coalesceMs: 0, pollInterval: 20 });
    try {
      for (let i = 0;; i++) {
        if ((await db.query("SELECT bool_and(requested=completed) AS done FROM compute.batch")).rows[0].done) break;
        if (i >= 500) throw new Error("migrated compute work did not finish");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assertEquals((await db.query("SELECT value FROM output ORDER BY value")).rows, [{ value: 7 }, { value: 11 }]);
      assertEquals((await db.query("SELECT key, outcome->>'kind' AS outcome FROM durex.work ORDER BY key")).rows, [
        { key: "compute:committed:1", outcome: "done" }, { key: "compute:pending:1", outcome: "done" },
      ]);
      assertEquals((await db.query("SELECT to_regclass('airlock.internal_work_ledger') AS old")).rows[0].old, null);
    } finally {
      await batches.close();
    }
  } finally {
    await db.end();
  }
});
