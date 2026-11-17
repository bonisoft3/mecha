// The airlock end to end: postgres with Graphile's schema as the initdb step
// writes it (graphile.sql), airlock.sql after roles granted the way mecha's
// and a caller's migrations grant them, the job key's function (job_key.sql),
// a guard of the shape pronto emits, the cluster's daprd holding one HTTPEndpoint
// per effect behind its wall (dapr.yaml, #AirlockWall), and a sink served from
// this process, so every call that crossed the mesh is counted. The airlock's worker runs throughout, as
// it does in a cluster. A crash is reproduced as the state it leaves, written
// in the transition's own commit so the worker cannot take the job first: the
// ledger counting a run begun, the job locked under a pool recorded against an
// advisory key no live session holds, and the sink holding whatever the dead
// run reached.
// Taskfile's integrate:airlock; it needs Docker.

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { runMigrations } from "graphile-worker";
import pg from "pg";
import { hold, start } from "./airlock.ts";
import { BreakerOpen, Handler, meshTransport } from "./handler.ts";
import type { Effect } from "./reentry.ts";
import { get, type Read, READ_JOURNAL_SQL, ReadCache } from "./read.ts";
import { generateSealKey, seal as sealValue, sealKeys, sealLabel } from "./seal.ts";
import { SEAL_TABLES_SQL } from "./seal-tables.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const DAPRD = "daprio/daprd:1.16.1@sha256:b977660c4503fe9872b0a94a33067df0dfe0a84878dc054acd8caff82a8c4125";
const CURL = "curlimages/curl:8.5.0@sha256:08e466006f0860e54fc299378de998935333e0e130a15f6f98482e9f8dab3058";

async function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  const out = await new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error(`${cmd} ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  return new TextDecoder().decode(out.stdout).trim();
}

async function until(what: string, ready: () => Promise<boolean>) {
  for (let i = 0; i < 120; i++) {
    if (await ready().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} did not become ready`);
}

/** Past daprd's default 4Mi, as an answer's pictures are. */
const BIG = 5 * 1024 * 1024;

/** The sink: POSTs recorded by idempotency key; an amount of 402 is refused and
 * one of 500 is a sink that answers nothing useful; GET ?key= reconciles. */
function sink() {
  const posts: { key: string; body: unknown; authorization?: string }[] = [];
  const paths: string[] = [];
  const server = Deno.serve({ port: 0, hostname: "0.0.0.0", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    paths.push(url.pathname);
    if (url.pathname === "/v1/big") return new Response(new Uint8Array(BIG), { headers: { "content-type": "text/plain" } });
    if (url.pathname === "/v1/length") return new Response(String((await req.arrayBuffer()).byteLength));
    if (url.pathname.startsWith("/v1/rates/")) return Response.json({ rate: url.pathname.slice("/v1/rates/".length) });
    if (req.method === "GET") {
      const key = url.searchParams.get("key");
      const found = posts.find((p) => p.key === key);
      return found ? Response.json({ id: `ch_${key}` }) : new Response("", { status: 404 });
    }
    const key = req.headers.get("idempotency-key") ?? "";
    if (req.headers.get("content-type") === "application/x-www-form-urlencoded") {
      posts.push({ key, body: await req.text() });
      return Response.json({ id: `ch_${key}` });
    }
    const body = await req.json();
    posts.push({ key, body, ...(req.headers.has("authorization") ? { authorization: req.headers.get("authorization")! } : {}) });
    if (body.amount === 402) return Response.json("card_declined", { status: 402 });
    if (body.amount === 500) return new Response("upstream down", { status: 500 });
    return Response.json({ id: `ch_${key}` });
  });
  return { posts, paths, server, port: server.addr.port };
}

const HANDLER = `
export async function issue(input, sink) {
  const r = await sink.fetch("/v1/charges", { method: "POST", body: input });
  if (r.status === 402) return { failed: r.body };
  if (r.status >= 300) throw new Error("sink answered " + r.status);
  return { done: r.body };
}
`;
const RECONCILING = HANDLER + `
export async function reconcile(input, sink) {
  const r = await sink.fetch("/v1/charges?key=" + encodeURIComponent(sink.key));
  return r.status === 404 ? { absent: true } : { done: r.body };
}
`;

// One machine table per effect, each guarded as pronto's emission guards an
// invoking state: claim and enqueue on entry, leave only by the ledger.
const GUARD = `
CREATE FUNCTION guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k text := TG_ARGV[0] || ':' || COALESCE(NEW.id, OLD.id);
  outcome jsonb;
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'charging' THEN
    INSERT INTO airlock.external_effect_ledger (key, effect, row, input)
    VALUES (k, TG_ARGV[0], jsonb_build_object('id', NEW.id), jsonb_build_object('amount', NEW.amount))
    ON CONFLICT (key) DO NOTHING;
    IF NOT FOUND THEN RAISE EXCEPTION 'external effect % was already performed', k; END IF;
    PERFORM graphile_worker.add_job('external_effect', json_build_object('key', k), job_key => airlock.job_key(k), max_attempts => TG_ARGV[1]::int + 25);
  ELSIF OLD.status = 'charging' THEN
    SELECT l.outcome INTO outcome FROM airlock.external_effect_ledger l WHERE l.key = k;
    IF outcome IS NULL OR outcome->>'target' IS DISTINCT FROM NEW.status THEN
      RAISE EXCEPTION '% leaves charging only by its recorded outcome', k;
    END IF;
  ELSE
    RAISE EXCEPTION 'illegal % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
`;

