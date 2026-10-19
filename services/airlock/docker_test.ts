// The airlock end to end: postgres with Graphile's schema as the initdb step
// writes it (graphile.sql), airlock.sql after roles granted the way mecha's
// and a caller's migrations grant them, a
// guard of the shape pronto emits, the cluster's daprd holding one HTTP output
// binding per effect under the bindings-only allowlist (dapr.yaml), and a sink
// served from this process, so every call
// that crossed the mesh is counted. The airlock's worker runs throughout, as
// it does in a cluster. A crash is reproduced as the state it leaves, written
// in the transition's own commit so the worker cannot take the job first: the
// ledger counting a run begun, the job locked under a pool recorded against an
// advisory key no live session holds, and the sink holding whatever the dead
// run reached.
// Taskfile's integrate:airlock; it needs Docker.

import { assertEquals, assertNotEquals } from "@std/assert";
import grpc from "@grpc/grpc-js";
import { Buffer } from "node:buffer";
import { runMigrations } from "graphile-worker";
import pg from "pg";
import { hold, start } from "./airlock.ts";
import { bindingsTransport, Handler } from "./handler.ts";
import type { Effect } from "./reentry.ts";

const POSTGRES = "postgres:18-trixie@sha256:073e7c8b84e2197f94c8083634640ab37105effe1bc853ca4d5fbece3219b0e8";
const DAPRD = "daprio/daprd:1.16.1@sha256:b977660c4503fe9872b0a94a33067df0dfe0a84878dc054acd8caff82a8c4125";

async function run(cmd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
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

/** The sink: POSTs recorded by idempotency key; an amount of 402 is refused and
 * one of 500 is a sink that answers nothing useful; GET ?key= reconciles. */
function sink() {
  const posts: { key: string; body: unknown; authorization?: string }[] = [];
  const server = Deno.serve({ port: 0, hostname: "0.0.0.0", onListen() {} }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET") {
      const key = url.searchParams.get("key");
      const found = posts.find((p) => p.key === key);
      return found ? Response.json({ id: `ch_${key}` }) : new Response("", { status: 404 });
    }
    const key = req.headers.get("idempotency-key") ?? "";
    const body = await req.json();
    posts.push({ key, body, ...(req.headers.has("authorization") ? { authorization: req.headers.get("authorization")! } : {}) });
    if (body.amount === 402) return Response.json("card_declined", { status: 402 });
    if (body.amount === 500) return new Response("upstream down", { status: 500 });
    return Response.json({ id: `ch_${key}` });
  });
  return { posts, server, port: server.addr.port };
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
    PERFORM graphile_worker.add_job('external_effect', json_build_object('key', k), job_key => k, max_attempts => TG_ARGV[1]::int + 25);
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
};
function base(over: Partial<Effect>): Effect {
  return {
    table: "", field: "status", state: "charging", onDone: "settled", onError: "failed",
    row: ["id"], idempotent: false, attempts: 5, handler: "", ...over,
  };
}

