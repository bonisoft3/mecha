import type pg from "pg";
import { sqlIdentifier } from "./native-sources.ts";

const delay = () => new Promise((resolve) => setTimeout(resolve, 100));

export async function dropOwnedSlots(client: pg.PoolClient, slots: string[]) {
  for (const slot of slots) {
    const deadline = Date.now() + 30000;
    for (;;) {
      const { rows: [held] } = await client.query(
        "SELECT active FROM pg_replication_slots WHERE slot_name=$1", [slot],
      );
      if (!held) break;
      if (!held.active) {
        await client.query("SELECT pg_drop_replication_slot($1)", [slot]);
        break;
      }
      if (Date.now() > deadline) throw new Error("owned CDC slot did not stop");
      await delay();
    }
  }
}

async function retirePipeline(url: string) {
  const request = async (suffix: string, method = "GET") => {
    const response = await fetch(url + suffix, { method, signal: AbortSignal.timeout(30000) });
    if (response.status === 404) { await response.text(); return null; }
    if (!response.ok) {
      await response.text();
      throw new Error(`retire native pipeline ${method}: ${response.status}`);
    }
    return response;
  };
  const existing = await request("");
  if (!existing) return;
  await existing.text();
  const stop = await request("/stop?force=true", "POST");
  if (!stop) return;
  await stop.text();
  const deadline = Date.now() + 600000;
  for (;;) {
    const response = await request("");
    if (!response) return;
    const state = await response.json();
    if (state.deployment_status === "Stopped") break;
    if (Date.now() > deadline) throw new Error("retired native pipeline did not stop");
    await delay();
  }
  await (await request("", "DELETE"))?.text();
}

/** Called under the coordinator singleton; registry rows remain until every resource is retired. */
export async function reconcileNativeResources(db: pg.Pool, names: string[], legacyEndpoint?: string) {
  const client = await db.connect();
  try {
    const { rows: [present] } = await client.query(`SELECT
      to_regclass('compute.native_epoch') IS NOT NULL AS epochs,
      to_regclass('compute.native_sources') IS NOT NULL AS sources`);
    if (!present.epochs && !present.sources) return;
    if (present.epochs) await client.query(`ALTER TABLE compute.native_epoch
      ADD COLUMN IF NOT EXISTS source_schema text,
      ADD COLUMN IF NOT EXISTS pipeline_url text`);
    const epochs = present.epochs
      ? (await client.query("SELECT * FROM compute.native_epoch WHERE NOT (name=ANY($1::text[])) ORDER BY name", [names])).rows
      : [];
    const sources = present.sources
      ? (await client.query("SELECT name,source_schema FROM compute.native_sources WHERE NOT (name=ANY($1::text[])) ORDER BY name", [names])).rows
      : [];
    for (const name of new Set([...epochs, ...sources].map((r) => r.name))) {
      if (!/^[a-z][a-z0-9_-]{0,99}$/.test(name)) throw new Error("invalid owned native pipeline name");
      const epoch = epochs.find((r) => r.name === name);
      const schemas = new Set<string>(sources.filter((r) => r.name === name).map((r) => r.source_schema));
      if (epoch?.source_schema) schemas.add(epoch.source_schema);
      for (const schema of schemas) {
        if (!/^duckstream_[0-9a-f]{24}$/.test(schema)) throw new Error("invalid owned carrier schema");
      }
      if (epoch) {
        const url = epoch.pipeline_url ?? (legacyEndpoint ? `${legacyEndpoint.replace(/\/$/, "")}/v0/pipelines/${name}` : undefined);
        if (!url) throw new Error(`FELDERA_URL required to retire legacy native pipeline ${name}`);
        await retirePipeline(url);
        await dropOwnedSlots(client, epoch.slots);
        for (const publication of epoch.publications) await client.query(`DROP PUBLICATION IF EXISTS ${sqlIdentifier(publication)}`);
      }
      await client.query("BEGIN");
      try {
        const { rows: triggers } = await client.query(`SELECT t.tgname,c.relname
          FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
          JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace f ON f.oid=p.pronamespace
          WHERE NOT t.tgisinternal AND n.nspname='public' AND f.nspname='compute' AND p.proname='repair_sink'
          AND t.tgargs=convert_to($1,'UTF8') || decode('00','hex')`, [name]);
        for (const trigger of triggers) await client.query(`DROP TRIGGER ${sqlIdentifier(trigger.tgname)} ON public.${sqlIdentifier(trigger.relname)}`);
        for (const table of ["stream_owner", "stream_partition", "stream_state"]) {
          const { rows: [exists] } = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [`compute.${table}`]);
          if (exists.present) await client.query(`DELETE FROM compute.${sqlIdentifier(table)} WHERE name=$1`, [name]);
        }
        for (const schema of schemas) await client.query(`DROP SCHEMA IF EXISTS ${sqlIdentifier(schema)} CASCADE`);
        if (present.sources) await client.query("DELETE FROM compute.native_sources WHERE name=$1", [name]);
        if (present.epochs) await client.query("DELETE FROM compute.native_epoch WHERE name=$1", [name]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally { client.release(); }
}