// A secret field as pronto emits one: its write's first trigger refuses what
// is not sealed without repeating it, holds the sealed value for the
// transaction and leaves the row NULL; a trigger after the write keeps it for
// the row the write wrote.
const STASH = (table: string) => `
CREATE OR REPLACE FUNCTION stash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pin IS NOT NULL THEN
    IF NEW.pin !~ '^seal1\\.[A-Za-z0-9_-]{16}\\.(?:[A-Za-z0-9_-]{128}){4}$' THEN
      RAISE EXCEPTION 'pin takes a sealed value' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM set_config('pronto_secret.k' || md5(TG_TABLE_NAME || NEW.id), NEW.pin, true);
    NEW.pin := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION kept() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sealed text := nullif(current_setting('pronto_secret.k' || md5(TG_TABLE_NAME || NEW.id), true), '');
BEGIN
  IF sealed IS NOT NULL THEN
    PERFORM set_config('pronto_secret.k' || md5(TG_TABLE_NAME || NEW.id), '', true);
    INSERT INTO airlock.secret (tbl, row, field, value, expires_at)
    VALUES (TG_TABLE_NAME, jsonb_build_object('id', NEW.id), 'pin', sealed, clock_timestamp() + interval '300 seconds')
    ON CONFLICT (tbl, row, field) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at;
  END IF;
  RETURN NULL;
END $$;
ALTER TABLE ${table} ADD COLUMN pin text CONSTRAINT ${table}_pin_secret CHECK (pin IS NULL);
CREATE TRIGGER "0_stash" BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION stash();
CREATE TRIGGER "0_stash_kept" AFTER INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION kept();
`;
const PINNED = `
export async function issue(input, sink, secrets) {
  const r = await sink.fetch("/v1/charges", { method: "POST", body: { amount: input.amount, pin: secrets.pin, signed: secrets.PIX_KEY } });
  if (r.status >= 300) throw new Error("sink answered " + r.status);
  return { done: r.body };
}
`;
const EFFECTS: Record<string, { effect: Effect; source: string }> = {
  charge: { effect: base({ reentry: "reconcile" }), source: RECONCILING },
  notify: { effect: base({ idempotent: true, reentry: undefined }), source: HANDLER },
  audit: { effect: base({ reentry: "unknown" }), source: HANDLER },
  flaky: { effect: base({ idempotent: true, reentry: undefined, attempts: 1 }), source: HANDLER },
  last: { effect: base({ reentry: "reconcile", attempts: 1 }), source: RECONCILING },
  retried: { effect: base({ idempotent: true, reentry: undefined, attempts: 2 }), source: HANDLER },
  live: { effect: base({ reentry: "reconcile" }), source: RECONCILING },
  vaulted: { effect: base({ idempotent: true, reentry: undefined, credential: { header: "Authorization", scheme: "Bearer", secret: "VAULT_KEY" } }), source: HANDLER },
  dead: { effect: base({ reentry: "reconcile" }), source: RECONCILING },
  broken: { effect: base({ reentry: "reconcile", attempts: 1 }), source: RECONCILING },
  based: { effect: base({ idempotent: true, reentry: undefined }), source: HANDLER },
  absent: { effect: base({ idempotent: true, reentry: undefined, bridge: { name: "sofascore", targets: ["cloudflare"], simulated: false } }), source: HANDLER },
  pinned: { effect: base({ idempotent: true, reentry: undefined, secrets: ["PIX_KEY"], secretFields: ["pin"] }), source: PINNED },
  // A second effect naming the same field of the same table.
  repinned: { effect: base({ table: "pay_pinned", idempotent: true, reentry: undefined, secrets: ["PIX_KEY"], secretFields: ["pin"] }), source: PINNED },
};
/** A machine's read beside them, through the same daprd and wall. */
const READS: Record<string, Read> = {
  priced: { request: { method: "GET", path: "/v1/rates/{currency}" }, invoke: { table: "pay_priced", field: "status", state: "charging", onDone: "settled", onError: "failed", row: ["id"], count: "asked", incarnation: "lineage" } },
};
function base(over: Partial<Effect>): Effect {
  return {
    table: "", field: "status", state: "charging", onDone: "settled", onError: "failed",
    row: ["id"], key: ["id"], idempotent: false, attempts: 5, handler: "", ...over,
  };
}