Deno.test({ name: "the airlock runs every effect to an outcome, across crashes, through the mesh", sanitizeOps: false, sanitizeResources: false, fn: async (t) => {
  const tag = crypto.randomUUID().slice(0, 8);
  const pgName = `airlock-pg-${tag}`, daprName = `airlock-daprd-${tag}`;
  const target = sink();
  const components = await Deno.makeTempDir();
  for (const name of Object.keys(EFFECTS)) {
    await Deno.writeTextFile(`${components}/${name}.yaml`, [
      "apiVersion: dapr.io/v1alpha1", "kind: Component", `metadata: {name: ${name}}`,
      "spec: {type: bindings.http, version: v1, metadata: [",
      `  {name: url, value: "http://host.docker.internal:${target.port}"}, {name: errorIfNot2XX, value: "false"}]}`,
    ].join("\n"));
  }
  let db: pg.Pool | undefined;
  let worker: { stop: () => Promise<void> } | undefined;
  try {
    await run("docker", ["run", "-d", "--rm", "--name", pgName, "-e", "POSTGRES_PASSWORD=pw", "-p", "127.0.0.1::5432", POSTGRES]);
    // Copied in, not bind-mounted: a mount names a path on the daemon's host,
    // which is not this one when the daemon runs in another container (dind).
    await run("docker", [
      "create", "--rm", "--name", daprName, "--add-host=host.docker.internal:host-gateway", "-p", "127.0.0.1::3500", "-p", "127.0.0.1::50001", DAPRD,
      "./daprd", "--app-id", "airlock", "--resources-path", "/components", "--config", "/dapr.yaml", "--dapr-http-port", "3500", "--dapr-grpc-port", "50001", "--mode", "standalone",
    ]);
    // The copy lands owned by root with the temp dir's 0700, which shuts out
    // daprd's nonroot user.
    await Deno.chmod(components, 0o755);
    await run("docker", ["cp", `${components}/.`, `${daprName}:/components`]);
    await run("docker", ["cp", new URL("./dapr.yaml", import.meta.url).pathname, `${daprName}:/dapr.yaml`]);
    await run("docker", ["start", daprName]);
    const pgPort = (await run("docker", ["port", pgName, "5432"])).split(":").pop();
    const mesh = `http://127.0.0.1:${(await run("docker", ["port", daprName, "3500"])).split(":").pop()}`;
    const meshGrpc = `127.0.0.1:${(await run("docker", ["port", daprName, "50001"])).split(":").pop()}`;
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
    await db.query(await Deno.readTextFile(new URL("./graphile.sql", import.meta.url)));
    // The database image prepends the ticker's schedule table to airlock.sql
    // (bayt.cue); here the two run in that order.
    await db.query(await Deno.readTextFile(new URL("../ticker/schedule.sql", import.meta.url)));
    await db.query(await Deno.readTextFile(new URL("./airlock.sql", import.meta.url)));
    await db.query(GUARD);
    const effects: Record<string, Effect> = {};
    const handlers: Record<string, Handler> = {};
    for (const [name, { effect, source }] of Object.entries(EFFECTS)) {
      effects[name] = { ...effect, table: `pay_${name}` };
      await db.query(`CREATE TABLE pay_${name} (id text PRIMARY KEY, status text NOT NULL, amount int NOT NULL);
        CREATE TRIGGER guard BEFORE UPDATE ON pay_${name} FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
        EXECUTE FUNCTION guard('${name}', '${effects[name].attempts}');`);
      const file = await Deno.makeTempFile({ suffix: ".js" });
      await Deno.writeTextFile(file, source);
      handlers[name] = await Handler.admit(name, file, effects[name]);
    }
    const airlock = { connectionString, db, effects, handlers, transport: bindingsTransport(mesh), secrets: {}, headers: { vaulted: { Authorization: "Bearer vk-3f9a" } } };
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
        await client.query("UPDATE graphile_worker._private_jobs SET locked_by = $2, locked_at = now(), attempts = 1 WHERE key = $1", [key, `pool-${id}`]);
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
          for (const q of ["SELECT * FROM airlock.external_effect_ledger", "UPDATE airlock.external_effect_ledger SET outcome = '{}'"]) {
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
      await db!.query("DELETE FROM graphile_worker._private_jobs WHERE key = 'notified:w2'");
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
        await client.query("UPDATE graphile_worker._private_jobs SET attempts = max_attempts, last_error = 'the database went away' WHERE key = 'dead:d1'");
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

    await t.step("the daprd offers the bindings API alone: no invoke, so no full URL to any origin", async () => {
      for (const path of ["/v1.0/invoke/http://host.docker.internal:1/method/x", "/v1.0/invoke/charge/method/x", "/v1.0/state/x", "/v1.0/metadata"]) {
        const res = await fetch(`${mesh}${path}`, { method: "POST" });
        await res.body?.cancel();
        assertEquals(res.status, 404, path);
      }
      const res = await fetch(`${mesh}/v1.0/bindings/undeclared`, { method: "POST", body: JSON.stringify({ operation: "post" }) });
      assertEquals(res.status >= 400, true, await res.text());
    });

    await t.step("over gRPC too, which daprd always serves, the daprd offers the bindings API alone", async () => {
      // An empty message to each method's path: no proto needed to tell a
      // method the allowlist removed (UNIMPLEMENTED) from one it kept.
      const client = new grpc.Client(meshGrpc, grpc.credentials.createInsecure());
      const call = (method: string) =>
        new Promise<number>((resolve) =>
          client.makeUnaryRequest(`/dapr.proto.runtime.v1.Dapr/${method}`, (b: Uint8Array) => Buffer.from(b), (b: Buffer) => b, new Uint8Array(0), (err) => resolve(err?.code ?? grpc.status.OK))
        );
      try {
        for (const method of ["InvokeService", "GetMetadata", "GetState", "PublishEvent", "Shutdown"]) {
          assertEquals(await call(method), grpc.status.UNIMPLEMENTED, method);
        }
        assertNotEquals(await call("InvokeBinding"), grpc.status.UNIMPLEMENTED);
      } finally {
        client.close();
      }
    });

    await t.step("the job delivered again after its outcome calls nothing and moves nothing", async () => {
      await db!.query("SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'charge:p1'), job_key => 'charge:p1')");
      await until("the redelivery done", async () => (await db!.query("SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = 'charge:p1'")).rows[0].n === 0);
      assertEquals(await state("charge", "p1"), { status: "settled", entered: 1, kind: "done", reconciled: false });
      assertEquals(calls("charge:p1"), 1);
    });

    await t.step("an outcome delivered again after the program moved the row on, or deleted it, moves nothing and refuses nothing", async () => {
      // Past the outcome's move the row is the program's: it goes where the
      // program takes it, and a delivery that finds it there is done.
      const redelivered = async () => {
        await db!.query("SELECT graphile_worker.add_job('external_effect', json_build_object('key', 'charge:p1'), job_key => 'charge:p1')");
        await until("the redelivery done", async () => (await db!.query("SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE key = 'charge:p1'")).rows[0].n === 0);
      };
      await db!.query("ALTER TABLE pay_charge DISABLE TRIGGER guard; UPDATE pay_charge SET status = 'refunded' WHERE id = 'p1'; ALTER TABLE pay_charge ENABLE TRIGGER guard");
      await redelivered();
      assertEquals((await state("charge", "p1"))?.status, "refunded");
      await db!.query("DELETE FROM pay_charge WHERE id = 'p1'");
      await redelivered();
      assertEquals(await state("charge", "p1"), undefined);
      assertEquals(calls("charge:p1"), 1);
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
          await client.query("SELECT graphile_worker.add_job('external_effect', json_build_object('key', $1::text), job_key => $1::text)", [key]);
        }
        await client.query("UPDATE graphile_worker._private_jobs SET attempts = max_attempts, last_error = 'gone' WHERE key IN ('dead:d2', 'ghost:g1')");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      assertEquals(await settled("dead", "d2"), { status: "settled", entered: 1, kind: "done", reconciled: false });
      assertEquals((await db!.query("SELECT outcome FROM airlock.external_effect_ledger WHERE key = 'ghost:g1'")).rows[0].outcome, null);
      await db!.query("DELETE FROM graphile_worker._private_jobs WHERE key = 'ghost:g1'; DELETE FROM airlock.external_effect_ledger WHERE key = 'ghost:g1'");
    });
  } finally {
    await worker?.stop();
    await db?.end();
    await target.server.shutdown();
    await new Deno.Command("docker", { args: ["rm", "-f", pgName, daprName], stdout: "null", stderr: "null" }).output();
  }
} });
