// The migrate target against volumes of every age, on mecha's own stack.
//
//   deno test --no-config --no-lock --allow-run=docker --allow-read --allow-write --allow-env services/migrate/migrate_test.ts
//
// One compose project per run, removed at the end with the images it tagged.
// The stack bakes one migration (bayt.cue, 01_hello_mood); the later boots add
// to it by mounting a directory over the one the image holds, which leaves the
// image, the runner and every wait around it exactly what ships.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const MECHA = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const RUN = crypto.randomUUID().slice(0, 8);
const PROJECT = `mecha-migrate-${RUN}`;
// bayt names an image the same in every checkout; a tag of this run's own
// keeps a concurrent build elsewhere from retagging what these boots start.
const TAG = `migrate-${RUN}`;
const READERS = ["crud", "electric", "conduit"];

type Out = { ok: boolean; code: number; stdout: string; stderr: string };

async function run(cmd: string, args: string[]): Promise<Out> {
  const out = await new Deno.Command(cmd, {
    args,
    cwd: MECHA,
    // `up` rebuilds, and buildkit's default attestations stamp the build's
    // time into the image: each boot would then hand the database a new image,
    // and compose would recreate it with an empty data directory — the volume
    // these boots exist to keep.
    env: { BAYT_IMAGE_TAG: TAG, BUILDX_NO_DEFAULT_ATTESTATIONS: "1" },
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

type Service = { image?: string; environment?: Record<string, string>; build?: { context?: string } };
type State = { Service: string; State: string; ExitCode: number; ID: string };

const addColumn = (table: string, name: string) => ({ operations: [{ add_column: { table, column: { name, type: "text", nullable: true } } }] });

Deno.test("the migrate target carries every volume forward, and a failure keeps the readers down", async (t) => {
  const scratch = await Deno.makeTempDir({ prefix: "mecha-migrate-" });
  const overrides: string[] = [];
  const compose = (args: string[], files: string[] = []) =>
    run("docker", ["compose", "-p", PROJECT, "-f", ".bayt/compose.yaml", ...[...overrides, ...files].flatMap((f) => ["-f", f]), ...args]);

  const config = JSON.parse(await must(compose(["config", "--format", "json"]), "compose config")) as { services: Record<string, Service> };
  // Bayt names a service <project>-<target>, and the project is named
  // differently here and in mecha's mirror; the database built from this
  // directory says which.
  const database = Object.keys(config.services).find((n) => n.endsWith("-database") && config.services[n].build?.context === MECHA);
  if (database === undefined) throw new Error(`no database service is built from ${MECHA}`);
  const svc = (target: string) => `${database.slice(0, -"database".length)}${target}`;
  const env = (target: string) => config.services[svc(target)].environment ?? {};

  // The door is published on a fixed host port, which a run beside anything
  // else on the machine would collide on; nothing here goes through it.
  overrides.push(`${scratch}/unpublished.yaml`);
  await Deno.writeTextFile(overrides[0], `services:\n  ${svc("caddy")}:\n    ports: !reset []\n`);
  const sets = `${scratch}/sets`;
  const mounted = `${scratch}/mounted.yaml`;
  await Deno.writeTextFile(mounted, `services:\n  ${svc("migrate")}:\n    volumes: ["${sets}:/pgroll:ro"]\n`);

  const db = env("database");
  const sql = (query: string) =>
    must(compose(["exec", "-T", svc("database"), "psql", "-U", db.POSTGRES_USER, "-d", db.POSTGRES_DB, "-X", "-v", "ON_ERROR_STOP=1", "-qtA", "-c", query]), query);
  // Electric's image carries curl and sits on the stack's network, so every
  // HTTP question is asked from inside it rather than through a published port.
  const curl = (...args: string[]) => compose(["exec", "-T", svc("electric"), "curl", "-sS", "-f", ...args]);

  const ledger = async () =>
    (await sql("SELECT name || ' ' || migration_type || ' ' || done FROM pgroll.migrations WHERE schema = 'public' ORDER BY created_at")).split("\n");
  const rows = async (select: string) => JSON.parse(await must(curl(`http://crud:3000/Hello?select=${select}&order=createdAt`), "crud read")) as unknown[];
  const shape = async () =>
    JSON.parse(await must(curl(`http://localhost:3000/v1/shape?table=%22Hello%22&offset=-1&secret=${env("electric").ELECTRIC_SECRET}`), "electric shape")) as {
      value?: Record<string, unknown>;
    }[];
  const states = async (): Promise<Record<string, State>> =>
    Object.fromEntries(
      (await must(compose(["ps", "-a", "--format", "json"]), "compose ps")).split("\n").filter((l) => l !== "")
        .map((l) => JSON.parse(l) as State).map((s) => [s.Service, s]),
    );
  const started = async (target: string) =>
    await must(run("docker", ["inspect", "-f", "{{.State.StartedAt}}", (await states())[svc(target)].ID]), `inspect ${target}`);
  const boot = (files: string[] = []) => compose(["up", "-d", "--wait", "--wait-timeout", "300", ...READERS.map(svc)], files);

  /** Mounts what the image holds, plus `extra`, over the image's own. */
  const offer = async (extra: Record<string, unknown>) => {
    await Deno.remove(sets, { recursive: true }).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
    await Deno.mkdir(sets);
    const held = await must(run("docker", ["create", config.services[svc("migrate")].image!]), "docker create");
    try {
      await must(run("docker", ["cp", `${held}:/pgroll/.`, sets]), "docker cp");
    } finally {
      await must(run("docker", ["rm", held]), "docker rm");
    }
    for (const [name, migration] of Object.entries(extra)) {
      await Deno.writeTextFile(`${sets}/${name}.json`, JSON.stringify(migration));
    }
  };

  try {
    await must(compose(["build", "--with-dependencies", ...READERS.map(svc)]), "compose build");

    await t.step("a volume from before the runner existed is baselined, then migrated", async () => {
      // The cluster as it ran before it was given a migration: no runner.
      await must(compose(["up", "-d", "--wait", "--no-deps", svc("database")]), "database up");
      await must(compose(["up", "-d", "--wait", "--no-deps", svc("crud"), svc("electric")]), "readers up");
      await must(curl("-X", "POST", "-H", "Content-Type: application/json", "-d", '{"message":"before"}', "http://crud:3000/Hello"), "crud write");
      await must(compose(["stop"]), "compose stop");

      await must(boot(), "boot");
      assert.deepEqual(await ledger(), ["00_initdb baseline true", "01_hello_mood pgroll true"]);
      assert.deepEqual(await rows("message,mood"), [{ message: "before", mood: null }]);
      assert.equal((await shape()).some((m) => m.value?.message === "before"), true, "electric serves the table");
      // Electric learns a table's columns from the relation message logical
      // replication sends ahead of the table's next change, not from the
      // catalog: until a write, a shape keeps the columns it started with.
      // The write is what ends the shape, and the one that replaces it
      // carries the column on every row.
      await must(curl("-X", "POST", "-H", "Content-Type: application/json", "-d", '{"message":"after","mood":"calm"}', "http://crud:3000/Hello"), "crud write");
      let served = await shape();
      for (let i = 0; i < 50 && !served.some((m) => m.value?.message === "after"); i++) {
        await new Promise((r) => setTimeout(r, 200));
        served = await shape();
      }
      assert.deepEqual(
        served.filter((m) => m.value !== undefined).map((m) => ({ message: String(m.value!.message), mood: m.value!.mood }))
          .sort((a, b) => a.message.localeCompare(b.message)),
        [{ message: "after", mood: "calm" }, { message: "before", mood: null }],
      );
    });

    await t.step("a boot over an applied set changes nothing", async () => {
      const before = await sql("SELECT json_agg(m ORDER BY created_at) FROM pgroll.migrations m");
      await must(compose(["stop"]), "compose stop");
      await must(boot(), "boot");
      assert.equal(await sql("SELECT json_agg(m ORDER BY created_at) FROM pgroll.migrations m"), before);
      assert.equal((await states())[svc("migrate")].ExitCode, 0);
    });

    await t.step("a migration added under running readers reaches PostgREST without a restart", async () => {
      const since = await started("crud");
      await offer({ "02_hello_tone": addColumn("Hello", "tone") });
      await must(boot([mounted]), "boot");
      assert.deepEqual(await ledger(), ["00_initdb baseline true", "01_hello_mood pgroll true", "02_hello_tone pgroll true"]);
      assert.equal(await started("crud"), since, "crud was not restarted");
      // A write, because a read would pass without the reload: PostgREST puts
      // a selected column into SQL unchecked, and checks a written one against
      // its schema cache, answering 400 for one the cache has not seen. The
      // reload the runner asks for lands asynchronously, hence the retries.
      const write = () =>
        curl("-X", "POST", "-H", "Content-Type: application/json", "-d", '{"message":"live","tone":"warm"}', "http://crud:3000/Hello");
      let got = await write();
      for (let i = 0; i < 50 && !got.ok; i++) {
        await new Promise((r) => setTimeout(r, 200));
        got = await write();
      }
      assert.equal(got.ok, true, got.stderr);
      assert.deepEqual(await rows("message,mood,tone"), [
        { message: "before", mood: null, tone: null },
        { message: "after", mood: "calm", tone: null },
        { message: "live", mood: null, tone: "warm" },
      ]);
      assert.equal((await shape()).some((m) => m.value?.message === "before"), true, "electric still serves the table");
    });

    await t.step("a migration that sorts before an applied one is refused", async () => {
      await offer({ "02_hello_tone": addColumn("Hello", "tone"), "015_late": addColumn("Hello", "late") });
      assert.equal((await boot([mounted])).ok, false);
      assert.notEqual((await states())[svc("migrate")].ExitCode, 0);
      assert.match(await must(compose(["logs", svc("migrate")]), "compose logs"), /015_late sorts before 02_hello_tone/);
    });

    await t.step("a fresh volume gets initdb, the baseline and every migration", async () => {
      await must(compose(["down", "-t", "0"]), "compose down");
      await offer({ "02_hello_tone": addColumn("Hello", "tone") });
      await must(boot([mounted]), "boot");
      assert.deepEqual(await ledger(), ["00_initdb baseline true", "01_hello_mood pgroll true", "02_hello_tone pgroll true"]);
      assert.deepEqual(await rows("message,mood,tone"), []);
    });

    await t.step("a migration that fails stops the boot before any reader starts", async () => {
      await must(compose(["down", "-t", "0"]), "compose down");
      await offer({ "02_hello_tone": addColumn("Hello", "tone"), "03_broken": addColumn("Nowhere", "x") });
      assert.equal((await boot([mounted])).ok, false);
      const now = await states();
      assert.notEqual(now[svc("migrate")].ExitCode, 0);
      for (const reader of READERS) assert.equal(now[svc(reader)].State, "created", `${reader} started`);
      assert.deepEqual(await ledger(), ["00_initdb baseline true", "01_hello_mood pgroll true", "02_hello_tone pgroll true"]);
    });
  } catch (e) {
    const logs = await compose(["logs", svc("migrate")]);
    console.error(logs.stdout, logs.stderr);
    throw e;
  } finally {
    await must(compose(["down", "-v", "-t", "0", "--remove-orphans"]), "compose down");
    // By reference, which untags: an id would take every other tag on the
    // same image with it, `latest` included.
    const tagged = (await must(run("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}", "--filter", `reference=*:${TAG}`]), "image ls"))
      .split("\n").filter((l) => l !== "");
    if (tagged.length > 0) await must(run("docker", ["image", "rm", ...tagged]), "image rm");
    await Deno.remove(scratch, { recursive: true });
  }
});