Deno.test({ name: "the airlock runs every effect to an outcome, across crashes, through the mesh", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const tag = crypto.randomUUID().slice(0, 8);
  const pgName = `airlock-pg-${tag}`, daprName = `airlock-daprd-${tag}`;
  const target = sink();
  const undeclared = sink();
  const components = await Deno.makeTempDir();
  for (const name of [...Object.keys(EFFECTS), ...Object.keys(READS)]) {
    await Deno.writeTextFile(`${components}/${name}.yaml`, [
      "apiVersion: dapr.io/v1alpha1", "kind: HTTPEndpoint", `metadata: {name: ${name}}`,
      `spec: {baseUrl: "http://host.docker.internal:${target.port}${name === "based" ? "/actions/send" : ""}"}`,
    ].join("\n"));
  }
  // The cluster's own wall and policy, for these effects.
  const generated = (of: string) => run("cue", ["export", ".:cluster", "--out", "text", "-e", `(${of}).out`], new URL("../..", import.meta.url).pathname);
  const names = JSON.stringify([...Object.keys(EFFECTS), ...Object.keys(READS)]);
  await Deno.writeTextFile(`${components}/wall.yaml`, await generated(`#AirlockWall & {effects: ${names}, blobs: true}`));
  await Deno.writeTextFile(`${components}/resiliency.yaml`, await generated(`#AirlockResiliency & {effects: ${names}}`));
  // Stands in for the plane's S3 binding: the wall reads only its path.
  await Deno.writeTextFile(`${components}/blobs.yaml`, [
    "apiVersion: dapr.io/v1alpha1", "kind: Component", "metadata: {name: blobs}",
    `spec: {type: bindings.http, version: v1, metadata: [{name: url, value: "http://host.docker.internal:${target.port}"}]}`,
  ].join("\n"));
  let db: pg.Pool | undefined;
  let worker: { stop: () => Promise<void> } | undefined;
  try {
    await run("docker", ["run", "-d", "--rm", "--name", pgName, "-e", "POSTGRES_PASSWORD=pw", "-p", "127.0.0.1::5432", POSTGRES]);
    // Copied in, not bind-mounted: a mount names a path on the daemon's host,
    // which is not this one when the daemon runs in another container (dind).
    await run("docker", [
      "create", "--rm", "--name", daprName, "--add-host=host.docker.internal:host-gateway", "-p", "127.0.0.1::3500", DAPRD,
      "./daprd", "--app-id", "airlock", "--resources-path", "/components", "--config", "/dapr.yaml", "--dapr-http-port", "3500", "--max-body-size", "64Mi", "--mode", "standalone",
    ]);
    // The copy lands owned by root with the temp dir's 0700, which shuts out
    // daprd's nonroot user.
    await Deno.chmod(components, 0o755);
    await run("docker", ["cp", `${components}/.`, `${daprName}:/components`]);
    await run("docker", ["cp", new URL("./dapr.yaml", import.meta.url).pathname, `${daprName}:/dapr.yaml`]);
    await run("docker", ["start", daprName]);
    const pgPort = (await run("docker", ["port", pgName, "5432"])).split(":").pop();
    const mesh = `http://127.0.0.1:${(await run("docker", ["port", daprName, "3500"])).split(":").pop()}`;
    const connectionString = `postgres://postgres:pw@127.0.0.1:${pgPort}/postgres`;
    await until("postgres", async () => (await run("docker", ["exec", pgName, "pg_isready", "-qU", "postgres"]), true));
    db = new pg.Pool({ connectionString });
    await until("postgres connections", async () => (await db!.query("SELECT 1"), true));
    await until("daprd", async () => (await fetch(`${mesh}/v1.0/healthz/outbound`)).ok);

    // The grants a cluster may have made before airlock.sql runs: mecha's
    // roles migration gives `service` every table created in public, and a
    // caller may grant more for every schema, on the schemas themselves too.
    await db.query(`CREATE ROLE service NOLOGIN BYPASSRLS; CREATE ROLE reader NOLOGIN;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service;
      ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO reader;
      ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO reader;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC;`);
    await db.query(await Deno.readTextFile(new URL("../durex/graphile.sql", import.meta.url)));
    // The database image prepends the ticker's schedule table to airlock.sql
    // (bayt.cue); here the two run in that order.
    await db.query(await Deno.readTextFile(new URL("../ticker/schedule.sql", import.meta.url)));
    await db.query(await Deno.readTextFile(new URL("./airlock.sql", import.meta.url)));
    await db.query(await Deno.readTextFile(new URL("./job_key.sql", import.meta.url)));
    await db.query(GUARD);
    const effects: Record<string, Effect> = {};
    const handlers: Record<string, Handler> = {};
    for (const [name, { effect, source }] of Object.entries(EFFECTS)) {
      effects[name] = { ...effect, table: effect.table || `pay_${name}` };
      if (!effect.table) await db.query(`CREATE TABLE pay_${name} (id text PRIMARY KEY, status text NOT NULL, amount int NOT NULL);
        CREATE TRIGGER guard BEFORE UPDATE ON pay_${name} FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
        EXECUTE FUNCTION guard('${name}', '${effects[name].attempts}');`);
      const file = await Deno.makeTempFile({ suffix: ".js" });
      await Deno.writeTextFile(file, source);
      handlers[name] = await Handler.admit(name, file, effects[name]);
    }
    await db.query(SEAL_TABLES_SQL + READ_JOURNAL_SQL + STASH("pay_pinned"));
    const seal = await sealKeys(await generateSealKey());
    const sealedFor = (table: string, id: string, pin: string) => sealValue(seal.current.public, pin, sealLabel(table, "pin", id));
    // This airlock stands on the local stack, where the `absent` effect's
    // bridge has no simulator, so its real container never runs.
    const airlock = { connectionString, db, effects, handlers, transport: meshTransport(mesh), secrets: { pinned: { PIX_KEY: "pk-7c1e" }, repinned: { PIX_KEY: "pk-7c1e" } }, headers: { vaulted: { Authorization: "Bearer vk-3f9a" } }, target: "local", seal, reads: READS, mesh, cache: new ReadCache() };
    await db.query("CREATE TABLE pay_priced (id text PRIMARY KEY, status text NOT NULL, amount int NOT NULL, asked int NOT NULL DEFAULT 1, lineage text NOT NULL DEFAULT 'l1')");
    const charging = async (effect: string, id: string, amount: number) => {
      await db!.query(`INSERT INTO pay_${effect} VALUES ($1, 'pending', $2)`, [id, amount]);
      await db!.query(`UPDATE pay_${effect} SET status = 'charging' WHERE id = $1`, [id]);
    };
    const state = async (effect: string, id: string) =>
      (await db!.query(
        `SELECT p.status, l.entered, l.outcome->>'kind' AS kind, (l.outcome->>'reconciled')::boolean AS reconciled
           FROM pay_${effect} p JOIN airlock.external_effect_ledger l ON l.key = $1 || ':' || p.id WHERE p.id = $2`,
        [effect, id],
      )).rows[0];
    /** The row once the worker has moved it out of the invoking state. */
    const settled = async (effect: string, id: string) => {
      await until(`${effect}:${id} settled`, async () => (await state(effect, id))?.status !== "charging");
      return await state(effect, id);
    };
    const calls = (key: string) => target.posts.filter((p) => p.key === key).length;
    const unheld = () => crypto.getRandomValues(new BigInt64Array(1))[0].toString();
    // What a run that died after its counter leaves, committed with the
    // transition: the job locked by a pool recorded against `lock`, and the
    // sink holding the call or not.
    const crashed = async (effect: string, id: string, amount: number, reached: boolean, lock = unheld()) => {
      const key = `${effect}:${id}`;
      const client = await db!.connect();
      try {
        await client.query("BEGIN");
        await client.query(`INSERT INTO pay_${effect} VALUES ($1, 'pending', $2)`, [id, amount]);
        await client.query(`UPDATE pay_${effect} SET status = 'charging' WHERE id = $1`, [id]);
        await client.query("UPDATE airlock.external_effect_ledger SET entered = 1 WHERE key = $1", [key]);
        await client.query("UPDATE graphile_worker._private_jobs SET locked_by = $2, locked_at = now(), attempts = 1 WHERE key = airlock.job_key($1)", [key, `pool-${id}`]);
        await client.query("INSERT INTO airlock.pool VALUES ($1, $2::bigint)", [`pool-${id}`, lock]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      if (reached) target.posts.push({ key, body: { amount } });
    };
    const schema = (database: string) =>
      run("docker", ["exec", pgName, "pg_dump", "-U", "postgres", "-d", database, "-s", "-x", "-n", "graphile_worker", "--restrict-key=airlock"]);
    const ledgerOf = async (database: string) => {
      const c = new pg.Client({ connectionString: connectionString.replace(/\/postgres$/, `/${database}`) });
      await c.connect();
      try {
        return (await c.query("SELECT id, breaking FROM graphile_worker.migrations ORDER BY id")).rows;
      } finally {
        await c.end();
      }
    };

    await t.step("graphile.sql leaves Graphile nothing to migrate", async () => {
      const before = await schema("postgres");
      await runMigrations({ connectionString });
      assertEquals(await schema("postgres"), before);
    });

    await t.step("graphile.sql installs what Graphile's own migrator installs", async () => {
      await db!.query("CREATE DATABASE migrated");
      await runMigrations({ connectionString: connectionString.replace(/\/postgres$/, "/migrated") });
      assertEquals(await schema("postgres"), await schema("migrated"));
      assertEquals(await ledgerOf("postgres"), await ledgerOf("migrated"));
    });

    await t.step("the ledger is the owner's alone, whatever was granted before or over public after", async () => {
      const { rows } = await db!.query(`SELECT a.grantee::regrole::text AS grantee, a.privilege_type
          FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = 'airlock' AND a.grantee <> n.nspowner
        UNION ALL
        SELECT a.grantee::regrole::text, a.privilege_type
          FROM pg_class c, aclexplode(c.relacl) a
         WHERE c.relnamespace = 'airlock'::regnamespace AND a.grantee <> c.relowner`);
      assertEquals(rows, []);
      // The form a caller's grants step takes, run after the airlock's: it
      // names `public`, so it reaches nothing the airlock holds.
      await db!.query("GRANT ALL ON ALL TABLES IN SCHEMA public TO service, reader, PUBLIC");
      const client = await db!.connect();
      try {
        for (const role of ["service", "reader"]) {
          await client.query(`SET ROLE ${role}`);
          for (const q of ["SELECT * FROM airlock.external_effect_ledger", "UPDATE airlock.external_effect_ledger SET outcome = '{}'", "SELECT * FROM airlock.read_journal", "UPDATE airlock.read_journal SET outcome = '{}'", "SELECT * FROM airlock.secret", "INSERT INTO airlock.secret VALUES ('t', '{}', 'f', 'v', now())"]) {
            const refused = await client.query(q).then(() => "allowed", (e) => e.code);
            assertEquals(refused, "42501", `${q} as ${role}`);
          }
          await client.query("RESET ROLE");
        }
      } finally {
        await client.query("RESET ROLE");
        client.release();
      }
    });

    await t.step("a guard's enqueue notifies a listener only when its transaction commits", async () => {
      await db!.query("CREATE TABLE pay_notified (id text PRIMARY KEY, status text NOT NULL, amount int NOT NULL)");
      await db!.query(`CREATE TRIGGER guard BEFORE UPDATE ON pay_notified FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
        EXECUTE FUNCTION guard('notified', '5')`);
      await db!.query("INSERT INTO pay_notified VALUES ('w1', 'pending', 1), ('w2', 'pending', 1)");
      const listener = new pg.Client({ connectionString });
      await listener.connect();
      const heard: string[] = [];
      listener.on("notification", (n) => heard.push(n.channel));
      await listener.query('LISTEN "jobs:insert"');
      const writer = await db!.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("UPDATE pay_notified SET status = 'charging' WHERE id = 'w1'");
        await writer.query("ROLLBACK");
        await writer.query("BEGIN");
        await writer.query("UPDATE pay_notified SET status = 'charging' WHERE id = 'w2'");
        await new Promise((r) => setTimeout(r, 300));
        assertEquals(heard, [], "nothing is heard before the commit");
        await writer.query("COMMIT");
        await until("the commit's notification", () => Promise.resolve(heard.length > 0));
        await new Promise((r) => setTimeout(r, 300));
        assertEquals(heard, ["jobs:insert"]);
        assertEquals((await db!.query("SELECT key FROM airlock.external_effect_ledger WHERE effect = 'notified'")).rows, [{ key: "notified:w2" }]);
      } finally {
        writer.release();
        await listener.end();
      }
      // Removed before the worker starts, which knows no effect by that name.
      await db!.query("DELETE FROM graphile_worker._private_jobs WHERE key = airlock.job_key('notified:w2')");
    });

    await t.step("the worker starts once every dead pool is swept, and records its own", async () => {
      const liveness = await hold(connectionString);
      const runner = await start(airlock, liveness.key, { noHandleSignals: true, housekeepingMs: 0 });
      worker = { stop: async () => (await runner.stop(), await liveness.release()) };
      await until("the worker's pool recorded", async () => (await db!.query("SELECT count(*)::int AS n FROM airlock.pool")).rows[0].n === 1);
    });

    await t.step("a sink that acts settles the machine in onDone at once, the call keyed by the ledger", async () => {
      await charging("charge", "p1", 1250);
      assertEquals(await settled("charge", "p1"), { status: "settled", entered: 1, kind: "done", reconciled: false });
      assertEquals(target.posts.filter((p) => p.key === "charge:p1"), [{ key: "charge:p1", body: { amount: 1250 } }]);
    });

    await t.step("a sink that refuses settles it in onError, as failed", async () => {
      await charging("charge", "p2", 402);
      assertEquals(await settled("charge", "p2"), { status: "failed", entered: 1, kind: "failed", reconciled: false });
    });

    await t.step("a bridge with no simulator settles onError at once on the local stack, calling neither handler nor sink", async () => {
      await charging("absent", "p1", 1250);
      assertEquals(await settled("absent", "p1"), { status: "failed", entered: 0, kind: "failed", reconciled: false });
      const { rows: [l] } = await db!.query("SELECT outcome->'data' AS data FROM airlock.external_effect_ledger WHERE key = 'absent:p1'");
      assertEquals(l.data, { bridge: "sofascore", target: "local", reason: "not deployed" });
      assertEquals(calls("absent:p1"), 0);
    });

    await t.step("after a crash past the call, reconcile finds the charge and nothing is sent again", async () => {
      await crashed("charge", "p3", 1, true);
      assertEquals(await settled("charge", "p3"), { status: "settled", entered: 2, kind: "done", reconciled: true });
      assertEquals(calls("charge:p3"), 1);
    });

    await t.step("after a crash before the call, reconcile finds nothing and the charge is sent once", async () => {
      await crashed("charge", "p4", 1, false);
      assertEquals(await settled("charge", "p4"), { status: "settled", entered: 2, kind: "done", reconciled: false });
      assertEquals(calls("charge:p4"), 1);
    });

    await t.step("an idempotent sink is called again with the same key", async () => {
      await crashed("notify", "n1", 1, true);
      assertEquals(await settled("notify", "n1"), { status: "settled", entered: 2, kind: "done", reconciled: false });
      assertEquals(calls("notify:n1"), 2);
    });

    await t.step("reentry unknown gives up without calling", async () => {
      await crashed("audit", "a1", 1, true);
      assertEquals(await settled("audit", "a1"), { status: "failed", entered: 2, kind: "unknown", reconciled: false });
      assertEquals(calls("audit:a1"), 1);
    });

    await t.step("a crash on the last attempt runs out as unknown, calling nothing more", async () => {
      // Graphile counted the dead run and keeps the count across the unlock;
      // the ledger's count is what runs out.
      await crashed("last", "l1", 1, true);
      assertEquals(await settled("last", "l1"), { status: "failed", entered: 2, kind: "unknown", reconciled: false });
      assertEquals(calls("last:l1"), 1);
    });

    await t.step("a job the queue gave up on before any run settles unknown, carrying the queue's last error", async () => {
      // Written with the transition, so the worker never takes the job: the
      // state a delivery that failed before perform leaves past every retry.
      const client = await db!.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO pay_dead VALUES ('d1', 'pending', 1)");
        await client.query("UPDATE pay_dead SET status = 'charging' WHERE id = 'd1'");
        await client.query("UPDATE graphile_worker._private_jobs SET attempts = max_attempts, last_error = 'the database went away' WHERE key = airlock.job_key('dead:d1')");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      assertEquals(await settled("dead", "d1"), { status: "failed", entered: 0, kind: "unknown", reconciled: false });
      assertEquals((await db!.query("SELECT outcome->'data'->>'dead' AS why FROM airlock.external_effect_ledger WHERE key = 'dead:d1'")).rows[0].why, "the database went away");
      assertEquals(calls("dead:d1"), 0);
    });

    await t.step("a credential reaches the sink as a header the host adds, and the ledger never holds it", async () => {
      await charging("vaulted", "v1", 7);
      assertEquals(await settled("vaulted", "v1"), { status: "settled", entered: 1, kind: "done", reconciled: false });
      assertEquals(target.posts.filter((p) => p.key === "vaulted:v1").map((p) => p.authorization), ["Bearer vk-3f9a"]);
      assertEquals(target.posts.filter((p) => p.key === "charge:p1").map((p) => p.authorization), [undefined]);
      const { rows } = await db!.query("SELECT input::text || outcome::text AS text FROM airlock.external_effect_ledger WHERE key = 'vaulted:v1'");
      assertEquals(rows[0].text.includes("vk-3f9a"), false);
    });

    await t.step("the airlock publishes its seal key's public half, which every role reads and none writes", async () => {
      const { rows } = await db!.query("SELECT kid, key FROM public.airlock_seal");
      assertEquals(rows, [{ kid: seal.current.kid, key: seal.current.public }]);
    });

    await t.step("a sealed secret field reaches the sink in the clear, beside the environment's, and only ciphertext was ever held", async () => {
      await db!.query("INSERT INTO pay_pinned VALUES ('s1', 'pending', 9)");
      const sealed = await sealedFor("pay_pinned", "s1", "4321");
      await db!.query("UPDATE pay_pinned SET status = 'charging', pin = $1 WHERE id = 's1'", [sealed]);
      assertEquals(await settled("pinned", "s1"), { status: "settled", entered: 1, kind: "done", reconciled: false });
      assertEquals(target.posts.filter((p) => p.key === "pinned:s1").map((p) => p.body), [{ amount: 9, pin: "4321", signed: "pk-7c1e" }]);
      const { rows: [held] } = await db!.query(`SELECT
          (SELECT count(*)::int FROM airlock.secret) AS secrets,
          (SELECT count(*)::int FROM pay_pinned WHERE pin IS NOT NULL) AS rows,
          (SELECT string_agg(input::text || outcome::text, '') FROM airlock.external_effect_ledger) AS ledger,
          (SELECT string_agg(payload::text || coalesce(last_error, ''), '') FROM graphile_worker._private_jobs) AS queue`);
      assertEquals([held.secrets, held.rows, held.ledger.includes("4321"), held.ledger.includes(sealed), (held.queue ?? "").includes("4321")], [0, 0, false, false, false]);
    });

    await t.step("an outcome delivered again leaves a value typed since for the row's next invocation", async () => {
      await db!.query("UPDATE pay_pinned SET pin = $1 WHERE id = 's1'", [await sealedFor("pay_pinned", "s1", "5678")]);
      await db!.query("SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'pinned:s1'), job_key => airlock.job_key('pinned:s1'))");
      await until("the delivery handled", async () => (await db!.query("SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = airlock.job_key('pinned:s1')")).rows[0].n === 0);
      assertEquals((await db!.query("SELECT count(*)::int AS n FROM airlock.secret WHERE row = '{\"id\": \"s1\"}'")).rows[0].n, 1);
      await db!.query("DELETE FROM airlock.secret");
    });

    await t.step("a value two effects name is handed to both and kept until the second settles", async () => {
      await db!.query("INSERT INTO pay_pinned VALUES ('s6', 'pending', 9)");
      // The second effect's claim on the row, as its interpreter makes one, still waiting.
      await db!.query(`INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES ('repinned:s6', 'repinned', '{"id": "s6"}', '{"amount": 9}')`);
      await db!.query("UPDATE pay_pinned SET status = 'charging', pin = $1 WHERE id = 's6'", [await sealedFor("pay_pinned", "s6", "2468")]);
      assertEquals(await settled("pinned", "s6"), { status: "settled", entered: 1, kind: "done", reconciled: false });
      const held = async () => (await db!.query(`SELECT count(*)::int AS n FROM airlock.secret WHERE row = '{"id": "s6"}'`)).rows[0].n;
      assertEquals(await held(), 1, "kept for the effect still waiting");
      await db!.query("SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'repinned:s6'), job_key => airlock.job_key('repinned:s6'))");
      await until("the second effect settled", async () => (await db!.query("SELECT outcome IS NOT NULL AS done FROM airlock.external_effect_ledger WHERE key = 'repinned:s6'")).rows[0].done);
      assertEquals(target.posts.filter((p) => p.key === "pinned:s6" || p.key === "repinned:s6").map((p) => (p.body as { pin: string }).pin), ["2468", "2468"]);
      assertEquals(await held(), 0, "gone once the last effect naming it settled");
    });

    await t.step("a value in the clear is refused at the write, and the refusal does not repeat it", async () => {
      await db!.query("INSERT INTO pay_pinned VALUES ('s4', 'pending', 9)");
      const refused = await db!.query("UPDATE pay_pinned SET status = 'charging', pin = '4321' WHERE id = 's4'").then(() => null, (e) => e);
      assertEquals(refused?.code, "22023");
      assertEquals(JSON.stringify({ ...refused, message: refused.message }).includes("4321"), false);
      assertEquals((await db!.query("SELECT count(*)::int AS n FROM airlock.secret")).rows[0].n, 0);
    });

    await t.step("a value sealed for another row opens for none, and the first run fails without calling the sink", async () => {
      await db!.query("INSERT INTO pay_pinned VALUES ('s5', 'pending', 9)");
      await db!.query("UPDATE pay_pinned SET status = 'charging', pin = $1 WHERE id = 's5'", [await sealedFor("pay_pinned", "s1", "4321")]);
      assertEquals(await settled("pinned", "s5"), { status: "failed", entered: 1, kind: "failed", reconciled: false });
      assertEquals((await db!.query("SELECT outcome->'data' AS data FROM airlock.external_effect_ledger WHERE key = 'pinned:s5'")).rows[0].data, { secrets: ["pin"], reason: "unsealable" });
      assertEquals(calls("pinned:s5"), 0);
    });

    await t.step("a secret field past its time fails the first run, the sink never called", async () => {
      const client = await db!.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO pay_pinned VALUES ('s2', 'pending', 9)");
        await client.query("UPDATE pay_pinned SET status = 'charging', pin = $1 WHERE id = 's2'", [await sealedFor("pay_pinned", "s2", "1111")]);
        await client.query("UPDATE airlock.secret SET expires_at = clock_timestamp() - interval '1 second'");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      assertEquals(await settled("pinned", "s2"), { status: "failed", entered: 1, kind: "failed", reconciled: false });
      assertEquals((await db!.query("SELECT outcome->'data' AS data FROM airlock.external_effect_ledger WHERE key = 'pinned:s2'")).rows[0].data, { secrets: ["pin"], reason: "absent" });
      assertEquals(calls("pinned:s2"), 0);
      assertEquals((await db!.query("SELECT count(*)::int AS n FROM airlock.secret")).rows[0].n, 0);
    });

    await t.step("a secret typed for an effect that never ran is swept once its time passes", async () => {
      await db!.query("INSERT INTO pay_pinned VALUES ('s3', 'pending', 9)");
      await db!.query("UPDATE pay_pinned SET pin = $1 WHERE id = 's3'", [await sealedFor("pay_pinned", "s3", "2222")]);
      assertEquals((await db!.query("SELECT count(*)::int AS n FROM airlock.secret")).rows[0].n, 1);
      await db!.query("UPDATE airlock.secret SET expires_at = clock_timestamp()");
      await until("the expired secret swept", async () => (await db!.query("SELECT count(*)::int AS n FROM airlock.secret")).rows[0].n === 0);
    });

    await t.step("no answer by the last attempt is unknown, never a guessed failure", async () => {
      await charging("flaky", "f1", 500);
      assertEquals(await settled("flaky", "f1"), { status: "failed", entered: 1, kind: "unknown", reconciled: false });
    });

    await t.step("a throw before the last attempt is retried, counted by the ledger", async () => {
      await charging("retried", "r1", 500);
      assertEquals(await settled("retried", "r1"), { status: "failed", entered: 2, kind: "unknown", reconciled: false });
      assertEquals(calls("retried:r1"), 2);
    });

    await t.step("a pool whose process lives keeps its jobs; its end frees them", async () => {
      const alive = new pg.Client({ connectionString });
      await alive.connect();
      const lock = unheld();
      await alive.query("SELECT pg_advisory_lock($1::bigint)", [lock]);
      await crashed("live", "v1", 1, false, lock);
      // Two of Graphile's empty fetches, each of which sweeps.
      await new Promise((r) => setTimeout(r, 5000));
      assertEquals(await state("live", "v1"), { status: "charging", entered: 1, kind: null, reconciled: null });
      assertEquals(calls("live:v1"), 0);
      await alive.end();
      assertEquals(await settled("live", "v1"), { status: "settled", entered: 2, kind: "done", reconciled: false });
      assertEquals(calls("live:v1"), 1);
    });

    await t.step("the wall keeps a mistaken target from leaving, and lets the plane's binding and daprd's health through", async () => {
      const other = `http://host.docker.internal:${undeclared.port}`;
      for (const path of [`/v1.0/invoke/${other}/method/x`, `/v1.0/invoke/${encodeURIComponent(other)}/method/x`, "/v1.0/invoke/undeclared/method/x", "/x", "/v1.0/state/x", "/v1.0/metadata", "/v1.0/bindings/undeclared"]) {
        const res = await fetch(`${mesh}${path}`, { method: "POST", body: "{}" });
        await res.body?.cancel();
        assertEquals(res.status, 400, path);
      }
      assertEquals(undeclared.paths, []);
      const binding = await fetch(`${mesh}/v1.0/bindings/blobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "get", metadata: { path: "/v1/length" } }) });
      await binding.body?.cancel();
      assertEquals(binding.status, 200);
      const health = await fetch(`${mesh}/v1.0/healthz`);
      await health.body?.cancel();
      assertEquals(health.status, 204);
    });

    await t.step("a sink's own Basic credential passes the wall", async () => {
      const res = await fetch(`${mesh}/v1.0/invoke/charge/method/v1/length`, { method: "POST", headers: { Authorization: `Basic ${btoa("user:pass")}` }, body: "x" });
      assertEquals(await res.text(), "1");
    });

    await t.step("over gRPC, which daprd always serves, invocation does not exist", async () => {
      // A curl in the daprd's network: no proto is needed to tell a method the
      // allowlist removed (status 12, UNIMPLEMENTED) from one it kept.
      const status = async (method: string) =>
        /grpc-status: (\d+)/.exec(await run("docker", ["run", "--rm", "--network", `container:${daprName}`, "--entrypoint", "sh", CURL, "-c",
          `printf '\\0\\0\\0\\0\\0' | curl -si --max-time 5 --http2-prior-knowledge -H 'content-type: application/grpc' --data-binary @- http://127.0.0.1:50001/dapr.proto.runtime.v1.Dapr/${method}`]))?.[1];
      for (const method of ["InvokeService", "GetMetadata", "GetState", "PublishEvent", "Shutdown"]) {
        assertEquals(await status(method), "12", method);
      }
      assertNotEquals(await status("InvokeBinding"), "12");
    });

    await t.step("a declared content type reaches the sink byte for byte, through the real daprd", async () => {
      // The bindings API would deliver "a=1\\u0026b=2", quotes included.
      const answer = await meshTransport(mesh)("charge", "/v1/form", { method: "POST", body: "a=1&b=2", contentType: "application/x-www-form-urlencoded" }, "form:raw", {});
      assertEquals(answer, { status: 200, body: { id: "ch_form:raw" } });
      assertEquals(target.posts.find((p) => p.key === "form:raw")?.body, "a=1&b=2");
    });

    await t.step("past daprd's default size, both ways", async () => {
      const big = await meshTransport(mesh)("charge", "/v1/big", { method: "GET" }, "big", {});
      assertEquals((big.body as string).length, BIG);
      const sent = await meshTransport(mesh)("charge", "/v1/length", { method: "POST", body: "x".repeat(BIG) }, "big", {});
      assertEquals(sent.body, String(BIG));
    });

    await t.step("an endpoint's base path stays beneath the handler's", async () => {
      await meshTransport(mesh)("based", "/x", { method: "POST", body: { amount: 1 } }, "based:1", {});
      assertEquals(target.paths.at(-1), "/actions/send/x");
      // An Activepieces bridge's action is the endpoint itself.
      await meshTransport(mesh)("based", "/", { method: "POST", body: { amount: 1 } }, "based:2", {});
      assertEquals(target.paths.at(-1), "/actions/send");
    });

    await t.step("an open breaker calls nothing and spends no attempt, and the effect runs when it closes", async () => {
      const fail = () => meshTransport(mesh)("broken", "/v1/charges", { method: "POST", body: { amount: 500 } }, "tripping", {});
      for (let i = 0; i < 10; i++) assertEquals((await fail()).status, 500, "the sink's own answer, no retry behind it");
      assertEquals(calls("tripping"), 10);
      await assertRejects(fail, BreakerOpen);
      assertEquals(calls("tripping"), 10);
      // One attempt only: a run counted against an open breaker would settle unknown.
      await charging("broken", "b1", 7);
      await new Promise((r) => setTimeout(r, 2000));
      assertEquals(await state("broken", "b1"), { status: "charging", entered: 0, kind: null, reconciled: null });
      assertEquals(calls("broken:b1"), 0);
      // The breaker's 30s and Graphile's backoff, exponential in the job's attempts.
      for (let i = 0; i < 240 && (await state("broken", "b1")).status === "charging"; i++) await new Promise((r) => setTimeout(r, 1000));
      assertEquals(await state("broken", "b1"), { status: "settled", entered: 1, kind: "done", reconciled: false });
      assertEquals(calls("broken:b1"), 1);
    });

    await t.step("the job delivered again after its outcome calls nothing and moves nothing", async () => {
      await db!.query("SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'charge:p1'), job_key => airlock.job_key('charge:p1'))");
      await until("the redelivery done", async () => (await db!.query("SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = airlock.job_key('charge:p1')")).rows[0].n === 0);
      assertEquals(await state("charge", "p1"), { status: "settled", entered: 1, kind: "done", reconciled: false });
      assertEquals(calls("charge:p1"), 1);
    });

    await t.step("an outcome delivered again after the program moved the row on, or deleted it, moves nothing and refuses nothing", async () => {
      // Past the outcome's move the row is the program's: it goes where the
      // program takes it, and a delivery that finds it there is done.
      const redelivered = async () => {
        await db!.query("SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'charge:p1'), job_key => airlock.job_key('charge:p1'))");
        await until("the redelivery done", async () => (await db!.query("SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = airlock.job_key('charge:p1')")).rows[0].n === 0);
      };
      await db!.query("ALTER TABLE pay_charge DISABLE TRIGGER guard; UPDATE pay_charge SET status = 'refunded' WHERE id = 'p1'; ALTER TABLE pay_charge ENABLE TRIGGER guard");
      await redelivered();
      assertEquals((await state("charge", "p1"))?.status, "refunded");
      await db!.query("DELETE FROM pay_charge WHERE id = 'p1'");
      await redelivered();
      assertEquals(await state("charge", "p1"), undefined);
      assertEquals(calls("charge:p1"), 1);
    });

    await t.step("a late outcome moves only the invocation its key names, never the row back in its state for another", async () => {
      // A machine whose key fields go past its primary key (snapcards' card
      // art: id, run, redraws) puts a row back in its invoking state under a
      // new key; a late delivery for the old key used to move it, and the new
      // invocation's own outcome then found the row gone from its state.
      await db!.query("ALTER TABLE pay_charge DISABLE TRIGGER guard; INSERT INTO pay_charge (id, amount, status) VALUES ('pz', 1, 'charging'); ALTER TABLE pay_charge ENABLE TRIGGER guard");
      await db!.query(`INSERT INTO airlock.external_effect_ledger (key, effect, row, input, entered, outcome)
        VALUES ('charge:earlier', 'charge', '{"id":"pz"}', '{}', 1, '{"target":"settled","kind":"done","data":{},"reconciled":false}')`);
      await db!.query("SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'charge:earlier'), job_key => airlock.job_key('charge:earlier'))");
      await until("the late delivery done", async () => (await db!.query("SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = airlock.job_key('charge:earlier')")).rows[0].n === 0);
      assertEquals((await db!.query("SELECT status FROM pay_charge WHERE id = 'pz'")).rows[0].status, "charging");
    });

    await t.step("a machine's read moves its row with the sink's answer, and one the queue gave up on fails it and is completed", async () => {
      const read = (id: string, dead: boolean) => db!.connect().then(async (client) => {
        try {
          await client.query("BEGIN");
          await client.query("INSERT INTO pay_priced VALUES ($1, 'charging', 1)", [id]);
          await client.query("SELECT graphile_worker.add_job('external_read', json_build_object('effect', 'priced', 'row', json_build_object('id', $1::text), 'n', 1, 'incarnation', 'l1', 'key', 'priced:' || $1 || ':l1:1', 'input', json_build_object('currency', 'USD'), 'digest', 'd'), max_attempts => 5)", [id]);
          if (dead) await client.query("UPDATE graphile_worker._private_jobs SET attempts = max_attempts, last_error = 'gone' WHERE payload->'row'->>'id' = $1", [id]);
          await client.query("COMMIT");
        } finally {
          client.release();
        }
      });
      const status = async (id: string) => (await db!.query("SELECT status FROM pay_priced WHERE id = $1", [id])).rows[0].status;
      await read("r1", false);
      await until("the read's answer", async () => (await status("r1")) !== "charging");
      assertEquals(await status("r1"), "settled");
      assertEquals(target.paths.includes("/v1/rates/USD"), true);
      assertEquals((await db!.query("SELECT n, digest, outcome->>'target' AS target FROM airlock.read_journal WHERE key = 'priced:r1:l1:1'")).rows, [{ n: 1, digest: "d", target: "settled" }]);
      await read("r2", true);
      await until("the dead read", async () => (await status("r2")) !== "charging");
      assertEquals(await status("r2"), "failed");
      await until("the dead read's job completed", async () => (await db!.query("SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE payload->'row'->>'id' = 'r2'")).rows[0].n === 0);
    });

    await t.step("the dead sweep moves a row whose recorded outcome never landed, and one key it cannot settle stops no other", async () => {
      // A row in its invoking state with an outcome recorded and the queue
      // out of attempts: the move is what is owed. Beside it a dead job whose
      // effect no manifest names, which the sweep reports and leaves.
      const client = await db!.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO pay_dead VALUES ('d2', 'charging', 1)");
        await client.query(`INSERT INTO airlock.external_effect_ledger (key, effect, row, input, entered, outcome)
          VALUES ('dead:d2', 'dead', '{"id": "d2"}', '{}', 1, '{"target": "settled", "kind": "done", "reconciled": false}'),
                 ('ghost:g1', 'ghost', '{"id": "g1"}', '{}', 0, NULL)`);
        for (const key of ["dead:d2", "ghost:g1"]) {
          await client.query("SELECT graphile_worker.add_job('external_effect', json_build_object('key', $1::text), job_key => airlock.job_key($1::text))", [key]);
        }
        await client.query("UPDATE graphile_worker._private_jobs SET attempts = max_attempts, last_error = 'gone' WHERE key IN (airlock.job_key('dead:d2'), airlock.job_key('ghost:g1'))");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      assertEquals(await settled("dead", "d2"), { status: "settled", entered: 1, kind: "done", reconciled: false });
      assertEquals((await db!.query("SELECT outcome FROM airlock.external_effect_ledger WHERE key = 'ghost:g1'")).rows[0].outcome, null);
      await db!.query("DELETE FROM graphile_worker._private_jobs WHERE key = airlock.job_key('ghost:g1'); DELETE FROM airlock.external_effect_ledger WHERE key = 'ghost:g1'");
    });
  } finally {
    await worker?.stop();
    await db?.end();
    await target.server.shutdown();
    await undeclared.server.shutdown();
    await new Deno.Command("docker", { args: ["rm", "-f", pgName, daprName], stdout: "null", stderr: "null" }).output();
  }
} });

// A read crosses the same daprd, under the same wall: what HTTP caches read
// must come back through the mesh as the sink sent it, and a revalidation
// reach the sink and its 304 return.
Deno.test({ name: "a read crosses the mesh with HTTP's caching intact", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const asked: { path: string; authorization: string | null; ifNoneMatch: string | null }[] = [];
  const server = Deno.serve({ port: 0, hostname: "0.0.0.0", onListen() {} }, (req) => {
    const url = new URL(req.url);
    asked.push({ path: url.pathname + url.search, authorization: req.headers.get("authorization"), ifNoneMatch: req.headers.get("if-none-match") });
    if (req.headers.get("if-none-match") === '"r1"') return new Response(null, { status: 304, headers: { etag: '"r1"', "cache-control": "public, max-age=1" } });
    if (url.pathname === "/v1/plain") return Response.json({ plain: true });
    return Response.json({ usd: 5.3 }, { headers: { "cache-control": "public, max-age=1", etag: '"r1"', vary: "Authorization" } });
  });
  const tag = crypto.randomUUID().slice(0, 8);
  const daprName = `airlock-read-daprd-${tag}`;
  const components = await Deno.makeTempDir();
  await Deno.writeTextFile(`${components}/rate.yaml`, ["apiVersion: dapr.io/v1alpha1", "kind: HTTPEndpoint", "metadata: {name: rate}", `spec: {baseUrl: "http://host.docker.internal:${server.addr.port}"}`].join("\n"));
  const generated = (of: string) => run("cue", ["export", ".:cluster", "--out", "text", "-e", `(${of}).out`], new URL("../..", import.meta.url).pathname);
  await Deno.writeTextFile(`${components}/wall.yaml`, await generated(`#AirlockWall & {effects: ["rate"], blobs: false}`));
  await Deno.writeTextFile(`${components}/resiliency.yaml`, await generated(`#AirlockResiliency & {effects: ["rate"]}`));
  try {
    await run("docker", [
      "create", "--rm", "--name", daprName, "--add-host=host.docker.internal:host-gateway", "-p", "127.0.0.1::3500", DAPRD,
      "./daprd", "--app-id", "airlock", "--resources-path", "/components", "--config", "/dapr.yaml", "--dapr-http-port", "3500", "--mode", "standalone",
    ]);
    await Deno.chmod(components, 0o755);
    await run("docker", ["cp", `${components}/.`, `${daprName}:/components`]);
    await run("docker", ["cp", new URL("./dapr.yaml", import.meta.url).pathname, `${daprName}:/dapr.yaml`]);
    await run("docker", ["start", daprName]);
    const mesh = `http://127.0.0.1:${(await run("docker", ["port", daprName, "3500"])).split(":").pop()}`;
    await until("daprd", async () => (await fetch(`${mesh}/v1.0/healthz/outbound`)).ok);
    const reach = { mesh, headers: { Authorization: "Bearer rate-key" }, cache: new ReadCache() };
    const rate: Read = { request: { method: "GET", path: "/v1/rates/{currency}{?day}" }, invoke: READS.priced.invoke, cacheControl: "max-age=60", got: { retry: { limit: 0 } } };

    const first = await get("rate", rate, { currency: "USD", day: "2026-11-16" }, reach);
    // daprd adds Origin to Vary; a read sends none, so it varies nothing.
    assertEquals([first.status, first.headers["cache-control"], first.headers["etag"], first.headers["vary"]], [200, "public, max-age=1", '"r1"', "Origin, Authorization"]);
    assertEquals(asked[0], { path: "/v1/rates/USD?day=2026-11-16", authorization: "Bearer rate-key", ifNoneMatch: null });
    assertEquals((await get("rate", rate, { currency: "USD", day: "2026-11-16" }, reach)).fromCache, true);
    assertEquals(asked.length, 1);
    await new Promise((r) => setTimeout(r, 1_100));
    const revalidated = await get("rate", rate, { currency: "USD", day: "2026-11-16" }, reach);
    assertEquals([revalidated.status, revalidated.fromCache, asked.length, asked[1].ifNoneMatch], [200, true, 2, '"r1"']);
    // The default freshness, for a sink that sends none, survives the mesh.
    const plain: Read = { ...rate, request: { method: "GET", path: "/v1/plain" } };
    assertEquals((await get("rate", plain, {}, reach)).headers["cache-control"], "max-age=60");
    // An endpoint the wall does not admit is daprd's refusal, not an answer.
    // An endpoint the wall does not admit reaches no sink: the routerchecker
    // refuses it as daprd's own 400.
    const before = asked.length;
    const refused = await get("absent", rate, { currency: "USD" }, reach);
    assertEquals([refused.status, new TextDecoder().decode(refused.body), asked.length], [400, "invalid router", before]);
  } finally {
    await server.shutdown();
    await new Deno.Command("docker", { args: ["rm", "-f", daprName], stdout: "null", stderr: "null" }).output();
  }
} });
