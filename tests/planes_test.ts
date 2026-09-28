// What the database carries for the planes a cluster turns on: the ticker's
// `schedule` table where a schedule is declared, and `auth_uid()` everywhere.
//
//   mise x -- deno test --no-config --no-lock --allow-run=docker,cue --allow-read --allow-write --allow-env --allow-net tests/planes_test.ts
//
// The stack is mecha's own, which declares a schedule and turns auth on, booted
// as a compose project of its own per run and removed at the end with the
// images it tagged.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const MECHA = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const RUN = crypto.randomUUID().slice(0, 8);
const PROJECT = `mecha-planes-${RUN}`;
// bayt names an image the same in every checkout; a tag of this run's own
// keeps a concurrent build elsewhere from retagging what these boots start.
const TAG = `planes-${RUN}`;
const SCHEDULE_STEP = "/docker-entrypoint-initdb.d/020_schedule.sql";

type Out = { ok: boolean; code: number; stdout: string; stderr: string };

async function run(cmd: string, args: string[]): Promise<Out> {
  const out = await new Deno.Command(cmd, {
    args,
    cwd: MECHA,
    env: { BAYT_IMAGE_TAG: TAG },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = (b: Uint8Array) => new TextDecoder().decode(b).trim();
  return { ok: out.success, code: out.code, stdout: text(out.stdout), stderr: text(out.stderr) };
}

async function must(p: Promise<Out>, what: string): Promise<string> {
  const o = await p;
  if (!o.ok) throw new Error(`${what} failed (${o.code}):\n${o.stderr}\n${o.stdout}`);
  return o.stdout;
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** An HS256 token, as the auth service mints one. */
async function sign(claims: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const unsigned = `${b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))}.${b64url(enc.encode(JSON.stringify(claims)))}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${unsigned}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(unsigned))))}`;
}

Deno.test("a cluster places the schedule step only where it declares a schedule", async () => {
  const cluster = (schedules: string[]) =>
    `(#Cluster & {meta: {app: "planes", images: [string]: name: "img"}, state: {migrations: [], pipelines: [], schedules: ${JSON.stringify(schedules)}}})`;
  const copies = JSON.parse(await must(run("cue", ["export", ".:cluster", "-e", `{
    off: ${cluster([])}.surface.targets.database.dockerfile.copy
    on: ${cluster(["tick"])}.surface.targets.database.dockerfile.copy
  }`]), "cue export")) as Record<"off" | "on", { dst: string; from?: { name: string } }[]>;
  assert.deepEqual(copies.off.filter((c) => c.dst === SCHEDULE_STEP), []);
  const placed = copies.on.filter((c) => c.dst === SCHEDULE_STEP);
  assert.equal(placed.length, 1);
  assert.deepEqual(placed[0].from, { name: "img" }, "the step comes out of the cluster's database image");
});

type Service = { image?: string; environment?: Record<string, string>; build?: { context?: string } };

Deno.test("the ticker's table and the token's subject reach the stack's database", async (t) => {
  const config = JSON.parse(
    await must(run("docker", ["compose", "-p", PROJECT, "-f", ".bayt/compose.yaml", "config", "--format", "json"]), "compose config"),
  ) as { services: Record<string, Service> };
  // Bayt names a service <project>-<target>, and the project is named
  // differently here and in mecha's mirror; the database built from this
  // directory says which.
  const database = Object.keys(config.services).find((n) => n.endsWith("-database") && config.services[n].build?.context === MECHA);
  if (database === undefined) throw new Error(`no database service is built from ${MECHA}`);
  const svc = (target: string) => `${database.slice(0, -"database".length)}${target}`;
  const env = (target: string) => config.services[svc(target)].environment ?? {};
  const scratch = await Deno.makeTempDir({ prefix: "mecha-planes-" });
  const overrides = `${scratch}/published.yaml`;
  const compose = (args: string[]) => run("docker", ["compose", "-p", PROJECT, "-f", ".bayt/compose.yaml", "-f", overrides, ...args]);
  // Asked from this side, on ports of their own, so nothing collides with
  // whatever else the machine publishes.
  await Deno.writeTextFile(overrides, `services:\n  ${svc("crud")}:\n    ports: ["3000"]\n  ${svc("ticker")}:\n    ports: ["9998"]\n`);
  const url = async (target: string, port: number) =>
    `http://${(await must(compose(["port", svc(target), String(port)]), `port ${target}`)).split("\n")[0]}`;

  const db = env("database");
  const psql = (container: string[], query: string) =>
    must(run("docker", [...container, "psql", "-U", db.POSTGRES_USER, "-d", db.POSTGRES_DB, "-X", "-v", "ON_ERROR_STOP=1", "-qtA", "-c", query]), query);
  const sql = (query: string) => psql(["compose", "-p", PROJECT, "-f", ".bayt/compose.yaml", "-f", overrides, "exec", "-T", svc("database")], query);

  const bare = `${PROJECT}-bare`;
  try {
    await must(compose(["build", "--with-dependencies", svc("database"), svc("crud"), svc("ticker")]), "compose build");

    await t.step("the image alone creates no schedule, and its auth_uid() is null outside a request", async () => {
      const image = config.services[svc("database-image")].image!;
      await must(run("docker", ["run", "-d", "--name", bare, "-e", `POSTGRES_USER=${db.POSTGRES_USER}`, "-e", `POSTGRES_PASSWORD=${db.POSTGRES_PASSWORD}`, "-e", `POSTGRES_DB=${db.POSTGRES_DB}`, image]), "docker run");
      // initdb serves its scripts over the unix socket and then restarts; the
      // server on TCP is the one that stays.
      const ready = () => run("docker", ["exec", bare, "pg_isready", "-h", "127.0.0.1", "-U", db.POSTGRES_USER]);
      for (let i = 0; i < 240 && !(await ready()).ok; i++) await new Promise((r) => setTimeout(r, 250));
      assert.equal(await psql(["exec", bare], "SELECT to_regclass('public.schedule') IS NULL AND auth_uid() IS NULL"), "t");
    });

    await must(compose(["up", "-d", "--wait", "--wait-timeout", "300", svc("database"), svc("crud"), svc("ticker")]), "up");

    await t.step("with a schedule declared, the table is there and closed to every reader of the door", async () => {
      assert.equal(
        await sql(`SELECT c.relrowsecurity, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid), has_table_privilege('anon', c.oid, 'SELECT')
                     FROM pg_class c WHERE c.oid = 'public.schedule'::regclass`),
        "t|0|f",
      );
    });

    await t.step("the ticker reads it through crud", async () => {
      await sql(`INSERT INTO schedule (name, cron, emits_entity, last_tick_at) VALUES ('planes', '0 0 1 1 *', 'nowhere', now())`);
      const poke = async () => {
        try {
          return await fetch(`${await url("ticker", 9998)}/poke?caller=planes`, {
            method: "POST",
            headers: { authorization: `Bearer ${env("ticker").SERVICE_JWT}` },
          });
        } catch (e) {
          // The container is up before deno is listening.
          if (e instanceof TypeError) return undefined;
          throw e;
        }
      };
      let res = await poke();
      for (let i = 0; i < 40 && res === undefined; i++) {
        await new Promise((r) => setTimeout(r, 250));
        res = await poke();
      }
      assert.ok(res !== undefined, "the ticker never answered");
      const report = await res.json();
      assert.equal(res.status, 200, JSON.stringify(report));
      assert.deepEqual(report.schedules, [{ schedule: "planes", emitted: 0, late: 0, held: 0, behind: false }]);
    });

    await t.step("auth_uid() is the token's sub under crud, and null without a token", async () => {
      const crud = await url("crud", 3000);
      const sub = crypto.randomUUID();
      const token = await sign({ role: "anon", sub }, env("crud").PGRST_JWT_SECRET);
      const signed = await fetch(`${crud}/rpc/auth_uid`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(signed.status, 200);
      assert.equal(await signed.json(), sub);
      const anonymous = await fetch(`${crud}/rpc/auth_uid`);
      assert.equal(anonymous.status, 200);
      assert.equal(await anonymous.json(), null);
    });
  } finally {
    await run("docker", ["rm", "-f", bare]);
    await must(compose(["down", "-v", "-t", "0", "--remove-orphans"]), "compose down");
    // By reference, which untags: an id would take every other tag on the
    // same image with it, `latest` included.
    const tagged = (await must(run("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}", "--filter", `reference=*:${TAG}`]), "image ls"))
      .split("\n").filter((l) => l !== "");
    if (tagged.length > 0) await must(run("docker", ["image", "rm", ...tagged]), "image rm");
    await Deno.remove(scratch, { recursive: true });
  }
});
