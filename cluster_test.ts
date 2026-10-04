// What a cluster refuses of the steps its database runs at initdb, and which
// services its change feed brings.
//
//   deno test --no-config --no-lock --allow-read --allow-run=cue cluster_test.ts

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const MECHA = fileURLToPath(new URL(".", import.meta.url));

type State = { migrations: string[]; pipelines: { name: string; file: string }[]; schedules: string[] };

/** `field` of a cluster given `state` and `capabilities`, as `cue export` answers it. */
async function exported(state: Partial<State>, field: string, capabilities: Record<string, boolean> = {}) {
  const given: State = { migrations: [], pipelines: [], schedules: [], ...state };
  const cluster = `#Cluster & {meta: {app: "t", images: [string]: name: "img"}, state: ${JSON.stringify(given)}, capabilities: ${JSON.stringify(capabilities)}}`;
  const out = await new Deno.Command("cue", {
    args: ["export", ".:cluster", "-e", `(${cluster}).${field}`],
    cwd: MECHA,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  return { ok: out.success, value: out.success ? JSON.parse(text(out.stdout)) : undefined, stderr: text(out.stderr) };
}

const copied = (state: Partial<State>) => exported(state, "surface.targets.database.dockerfile.copy[0].srcs");

// The refusals below are only refusals if this passes.
Deno.test("steps that each hold digits of their own are copied as given", async () => {
  const migrations = ["m/000_a.sql", "m/004_b.sql", "fixtures/020_c.sql"];
  const got = await copied({ migrations });
  assert.equal(got.ok, true, got.stderr);
  assert.deepEqual(got.value, migrations);
});

// Postgres globs the initdb directory under en_US.utf8, which skips
// punctuation, so it ran 002a_rls.sql before 002_grants.sql while the replay,
// sorting by byte, applied them the other way round. Names that open with
// three digits no other step holds are ordered by those digits under both.
Deno.test("a step whose name does not open with three digits and `_` is refused", async () => {
  for (const name of ["m/002a_x.sql", "m/identity.sql", "m/02_x.sql"]) {
    const got = await copied({ migrations: [name] });
    assert.equal(got.ok, false, name);
    assert.match(got.stderr, /out of bound/, name);
  }
});

Deno.test("two steps holding the same digits are refused", async () => {
  const got = await copied({ migrations: ["m/004_a.sql", "n/004_b.sql"] });
  assert.equal(got.ok, false);
  assert.match(got.stderr, /_initdb\."004": conflicting values/);
});

Deno.test("a step taking the digits of a step mecha places is refused", async () => {
  const floor = await copied({ migrations: ["m/003_x.sql"] });
  assert.equal(floor.ok, false);
  assert.match(floor.stderr, /_initdb\."003": conflicting values/);

  const scheduled = await copied({ migrations: ["m/020_x.sql"], schedules: ["tick"] });
  assert.equal(scheduled.ok, false);
  assert.match(scheduled.stderr, /_initdb\."020": conflicting values/);
});

const FEED = ["conduit", "mesh-events", "redis", "transform"];

/** The change feed's services a cluster runs, and the ones its launch waits on. */
async function feed(state: Partial<State>, capabilities: Record<string, boolean> = {}) {
  const targets = await exported(state, "surface.targets", capabilities);
  assert.equal(targets.ok, true, targets.stderr);
  const t = targets.value as Record<string, { compose?: { depends_on?: Record<string, unknown> } }>;
  const waited = Object.keys(t.launch.compose?.depends_on ?? {});
  return { run: FEED.filter((n) => n in t), waited: FEED.filter((n) => waited.includes(n)) };
}

// truco's conduit crash-looped: it has a database and no pipeline, so the
// feed's publication named no table and conduit refused its source.
Deno.test("a cluster given neither a pipeline nor a schedule runs no change feed", async () => {
  assert.deepEqual(await feed({}), { run: [], waited: [] });
});

Deno.test("a pipeline starts its worker, while a schedule only needs the feed", async () => {
  const all = { run: FEED, waited: FEED };
  assert.deepEqual(await feed({ pipelines: [{ name: "p", file: "p.yaml" }] }), all);
  const withoutWorker = { run: FEED.filter((n) => n !== "transform"), waited: FEED.filter((n) => n !== "transform") };
  assert.deepEqual(await feed({ schedules: ["tick"] }), withoutWorker);
  assert.deepEqual(await feed({}, { capture: true }), withoutWorker, "stated on, it runs without either");
});

Deno.test("a cluster given a pipeline refuses the change feed off", async () => {
  const got = await exported({ pipelines: [{ name: "p", file: "p.yaml" }] }, "capabilities", { capture: false });
  assert.equal(got.ok, false);
  assert.match(got.stderr, /capabilities\.capture: conflicting values/);
});

// An app that takes mecha's images by name builds on these pins in every
// checkout, so one that could move under it, without a release version and
// a digest, is refused.
async function pinOf(pin: string) {
  const out = await new Deno.Command("cue", {
    args: ["export", ".:cluster", "-e", `(#Published & {database: ${JSON.stringify(pin)}}).database`],
    cwd: MECHA,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { ok: out.success, stderr: new TextDecoder().decode(out.stderr) };
}
const digest = "sha256:" + "a".repeat(64);

Deno.test("a pin naming a release and a digest is taken", async () => {
  const got = await pinOf(`bonitao/mecha-database:0.2.0@${digest}`);
  assert.equal(got.ok, true, got.stderr);
});

Deno.test("a pin without a digest is refused", async () => {
  const got = await pinOf("bonitao/mecha-database:0.2.0");
  assert.equal(got.ok, false);
  assert.match(got.stderr, /database: invalid value/);
});

Deno.test("a pin by a tag that is not a release is refused", async () => {
  const got = await pinOf(`bonitao/mecha-database:latest@${digest}`);
  assert.equal(got.ok, false);
  assert.match(got.stderr, /database: invalid value/);
});

Deno.test("a pin under another service's key is refused", async () => {
  const got = await pinOf(`bonitao/mecha-auth:0.2.0@${digest}`);
  assert.equal(got.ok, false);
  assert.match(got.stderr, /database: invalid value/);
});

// A release tagged with a prerelease version publishes one.
Deno.test("a pin naming a prerelease is taken", async () => {
  const got = await pinOf(`bonitao/mecha-database:0.3.0-rc.1@${digest}`);
  assert.equal(got.ok, true, got.stderr);
});

Deno.test("a pin under a key that names no image is refused", async () => {
  const out = await new Deno.Command("cue", {
    args: ["export", ".:cluster", "-e", `(#Published & {"mesh-image": "bonitao/mecha-mesh-image:0.2.0@${digest}"})`],
    cwd: MECHA,
    stderr: "piped",
  }).output();
  assert.equal(out.success, false);
});

// The release builds what the pins name: one list, read twice.
Deno.test("the release builds exactly the published images", async () => {
  const out = await new Deno.Command("cue", { args: ["export", ".:cluster", "-e", "#Images"], cwd: MECHA, stdout: "piped" }).output();
  assert.equal(out.success, true);
  const images: string[] = JSON.parse(new TextDecoder().decode(out.stdout));
  const cd = await Deno.readTextFile(`${MECHA}.github/workflows/cd.yml`);
  const matrix = cd.match(/^\s+service: (\[.*\])$/m);
  assert.ok(matrix, "cd.yml lists its services as one inline matrix");
  assert.deepEqual(matrix[1].slice(1, -1).split(",").map((s) => s.trim()), images);
});

// The migration runner is the database image run as a runner: pgroll and the
// script ship there, so one image serves both and one pin names it.
Deno.test("the migrate runner takes the database image", async () => {
  const cluster = `#Cluster & {meta: {app: "t", images: [string]: name: "img"}, state: {migrations: [], pipelines: [], schedules: [], pgroll: {"01_a": {operations: []}}}}`;
  const out = await new Deno.Command("cue", {
    args: ["export", ".:cluster", "-e", `{from: (${cluster}).surface.targets.migrate.dockerfile.from, entrypoint: (${cluster}).surface.targets.migrate.dockerfile.entrypoint}`],
    cwd: MECHA, stdout: "piped", stderr: "piped",
  }).output();
  assert.equal(out.success, true, new TextDecoder().decode(out.stderr));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(out.stdout)), { from: { name: "img" }, entrypoint: ["/migrate.sh"] });
});

// The blob store is rclone's own image: the bucket made and the server
// started by its entrypoint, no image of mecha's.
Deno.test("the blob store runs rclone's own image", async () => {
  const got = await exported({}, "surface.targets[\"rclone-s3\"].dockerfile", { blobs: true });
  assert.equal(got.ok, true, got.stderr);
  assert.match(got.value.from.name, /^rclone\/rclone:[0-9.]+@sha256:[0-9a-f]{64}$/);
  assert.match(got.value.entrypoint.join(" "), /mkdir -p .*RCLONE_LOCAL_BUCKET.* && exec rclone serve s3/);
});

Deno.test("a cluster takes the published images and no others", async () => {
  const out = await new Deno.Command("cue", {
    args: ["export", ".:cluster", "-e", "{images: [for k, _ in #Cluster.meta.images {k}], published: #Images}"],
    cwd: MECHA, stdout: "piped", stderr: "piped",
  }).output();
  assert.equal(out.success, true, new TextDecoder().decode(out.stderr));
  const { images, published } = JSON.parse(new TextDecoder().decode(out.stdout));
  assert.deepEqual([...images].sort(), [...published].sort());
  assert.deepEqual([...published].sort(), ["auth", "clock", "compute", "conduit", "database", "mesh", "ticker"]);
});
