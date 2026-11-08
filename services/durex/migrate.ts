import pg from "npm:pg@8.16.3";

export async function migrateWork(
  connectionString: string,
  upgradeMachines: (client: pg.Client) => Promise<void>,
): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      const { rows: [legacy] } = await client.query("SELECT to_regclass('airlock.internal_work') AS owner");
      if (!legacy.owner) throw new Error("no legacy internal-work registry to migrate");
      const { rows: owners } = await client.query("SELECT name, lock::text FROM airlock.internal_work ORDER BY name");
      for (const owner of owners) {
        const { rows: [lock] } = await client.query("SELECT pg_try_advisory_xact_lock($1::bigint) AS held", [owner.lock]);
        if (!lock.held) throw new Error(`stop internal worker ${owner.name} before migrating Durex`);
      }
      await client.query("LOCK TABLE airlock.internal_work, airlock.internal_work_pool, airlock.internal_work_ledger IN ACCESS EXCLUSIVE MODE");
      const { rows: [existing] } = await client.query("SELECT to_regclass('durex.worker') AS owner, to_regclass('durex.pool') AS pool, to_regclass('durex.work') AS work");
      if (existing.owner || existing.pool || existing.work) throw new Error("Durex storage already exists; migration does not merge registries");
      await client.query(`
        CREATE SCHEMA IF NOT EXISTS durex;
        REVOKE ALL ON SCHEMA durex FROM PUBLIC;
        ALTER TABLE airlock.internal_work SET SCHEMA durex;
        ALTER TABLE durex.internal_work RENAME TO worker;
        ALTER TABLE durex.worker RENAME CONSTRAINT internal_work_pkey TO worker_pkey;
        ALTER TABLE durex.worker RENAME CONSTRAINT internal_work_task_key TO worker_task_key;
        ALTER TABLE durex.worker RENAME CONSTRAINT internal_work_lock_key TO worker_lock_key;
        ALTER TABLE airlock.internal_work_pool SET SCHEMA durex;
        ALTER TABLE durex.internal_work_pool RENAME TO pool;
        ALTER TABLE durex.pool RENAME CONSTRAINT internal_work_pool_pkey TO pool_pkey;
        ALTER TABLE durex.pool RENAME CONSTRAINT internal_work_pool_owner_fkey TO pool_owner_fkey;
        ALTER TABLE airlock.internal_work_ledger SET SCHEMA durex;
        ALTER TABLE durex.internal_work_ledger RENAME TO work;
        ALTER TABLE durex.work RENAME CONSTRAINT internal_work_ledger_pkey TO work_pkey;
        ALTER TABLE durex.work RENAME CONSTRAINT internal_work_ledger_check TO work_check;
        DROP FUNCTION airlock.enqueue_work(text,text,jsonb,text,uuid,text,text,timestamptz,integer);
        DROP FUNCTION airlock.settle_work(text,text,jsonb);
      `);
      await client.query(await Deno.readTextFile(new URL("./work.sql", import.meta.url)));
      await upgradeMachines(client);
      const { rows: stale } = await client.query(`
        SELECT p.oid::regprocedure::text AS function
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prosrc ~ '"?airlock"?[[:space:]]*[.][[:space:]]*"?(internal_work|enqueue_work|settle_work)'
        ORDER BY p.oid::regprocedure::text
      `);
      if (stale.length) throw new Error(`upgrade every durable dispatcher before migrating Durex: ${stale.map((r) => r.function).join(", ")}`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}
