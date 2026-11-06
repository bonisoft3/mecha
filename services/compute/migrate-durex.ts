import { migrateWork } from "../durex/migrate.ts";

async function fingerprint(source: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function migrateComputeWork(connectionString: string): Promise<void> {
  const source = await Deno.readTextFile(new URL("./batch-machine.sql", import.meta.url));
  const previous = source.replaceAll("durex.work", "airlock.internal_work_ledger").replaceAll("durex.enqueue_work", "airlock.enqueue_work");
  if (source === previous) throw new Error("the compiled compute machine has no Durex invocation");
  const dispatch = source.match(/^CREATE OR REPLACE FUNCTION hybrid_compute_batch[.]dispatch\([\s\S]*?^\$dispatch\$;/m)?.[0];
  if (!dispatch) throw new Error("the compiled compute machine has no dispatcher");
  const before = await fingerprint(previous);
  const after = await fingerprint(source);
  await migrateWork(connectionString, async (client) => {
    const { rows: [version] } = await client.query("SELECT fingerprint FROM compute.machine_version FOR UPDATE");
    if (version?.fingerprint !== before) throw new Error("the installed compute machine is not the supported pre-Durex version");
    await client.query(dispatch);
    await client.query("UPDATE compute.machine_version SET fingerprint = $1", [after]);
  });
}

if (import.meta.main) {
  const connectionString = Deno.env.get("DATABASE_URL");
  if (!connectionString) throw new Error("DATABASE_URL is required");
  await migrateComputeWork(connectionString);
}
