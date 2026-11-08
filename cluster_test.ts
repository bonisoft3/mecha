// What a cluster refuses of the steps its database runs at initdb, which
// services its change feed brings, and where it places the airlock.
//
//   deno test --no-config --no-lock --allow-read --allow-run=cue cluster_test.ts

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ENDOWABLE } from "./services/compute/language.ts";

const MECHA = fileURLToPath(new URL(".", import.meta.url));

type Effect = { name: string; origin?: string; bridge?: string; ai?: "text" | "image"; tier?: "cheap" | "heavy"; handler?: string; endpoint?: string; secrets?: string[] };
type Bridge = { name: string; container: string; port?: number; action?: string; targets?: string[]; simulator?: Record<string, unknown>; appliance?: Record<string, unknown> };
type State = {
  migrations: string[];
  pipelines: { name: string; file: string }[];
  schedules: string[];
  computations: { name: string; file: string; to: string[]; wasm: string[]; onComplete?: string; feldera?: string }[];
  duckstreamEngine?: "duckdb-snapshot" | "feldera";
  effects?: Effect[];
  effectInterpreters?: string;
  pgroll?: Record<string, { operations: unknown[] }>;
  pgrollDir?: string;
  bridges?: Bridge[];
};

const cluster = (state: Partial<State>, capabilities: Record<string, unknown>) => {
  const given: State = { migrations: [], pipelines: [], schedules: [], computations: [], ...(state.effects?.length ? { effectInterpreters: "SELECT 1;" } : {}), ...state };
  return `#Cluster & {meta: {app: "t", images: [string]: name: "img", bounds: {authStatementMs: 5000, tickerCallMs: 35000}}, state: ${JSON.stringify(given)}, capabilities: ${JSON.stringify(capabilities)}}`;
};

/** `field` of a cluster given `state` and `capabilities`, as `cue export` answers it. */
async function exported(state: Partial<State>, field: string, capabilities: Record<string, unknown> = {}) {
  return await evaluated(`(${cluster(state, capabilities)}).${field}`);
}

/** `field` of the cluster lowered into a bayt project named `p`. */
async function lowered(state: Partial<State>, field: string) {
  return await evaluated(`(#Runtime & {project: "p", cluster: ${cluster(state, {})}}).${field}`);
}

async function evaluated(expression: string) {
  const out = await new Deno.Command("cue", {
    args: ["export", ".:cluster", "-e", expression],
    cwd: MECHA,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  return { ok: out.success, value: out.success ? JSON.parse(text(out.stdout)) : undefined, stderr: text(out.stderr) };
}

const copied = (state: Partial<State>) => exported(state, "surface.targets.database.dockerfile.copy[0].srcs");

Deno.test("database guards accept a single refusal or ordered nonempty checks", async () => {
  for (const guard of [
    { sql: "true", reason: "busy" },
    { checks: [{ sql: "true", reason: "guest" }, { sql: "false", reason: "busy" }] },
  ]) {
    const got = await evaluated(`#MachineSetup.guards & {admit: ${JSON.stringify(guard)}}`);
    assert.equal(got.ok, true, got.stderr);
    assert.deepEqual(got.value.admit, guard);
  }
  for (const guard of [
    { checks: [] },
    { checks: [{ sql: "true", reason: "Invalid" }] },
    { checks: [{ sql: "true" }] },
    { sql: "true", reason: "busy", checks: [{ sql: "false", reason: "guest" }] },
  ]) {
    const got = await evaluated(`#MachineSetup.guards & {admit: ${JSON.stringify(guard)}}`);
    assert.equal(got.ok, false, JSON.stringify(guard));
  }
});

Deno.test("a computation alone gets a durable CDC consumer without a clock", async () => {
  const got = await exported({
    computations: [{ name: "c", file: "c.js", to: ["sink"], wasm: [] }],
  }, "surface.targets");
  assert.equal(got.ok, true, got.stderr);
  assert.equal(got.value.clock, undefined);
  assert.equal(got.value.feldera, undefined);
  assert.equal(got.value.compute.compose.environment.DUCKSTREAM_ENGINE, "${DUCKSTREAM_ENGINE:-duckdb-snapshot}");
  assert.equal(got.value.ticker, undefined);
  assert.equal(got.value.launch.compose.depends_on.transform.condition, "service_started");
  assert.equal(got.value.launch.compose.depends_on.conduit.condition, "service_healthy");
  assert.equal(got.value.compute.compose.depends_on.conduit.condition, "service_healthy");
  assert.equal(got.value.compute.compose.environment.CDC_SLOT, "t_conduit_slot");
  assert.ok(got.value.redis);
  assert.ok(got.value.conduit);
  assert.deepEqual(got.value.transform.dockerfile.cmd, [
    "streams",
    "--no-api",
    "-r",
    "/cdc-trace.yaml",
    "/compute-events.yaml",
  ]);
  assert.equal(
    got.value.transform.compose.environment.COMPUTE_GROUP,
    "t-compute",
  );
  // Compute opens its port after its bootstrap run; an invalidation delivered
  // before that is refused and spends the consumer's bounded retries.
  assert.equal(
    got.value.transform.compose.depends_on.compute.condition,
    "service_healthy",
  );
  assert.equal(got.value.launch.compose.depends_on.compute.condition, "service_healthy");
  assert.deepEqual(got.value.compute.compose.healthcheck.test, ["CMD", "portcheck", "--port", "9997"]);
  assert.match(got.value.transform.dockerfile.epilogue[0], /label: cdc_trace_join/);
  assert.match(
    got.value.transform.dockerfile.epilogue[1],
    /client_id: compute/,
  );
  assert.equal(
    "every" in
      JSON.parse(got.value.compute.compose.environment.COMPUTATIONS)[0],
    false,
  );
});

Deno.test("compute configuration carries only declared completion RPCs and refuses invalid identifiers", async () => {
  const computation = { name: "chances", file: "chances.js", to: ["chance"], wasm: [] };
  const field = "surface.targets.compute.compose.environment.COMPUTATIONS";
  const plain = await exported({ computations: [computation] }, field);
  assert.equal(plain.ok, true, plain.stderr);
  assert.equal("onComplete" in JSON.parse(plain.value)[0], false);
  for (const onComplete of ["capture_team_odds_history", "_" + "a".repeat(62)]) {
    const declared = await exported({ computations: [{ ...computation, onComplete }] }, field);
    assert.equal(declared.ok, true, declared.stderr);
    assert.equal(JSON.parse(declared.value)[0].onComplete, onComplete);
  }
  for (const onComplete of ["", "Capture", "rpc/capture", "capture-name", "a".repeat(64)]) {
    const refused = await exported({ computations: [{ ...computation, onComplete }] }, field);
    assert.equal(refused.ok, false, onComplete);
    assert.match(refused.stderr, /onComplete: invalid value/);
  }
});

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

  const scheduled = await copied({ migrations: ["m/800_x.sql"], schedules: ["tick"] });
  assert.equal(scheduled.ok, false);
  assert.match(scheduled.stderr, /_initdb\."800": conflicting values/);
});

// GolAberto's own steps hold 010 through 047, the schedule's old 020 among them.
Deno.test("a schedule leaves the low hundreds to the caller's steps", async () => {
  const got = await copied({ migrations: ["m/020_x.sql", "m/021_y.sql"], schedules: ["tick"] });
  assert.equal(got.ok, true, got.stderr);
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

const AIRLOCK = ["airlock", "airlock-mesh", "airlock-upgrade"];
const PROBE: Effect = { name: "probe", origin: "https://sink.example.test" };

type Targets = Record<string, {
  dockerfile: { cmd?: unknown; entrypoint?: string[]; copy?: { srcs: string[]; dst: string; from?: unknown }[] };
  compose: { depends_on?: Record<string, unknown>; environment?: Record<string, string>; networks?: unknown };
}>;

async function targets(state: Partial<State>): Promise<Targets> {
  const got = await exported(state, "surface.targets");
  assert.equal(got.ok, true, got.stderr);
  return got.value;
}

// The airlock exists only where a program declares an effect, as the ticker
// exists only where one declares a schedule: placed anywhere else it would be
// a worker listening for jobs nobody enqueues, and the steps a database that
// never claims a ledger runs for nothing.
Deno.test("a cluster with no effect places no airlock, no steps of its own and no networks", async () => {
  for (const state of [{}, { schedules: ["tick"] }, { pipelines: [{ name: "p", file: "p.yaml" }] }]) {
    const t = await targets(state);
    assert.deepEqual(AIRLOCK.filter((n) => n in t), [], JSON.stringify(state));
    assert.deepEqual(Object.keys(t.launch.compose.depends_on ?? {}).filter((n) => n.startsWith("airlock")), []);
    const dsts = (t.database.dockerfile.copy ?? []).map((c) => c.dst);
    assert.deepEqual(dsts.filter((d) => /\/01[12]_/.test(d)), []);
    assert.equal((await exported(state, "surface.networks")).ok, false, "no networks to declare");
  }
});

Deno.test("an effect places the airlock and its daprd, and the ticker and clock to wake them, and launch waits on them", async () => {
  const t = await targets({ effects: [PROBE] });
  assert.deepEqual(AIRLOCK.filter((n) => n in t), AIRLOCK);
  assert.deepEqual(t.launch.compose.depends_on?.airlock, { condition: "service_healthy" });
  assert.deepEqual(t.launch.compose.depends_on?.clock, { condition: "service_started" });
  assert.equal("airlock-clock" in t, false, "the worker hears an enqueue at its commit; the platform's ticker wakes a cluster asleep");
  // The wake reaches what a tick needs up: the airlock alone here, no change
  // feed being on; mesh-events alone for a schedule; both for both.
  assert.equal(t.ticker.compose.environment?.WAKE_URLS, "http://airlock:9997/healthz");
  assert.equal((await targets({ schedules: ["tick"] })).ticker.compose.environment?.WAKE_URLS, "http://mesh-events:3500/v1.0/healthz/outbound");
  assert.equal((await targets({ schedules: ["tick"], effects: [PROBE] })).ticker.compose.environment?.WAKE_URLS, "http://mesh-events:3500/v1.0/healthz/outbound,http://airlock:9997/healthz");
  assert.deepEqual(Object.keys(t.airlock.compose.environment ?? {}).sort(), ["AIRLOCK_DIR", "DATABASE_URL", "MESH_URL"]);
  assert.deepEqual(t.airlock.dockerfile.cmd, [
    "run", "--frozen", "--unstable-worker-options", "--allow-net=database:5432,airlock-mesh:3500,0.0.0.0:9997",
    "--allow-read", "--allow-env", "--allow-sys", "main.ts",
  ]);
  assert.deepEqual(t.airlock.dockerfile.copy, [
    { srcs: ["services/airlock/effects.json"], dst: "/airlock/effects.json" },
    { srcs: ["effects/probe.js"], dst: "/airlock/effects/probe.js" },
  ]);
  // The daprd holds the program's bindings and mecha's bindings-only allowlist,
  // and runs under it.
  assert.deepEqual(t["airlock-mesh"].dockerfile.copy?.map(({ srcs, dst, from }) => ({ srcs, dst, from: from !== undefined })), [
    { srcs: ["/app/airlock/dapr.yaml"], dst: "/dapr/config.yaml", from: true },
    { srcs: ["services/airlock/dapr/probe.yaml"], dst: "/dapr/airlock/probe.yaml", from: false },
  ]);
  assert.ok((t["airlock-mesh"].dockerfile.entrypoint ?? []).join(" ").includes("--config /dapr/config.yaml"));
  assert.equal(t["airlock-mesh"].compose.environment?.AIRLOCK_ORIGINS, "https://sink.example.test");
  const staged = (t.database.dockerfile.copy ?? []).filter((c) => c.from !== undefined);
  // The schedule table rides inside 012 (bayt.cue), ahead of a caller's steps.
  assert.deepEqual(staged.map((c) => [c.srcs, c.dst]), [
    [["/usr/share/mecha/initdb/899_role_passwords.sh"], "/docker-entrypoint-initdb.d/899_role_passwords.sh"],
    [["/usr/share/mecha/initdb/011_graphile_worker.sql"], "/docker-entrypoint-initdb.d/011_graphile_worker.sql"],
    [["/usr/share/mecha/initdb/012_airlock.sql"], "/docker-entrypoint-initdb.d/012_airlock.sql"],
  ]);
  const networks = await exported({ effects: [PROBE] }, "surface.networks");
  assert.deepEqual(networks.value, { airlock: { internal: true }, "airlock-out": { internal: true }, "airlock-wake": { internal: true }, "airlock-egress": {} });
});

Deno.test("ledger upgrades require current interpreters and finish before schema readers start", async () => {
  for (const effectInterpreters of [undefined, ""]) {
    const refused = await evaluated(cluster({ effects: [PROBE], effectInterpreters }, {}));
    assert.equal(refused.ok, false);
    assert.match(refused.stderr, /effectInterpreters|airlock-upgrade/);
  }
  for (const pgroll of [{}, { "01_a": { operations: [] } }] as NonNullable<State["pgroll"]>[]) {
    const got = await exported({ effects: [PROBE], pgroll }, "surface.targets", { auth: true, capture: true });
    assert.equal(got.ok, true, got.stderr);
    const t = got.value;
    const upgrade = t["airlock-upgrade"];
    assert.deepEqual(upgrade.dockerfile.entrypoint, ["psql"]);
    assert.ok(upgrade.dockerfile.cmd.includes("--single-transaction"));
    assert.ok(upgrade.dockerfile.cmd.includes("--set=ON_ERROR_STOP=1"));
    assert.deepEqual(upgrade.compose.depends_on.database, { condition: "service_healthy" });
    assert.equal(upgrade.compose.depends_on.migrate, undefined);
    if (Object.keys(pgroll).length) {
      assert.deepEqual(t.migrate.compose.depends_on["airlock-upgrade"], { condition: "service_completed_successfully" });
    }
    for (const reader of ["crud", "electric", "auth", "conduit", "airlock"]) {
      assert.deepEqual(t[reader].compose.depends_on["airlock-upgrade"], { condition: "service_completed_successfully" }, reader);
    }
  }
});

// Every other service stands on the default network, so none of the airlock's
// may: one there could call the daprd's bindings API, which performs an effect
// with no claim and no ledger row.
Deno.test("the airlock reaches the world only through its daprd, which goes out on a network nothing else joins", async () => {
  const got = await lowered({ effects: [PROBE] }, "targets");
  assert.equal(got.ok, true, got.stderr);
  const t = got.value as Targets;
  const on = (n: string) => t[n].compose.networks as Record<string, { aliases: string[] }>;
  const joined = (nw: string) => Object.keys(t).filter((n) => nw in on(n)).sort();
  assert.deepEqual(on("airlock"), { airlock: { aliases: ["airlock"] }, "airlock-wake": { aliases: ["airlock"] } });
  // The ticker's wake reaches the airlock's health port on a network the two hold alone.
  assert.deepEqual(on("ticker"), { default: { aliases: ["ticker"] }, "airlock-wake": { aliases: ["ticker"] } });
  assert.deepEqual(joined("airlock-wake"), ["airlock", "ticker"]);
  assert.deepEqual(on("airlock-mesh"), {
    airlock: { aliases: ["airlock-mesh"] },
    "airlock-out": { aliases: ["airlock-mesh"] },
    "airlock-egress": { aliases: ["airlock-mesh"] },
  });
  assert.deepEqual(on("database"), { default: { aliases: ["database"] }, airlock: { aliases: ["database"] } });
  for (const n of ["crud", "caddy", "electric", "launch"]) assert.deepEqual(on(n), { default: { aliases: [n] } }, n);
  assert.deepEqual(joined("airlock-egress"), ["airlock-mesh"]);
  assert.deepEqual(joined("default").filter((n) => n.startsWith("airlock")), ["airlock-upgrade"]);
});

Deno.test("a step taking the airlock's digits is refused only where an effect is declared", async () => {
  for (const m of ["m/011_x.sql", "m/012_x.sql"]) {
    assert.equal((await copied({ migrations: [m] })).ok, true, m);
    const got = await copied({ migrations: [m], effects: [PROBE] });
    assert.equal(got.ok, false, m);
    assert.match(got.stderr, /_initdb\."01[12]": conflicting values/, m);
  }
});

// The airlock's daprd sits on the cluster's default network. A service's name
// there, or an address, is refused by its spelling; a name that resolves
// inward is not seen by spelling, and is the record's residual.
Deno.test("an origin that is not an https DNS name of two labels or more is refused", async () => {
  for (const origin of [
    "http://api.pay.example", "https://api.pay.example/v1", "https://database", "https://database:5432",
    "https://10.0.0.1", "https://[::1]", "https://user@api.pay.example", "https://API.pay.example",
  ]) {
    const got = await exported({ effects: [{ name: "x", origin }] }, "surface.targets");
    assert.equal(got.ok, false, origin);
  }
});

Deno.test("an effect whose name is not a DNS label is refused", async () => {
  for (const name of ["Pay", "-pay", "pay_x", "pay-"]) {
    const got = await exported({ effects: [{ name, origin: PROBE.origin }] }, "surface.targets");
    assert.equal(got.ok, false, name);
  }
});

Deno.test("a secret reaches the airlock as a required variable, with no default, once however many effects name it", async () => {
  const t = await targets({ effects: [{ ...PROBE, secrets: ["PROBE_KEY", "SHARED_KEY"] }, { ...PROBE, name: "other", secrets: ["SHARED_KEY"] }] });
  assert.equal(t.airlock.compose.environment?.PROBE_KEY, "${PROBE_KEY:?PROBE_KEY is required: an effect declares it}");
  assert.equal(t.airlock.compose.environment?.SHARED_KEY, "${SHARED_KEY:?SHARED_KEY is required: an effect declares it}");
  for (const secret of ["probe_key", "1KEY", ""]) {
    const got = await exported({ effects: [{ ...PROBE, secrets: [secret] }] }, "surface.targets");
    assert.equal(got.ok, false, secret);
  }
});

// `{}`: the container itself is the local stand-in, as for a runner whose
// SMTP server a test points inside the stack.
const MAIL: Bridge = { name: "mail", container: "smtp", simulator: {} };
const CONFIRM: Effect = { name: "confirm", bridge: "mail" };
const activepiecesConfig = { image: {name: "img"}, source: "activepieces/integrations", secrets: ["SMTP_AUTH_JSON"] };
const activepiecesTarget = (config = activepiecesConfig) => `(#ActivepiecesContainer & ${JSON.stringify(config)}).target`;
const withContainers = (state: Partial<State>, containers: string) => `(${cluster(state, {})} & {surface: targets: ${containers}})`;
const runtimeWith = (state: Partial<State>, containers: string, field = "targets") =>
  evaluated(`(#Runtime & {project: "p", cluster: ${withContainers(state, containers)}}).${field}`);

Deno.test("Activepieces is an ordinary container serving an Airlock bridge", async () => {
  const got = await runtimeWith({effects: [PROBE, CONFIRM], bridges: [MAIL]}, `{smtp: ${activepiecesTarget()}}`);
  assert.equal(got.ok, true, got.stderr);
  const t = got.value;
  const bridge = t.smtp;
  assert.equal(bridge.dockerfile.workdir, "/app");
  assert.deepEqual(bridge.srcs.globs, ["activepieces/integrations/**"]);
  assert.equal(bridge.dockerfile.cmd, undefined);
  assert.deepEqual(bridge.compose.networks, {"airlock-out": {aliases: ["smtp"]}, "bridge-mail-egress": {aliases: ["smtp"]}});
  const networks = await exported({ effects: [PROBE, CONFIRM], bridges: [MAIL] }, "surface.networks");
  assert.deepEqual(networks.value["bridge-mail-egress"], {});
  assert.deepEqual(bridge.compose.environment, {
    ACTIVEPIECES_MANIFEST: "/app/manifest.json",
    ACTIVEPIECES_REGISTRY: "/app/registry.ts",
    PORT: "8080",
    SMTP_AUTH_JSON: "${SMTP_AUTH_JSON:?SMTP_AUTH_JSON is required by the integration hatch}",
  });
  assert.equal(t["airlock-mesh"].compose.environment.AIRLOCK_BRIDGES, "mail");
  assert.deepEqual(t["airlock-mesh"].compose.depends_on["p-smtp"], { condition: "service_started" });
  assert.ok(t["airlock-mesh"].deps.includes(":smtp:outs"));
  assert.equal(t["airlock-mesh"].compose.environment.AIRLOCK_ORIGINS, "https://sink.example.test");
});

Deno.test("the local stack runs a bridge only as its simulator, and tells the airlock it stands on local", async () => {
  const live = await runtimeWith({effects: [PROBE, CONFIRM], bridges: [MAIL]}, `{smtp: ${activepiecesTarget()}}`);
  assert.equal(live.ok, true, live.stderr);
  assert.equal(live.value.airlock.compose.environment.AIRLOCK_TARGET, "local");
  // A simulator replaces the fields it names and keeps the rest of the
  // container: its name, port, environment and bridge networks.
  const stub = await runtimeWith(
    {effects: [CONFIRM], bridges: [{ ...MAIL, simulator: {dockerfile: {from: {name: "stub@sha256:fixture"}}} }]},
    `{smtp: {dockerfile: from: name: "real@sha256:fixture", compose: environment: {PORT: "8080"}}}`,
  );
  assert.equal(stub.ok, true, stub.stderr);
  assert.equal(stub.value.smtp.dockerfile.from.name, "stub@sha256:fixture");
  assert.deepEqual(stub.value.smtp.compose.environment, {PORT: "8080"});
  assert.deepEqual(stub.value.smtp.compose.networks, {"airlock-out": {aliases: ["smtp"]}, "bridge-mail-egress": {aliases: ["smtp"]}});
  // Without a simulator the real container never starts locally: none wired,
  // none waited on, though the release's container is declared.
  const bare = await runtimeWith({effects: [PROBE, CONFIRM], bridges: [{ name: "mail", container: "smtp" }]}, `{smtp: ${activepiecesTarget()}}`);
  assert.equal(bare.ok, true, bare.stderr);
  assert.equal(bare.value.smtp, undefined);
  assert.equal(bare.value["airlock-mesh"].compose.environment.AIRLOCK_BRIDGES, "");
  assert.deepEqual(bare.value["airlock-mesh"].compose.depends_on, {});
  assert.equal(bare.value.airlock.compose.environment.AIRLOCK_TARGET, "local");
  const none = await runtimeWith({effects: [PROBE]}, "{}");
  assert.equal(none.ok, true, none.stderr);
  assert.equal(none.value.airlock.compose.environment.AIRLOCK_TARGET, undefined);
});

Deno.test("Activepieces container requires valid secret names", async () => {
  for (const secret of ["smtp_auth", "1KEY", ""]) {
    const got = await evaluated(activepiecesTarget({...activepiecesConfig, secrets: [secret]}));
    assert.equal(got.ok, false, secret);
  }
});

Deno.test("a custom acquisition container gets the bridge role without mail configuration or implicit database access", async () => {
  const state = {effects: [{name: "fetch", bridge: "crawl"}], bridges: [{name: "crawl", container: "crawler", port: 9090, simulator: {}}]};
  const got = await runtimeWith(state, `{crawler: {dockerfile: {from: name: "crawler@sha256:fixture", cmd: ["crawl"]}, compose: environment: {CALLBACK_TOKEN: "restricted"}}}`);
  assert.equal(got.ok, true, got.stderr);
  assert.deepEqual(got.value.crawler.dockerfile.cmd, ["crawl"]);
  assert.deepEqual(got.value.crawler.compose.environment, {CALLBACK_TOKEN: "restricted"});
  assert.deepEqual(got.value.crawler.compose.networks, {"airlock-out": {aliases: ["crawler"]}, "bridge-crawl-egress": {aliases: ["crawler"]}});
  assert.deepEqual(got.value["airlock-mesh"].compose.depends_on["p-crawler"], {condition: "service_started"});
  const explicit = await runtimeWith(state, `{crawler: {dockerfile: from: name: "crawler", compose: networks: ["callbacks"]}}`);
  assert.equal(explicit.ok, true, explicit.stderr);
  assert.deepEqual(explicit.value.crawler.compose.networks.callbacks, {aliases: ["crawler"]});
});

// Cloudflare ships the container's own image, so the real container is built
// here without the docker appliance's form, and a container that only pulls
// its image is refused: the publish would have nothing to build.
Deno.test("a bridge on cloudflare builds its real container and needs a Dockerfile", async () => {
  const state = {effects: [{name: "fetch", bridge: "crawl"}], bridges: [{name: "crawl", container: "crawler", targets: ["cloudflare"], simulator: {}}]};
  const got = await runtimeWith(state, `{crawler: {dockerfile: {from: name: "crawler@sha256:fixture", cmd: ["crawl"]}, compose: environment: {CALLBACK_TOKEN: "restricted"}}}`);
  assert.equal(got.ok, true, got.stderr);
  assert.deepEqual(got.value["crawler-appliance"].dockerfile.cmd, ["crawl"]);
  assert.equal(got.value["crawler-appliance"].compose.manual, true);
  const pulled = await runtimeWith(state, `{crawler: {dockerfile: from: null, compose: image: "ghcr.io/example/crawler:1"}}`);
  assert.equal(pulled.ok, false);
  assert.match(pulled.stderr, /builds no image from a Dockerfile/);
});

// The appliance target kept the container's `entrypoint.after` without the
// waits' deps, which bayt refuses, and dropped `compose.environment`, which
// the cloudflare publish reads from the compose file bayt renders for it.
Deno.test("a bridge's real container keeps its entrypoint and environment and none of the stack's waits", async () => {
  const state = {effects: [{name: "fetch", bridge: "crawl"}], bridges: [{name: "crawl", container: "crawler", targets: ["cloudflare"], simulator: {}}]};
  const got = await runtimeWith(state, `{crawler: {dockerfile: {from: name: "crawler@sha256:fixture", cmd: ["crawl"]}, entrypoint: {do: "crawl", env: {MODE: "live"}, after: {database: "healthy"}}, expose: http: {port: 8080, env: "PORT"}, compose: {environment: {CALLBACK_TOKEN: "restricted"}, build: args: {PROFILE: "release"}, depends_on: {database: {condition: "service_healthy"}}}}}`);
  assert.equal(got.ok, true, got.stderr);
  const appliance = got.value["crawler-appliance"];
  assert.equal(appliance.entrypoint.after, undefined);
  assert.deepEqual(appliance.entrypoint.env, {MODE: "live"});
  assert.equal(appliance.expose.http.env, "PORT");
  // The build args ride along: bayt renders them into the compose file the
  // publish forwards as the image's build variables.
  assert.deepEqual(appliance.compose, {manual: true, environment: {CALLBACK_TOKEN: "restricted"}, build: {args: {PROFILE: "release"}}});
  assert.equal(appliance.deps, undefined);
});

Deno.test("a container on cloudflare states its process in its Dockerfile, not in compose", async () => {
  const state = {effects: [{name: "fetch", bridge: "crawl"}], bridges: [{name: "crawl", container: "crawler", targets: ["cloudflare"], simulator: {}}]};
  for (const compose of [`command: ["crawl"]`, `entrypoint: ["/bin/crawl"]`]) {
    const got = await runtimeWith(state, `{crawler: {dockerfile: {from: name: "crawler@sha256:fixture"}, compose: {${compose}}}}`);
    assert.equal(got.ok, false, compose);
    assert.match(got.stderr, /compose.command or compose.entrypoint/);
  }
  const docker = await runtimeWith({...state, bridges: [{name: "crawl", container: "crawler", targets: ["docker"], appliance: {srcs: ["/bin/crawl"], command: ["/bin/crawl"], port: 8090}}]}, `{crawler: {dockerfile: {from: name: "crawler@sha256:fixture"}, compose: {command: ["crawl"]}}}`);
  assert.equal(docker.ok, true, docker.stderr);
});

// Two bridges on one container unified two ports onto its one `expose`, and
// on cloudflare built two containers from one image.
Deno.test("bridges share a container on one port, and on cloudflare a container is one bridge's", async () => {
  const effects = [{name: "fetch", bridge: "crawl"}, {name: "scan", bridge: "scrape"}];
  const crawler = `{crawler: {dockerfile: {from: name: "crawler@sha256:fixture"}, compose: {}}}`;
  const shared = await runtimeWith({effects, bridges: [{name: "crawl", container: "crawler", simulator: {}}, {name: "scrape", container: "crawler"}]}, crawler);
  assert.equal(shared.ok, true, shared.stderr);
  const ports = await runtimeWith({effects, bridges: [{name: "crawl", container: "crawler", simulator: {}}, {name: "scrape", container: "crawler", port: 8081}]}, crawler);
  assert.equal(ports.ok, false);
  assert.match(ports.stderr, /on different ports/);
  const cloudflare = await runtimeWith({effects, bridges: [{name: "crawl", container: "crawler", targets: ["cloudflare"], simulator: {}}, {name: "scrape", container: "crawler"}]}, crawler);
  assert.equal(cloudflare.ok, false);
  assert.match(cloudflare.stderr, /which cloudflare runs as one bridge's container/);
});

Deno.test("a bridge cannot refer to an absent, removed or unbuilt container", async () => {
  for (const containers of ["{}", "{smtp: null}", "{smtp: {compose: {}}}"]) {
    const got = await runtimeWith({effects: [CONFIRM], bridges: [MAIL]}, containers);
    assert.equal(got.ok, false, containers);
  }
});

Deno.test("bridge references require DNS labels and a valid port", async () => {
  for (const bridge of [{...MAIL, name: "Mail"}, {...MAIL, container: "bad/name"}, {...MAIL, port: 0}, {...MAIL, port: 65536}]) {
    const got = await exported({effects: [CONFIRM], bridges: [bridge]}, "surface.targets");
    assert.equal(got.ok, false, JSON.stringify(bridge));
  }
});

Deno.test("an effect reaches one origin or one declared bridge, never both and never an undeclared one", async () => {
  for (const [effects, bridges] of [
    [[{ name: "confirm", bridge: "smtp" }], [MAIL]],
    [[{ name: "confirm", bridge: "mail", origin: PROBE.origin }], [MAIL]],
    [[{ name: "confirm" }], [MAIL]],
  ] as [Effect[], Bridge[]][]) {
    const got = await exported({ effects, bridges }, "surface.targets");
    assert.equal(got.ok, false, JSON.stringify(effects));
  }
});

// Two languages hold one list: what the cages can endow (language.ts) and what
// a declaration may name (#CageEndowments).
Deno.test("a declaration may name exactly what the cages can endow", async () => {
  const out = await new Deno.Command("cue", { args: ["eval", ".:cluster", "-e", "#CageEndowments", "--out", "json"], cwd: MECHA, stdout: "piped" }).output();
  assert.deepEqual(JSON.parse(new TextDecoder().decode(out.stdout)).sort(), [...ENDOWABLE].sort());
});

// The ticker writes as `service` on the token's role claim, so crud verifies
// the token wherever something wakes; the auth plane itself stays a choice.
Deno.test("a cluster that wakes has crud verify the service token, without the auth plane", async () => {
  for (const state of [{ effects: [PROBE] }, { schedules: ["tick"] }]) {
    const t = await targets(state);
    assert.equal(t.crud.compose.environment?.PGRST_JWT_SECRET, "${PGRST_JWT_SECRET:-mecha-dev-secret-please-override-32ch}");
    assert.equal(t.auth, undefined);
  }
  const quiet = await targets({});
  assert.equal(quiet.crud.compose.environment?.PGRST_JWT_SECRET, undefined);
});

Deno.test("a cluster given an effect refuses the data plane off", async () => {
  const got = await exported({ effects: [PROBE] }, "capabilities", { server: false });
  assert.equal(got.ok, false);
  assert.match(got.stderr, /capabilities\.server: conflicting values/);
});

// The shape gate admits subset snapshots on the premise that Electric parses a
// subset with no subquery (services/auth/main.ts). A feature flag would turn
// subqueries on, and with them a subset that reads another table as Electric's
// BYPASSRLS role.
Deno.test("electric runs with no feature flags", async () => {
  const got = await exported({}, "surface.targets.electric.compose.environment", { server: true });
  assert.equal(got.ok, true, got.stderr);
  assert.equal("ELECTRIC_FEATURE_FLAGS" in got.value, false);
  assert.equal(typeof got.value.ELECTRIC_SECRET, "string");
});

// electric's password is the deployment's: the schema leaves it unset, so a
// Kubernetes operator's secret is not overwritten when migrations run, and the
// database's initdb sets it from the variable electric's URL carries. initdb
// trusts only loopback, so a password the two disagreed on would refuse
// electric's connection.
Deno.test("electric's password reaches the role and its URL from one variable", async () => {
  const got = await exported({}, "surface.targets", { server: true });
  assert.equal(got.ok, true, got.stderr);
  const password = got.value.database.compose.environment.ELECTRIC_PASSWORD;
  assert.match(password, /^\$\{ELECTRIC_PASSWORD:-/);
  assert.equal(
    got.value.electric.compose.environment.DATABASE_URL,
    `postgresql://electric:${password}@database:5432/\${POSTGRES_DB:-t}?sslmode=disable`,
  );
  const placed = got.value.database.dockerfile.copy.filter((c: { dst: string }) => c.dst.endsWith("/899_role_passwords.sh"));
  assert.deepEqual(placed.map((c: { srcs: string[] }) => c.srcs), [["/usr/share/mecha/initdb/899_role_passwords.sh"]]);
  // PostgREST's login, set by the same step: one variable for the role and the
  // URL, or crud's first connection is refused. It is not postgres, whose
  // login would apply no token role's statement_timeout.
  const authenticator = got.value.database.compose.environment.AUTHENTICATOR_PASSWORD;
  assert.match(authenticator, /^\$\{AUTHENTICATOR_PASSWORD:-/);
  assert.equal(
    got.value.crud.compose.environment.PGRST_DB_URI,
    `postgres://authenticator:${authenticator}@database:5432/\${POSTGRES_DB:-t}`,
  );
});

Deno.test("a caller step on the electric password's digits is refused", async () => {
  const got = await exported({ migrations: ["m/899_late.sql"] }, "surface.targets.database", { server: true });
  assert.equal(got.ok, false);
  assert.match(got.stderr, /_initdb\."899": conflicting values/);
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

Deno.test("the standalone Activepieces Dockerfile matches the shared build recipe", async () => {
  const out = await new Deno.Command("cue", {
    args: ["export", "./services/activepieces:activepieces", "-e", "Dockerfile", "--out", "text"],
    cwd: MECHA, stdout: "piped", stderr: "piped",
  }).output();
  assert.equal(out.success, true, new TextDecoder().decode(out.stderr));
  const dockerfile = new TextDecoder().decode(out.stdout);
  assert.equal(dockerfile, await Deno.readTextFile(`${MECHA}services/activepieces/Dockerfile`));
});

// The migration runner is the database image run as a runner: pgroll and the
// script ship there, so one image serves both and one pin names it.
Deno.test("the migrate runner takes the database image", async () => {
  const cluster = `#Cluster & {meta: {app: "t", images: [string]: name: "img", bounds: {authStatementMs: 5000, tickerCallMs: 35000}}, state: {migrations: [], pipelines: [], schedules: [], pgroll: {"01_a": {operations: []}}}}`;
  const out = await new Deno.Command("cue", {
    args: ["export", ".:cluster", "-e", `{from: (${cluster}).surface.targets.migrate.dockerfile.from, entrypoint: (${cluster}).surface.targets.migrate.dockerfile.entrypoint}`],
    cwd: MECHA, stdout: "piped", stderr: "piped",
  }).output();
  assert.equal(out.success, true, new TextDecoder().decode(out.stderr));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(out.stdout)), { from: { name: "img" }, entrypoint: ["/migrate.sh"] });
});

Deno.test("materialized migrations keep engine payloads out of the build request", async () => {
  const pgroll = { "01_engine": { operations: [{ sql: { up: `SELECT '${"x".repeat(32_768)}';`, onComplete: true } }] } };
  const state = { pgroll, pgrollDir: "services/database/pgroll" };
  const got = await lowered(state, "targets.migrate");
  assert.equal(got.ok, true, got.stderr);
  assert.deepEqual(got.value.srcs.globs, ["services/database/pgroll/01_engine.json"]);
  assert.deepEqual(got.value.dockerfile.copy, [{ srcs: ["services/database/pgroll/01_engine.json"], dst: "/pgroll/01_engine.json" }]);
  assert.deepEqual(got.value.dockerfile.epilogue, []);
  assert.ok(JSON.stringify(got.value).length < 4096);

  const inline = await exported({ pgroll }, "surface.targets.migrate.dockerfile.epilogue");
  assert.equal(inline.ok, true, inline.stderr);
  assert.match(inline.value[0], /base64 -d/);

  const invalid = await exported({ pgrollDir: state.pgrollDir, pgroll: { "01_engine": { operations: [{ unknown_operation: {} }] } } }, "state.pgroll");
  assert.equal(invalid.ok, false, "selecting files must still validate the declared migration grammar");
});

// The schedule table is initdb's alone: a volume older than the cluster's
// first schedule lacks it, and the runner is told to refuse that volume.
Deno.test("a schedule makes the migrate runner require its table", async () => {
  const env = async (schedules: string[]) => {
    const cluster = `#Cluster & {meta: {app: "t", images: [string]: name: "img", bounds: {authStatementMs: 5000, tickerCallMs: 35000}}, state: {migrations: [], pipelines: [], schedules: ${JSON.stringify(schedules)}, pgroll: {"01_a": {operations: []}}}}`;
    const out = await new Deno.Command("cue", {
      args: ["export", ".:cluster", "-e", `(${cluster}).surface.targets.migrate.compose.environment`],
      cwd: MECHA, stdout: "piped", stderr: "piped",
    }).output();
    assert.equal(out.success, true, new TextDecoder().decode(out.stderr));
    return JSON.parse(new TextDecoder().decode(out.stdout));
  };
  assert.equal((await env(["tick"])).REQUIRED_TABLES, "schedule");
  assert.equal((await env([])).REQUIRED_TABLES, undefined);
});

// The blob store is rclone's own image: the bucket made and the server
// started by its entrypoint, no image of mecha's.
Deno.test("the blob store runs rclone's own image", async () => {
  const got = await exported({}, "surface.targets[\"rclone-s3\"].dockerfile", { blobs: true });
  assert.equal(got.ok, true, got.stderr);
  assert.match(got.value.from.name, /^rclone\/rclone:[0-9.]+@sha256:[0-9a-f]{64}$/);
  assert.match(got.value.entrypoint.join(" "), /mkdir -p .*RCLONE_LOCAL_BUCKET.* && exec rclone serve s3/);
});

Deno.test("a cluster requires the core published images; Activepieces is selected by its container recipe", async () => {
  const out = await new Deno.Command("cue", {
    args: ["export", ".:cluster", "-e", "{images: [for k, _ in #Cluster.meta.images {k}], published: #Images}"],
    cwd: MECHA, stdout: "piped", stderr: "piped",
  }).output();
  assert.equal(out.success, true, new TextDecoder().decode(out.stderr));
  const { images, published } = JSON.parse(new TextDecoder().decode(out.stdout));
  assert.deepEqual([...images].sort(), published.filter((s: string) => s !== "activepieces").sort());
  assert.deepEqual([...published].sort(), ["activepieces", "airlock", "auth", "clock", "compute", "conduit", "database", "extensions", "mesh", "ticker"]);
});

// A provider's settings are the deployment's, over defaults the program may
// give: a compose run inside a container that is handed no environment still
// starts, and a provider whose client nobody gives fails at compose, before the
// auth service boots with nothing to sign in through.
Deno.test("a sign-in provider turns auth on and reaches it as a required client, and an unknown one is refused", async () => {
  const on = await exported({}, "surface.targets.auth.compose.environment", { signIn: { google: {} } });
  assert.equal(on.ok, true, on.stderr);
  assert.equal(on.value.OIDC_PROVIDERS, "google");
  assert.equal(on.value.OIDC_GOOGLE_CLIENT_ID, "${OIDC_GOOGLE_CLIENT_ID:?OIDC_GOOGLE_CLIENT_ID is required: the cluster signs in through google}");
  // The rest are the deployment's to set or leave, an issuer in Google's place among them.
  assert.equal(on.value.OIDC_GOOGLE_ISSUER, "${OIDC_GOOGLE_ISSUER:-}");
  assert.equal(on.value.OIDC_GOOGLE_AUTHORIZE_PARAMS, "${OIDC_GOOGLE_AUTHORIZE_PARAMS:-}");
  const off = await exported({}, "surface.targets.auth.compose.environment", { auth: true });
  assert.equal(off.ok, true, off.stderr);
  assert.equal(off.value.OIDC_PROVIDERS, "");
  assert.equal("OIDC_GOOGLE_CLIENT_ID" in off.value, false);
  assert.equal((await exported({}, "capabilities", { signIn: { google: {} }, auth: false })).ok, false);
  assert.equal((await exported({}, "capabilities", { signIn: { myspace: {} } })).ok, false);
});

Deno.test("a provider's program defaults stand until the deployment sets its own, and a secret is never one", async () => {
  const google = { issuer: "http://localhost:28443", internal: "http://host.docker.internal:28443", client: "origin", scope: "openid", params: "provider=google" };
  const env = await exported({}, "surface.targets.auth.compose.environment", { signIn: { google } });
  assert.equal(env.ok, true, env.stderr);
  assert.equal(env.value.OIDC_GOOGLE_CLIENT_ID, "${OIDC_GOOGLE_CLIENT_ID:-origin}");
  assert.equal(env.value.OIDC_GOOGLE_ISSUER, "${OIDC_GOOGLE_ISSUER:-http://localhost:28443}");
  assert.equal(env.value.OIDC_GOOGLE_INTERNAL, "${OIDC_GOOGLE_INTERNAL:-http://host.docker.internal:28443}");
  assert.equal(env.value.OIDC_GOOGLE_SCOPE, "${OIDC_GOOGLE_SCOPE:-openid}");
  assert.equal(env.value.OIDC_GOOGLE_AUTHORIZE_PARAMS, "${OIDC_GOOGLE_AUTHORIZE_PARAMS:-provider=google}");
  assert.equal(env.value.OIDC_GOOGLE_CLIENT_SECRET, "${OIDC_GOOGLE_CLIENT_SECRET:-}");
  // compose would read a `$` or `}` in a default as its own syntax.
  for (const bad of [{ secret: "shh" }, { scope: "openid ${HOME}" }, { params: "a=}" }]) {
    assert.equal((await exported({}, "capabilities", { signIn: { google: bad } })).ok, false, JSON.stringify(bad));
  }
});

Deno.test("compute readiness preserves the startup allowance for each sequential native program", async () => {
  for (const duckstreamEngine of ["duckdb-snapshot", "feldera"] as const) {
    for (const count of [1, 2]) {
      const computations = Array.from({ length: count }, (_, i) => ({ name: `analytics_${i}`, file: `program_${i}.js`, feldera: `program_${i}.json`, to: [`metric_${i}`], wasm: [] }));
      const got = await exported({ duckstreamEngine, computations }, "surface.targets.compute.compose.healthcheck");
      assert.equal(got.ok, true, got.stderr);
      assert.equal(got.value.start_period, `${duckstreamEngine === "feldera" ? 30 * count : 15}m`);
      assert.deepEqual(got.value.test, ["CMD", "portcheck", "--port", "9997"]);
    }
  }
});

Deno.test("Feldera deployment selects its pinned internal service and ships the descriptor for either engine", async () => {
  for (const duckstreamEngine of ["duckdb-snapshot", "feldera"] as const) {
    const got = await exported({ duckstreamEngine, computations: [{ name: "analytics", file: "duckstream/program.js", feldera: "duckstream/feldera.json", to: ["metric"], wasm: [] }] }, "surface.targets");
    assert.equal(got.ok, true, got.stderr);
    const { compute, feldera } = got.value;
    assert.equal(compute.compose.environment.DUCKSTREAM_ENGINE, "${DUCKSTREAM_ENGINE:-" + duckstreamEngine + "}");
    assert.equal(JSON.parse(compute.compose.environment.COMPUTATIONS)[0].feldera, "/app/computations/analytics.feldera.json");
    assert.ok(compute.srcs.globs.includes("duckstream/feldera.json"));
    assert.ok(compute.dockerfile.copy.some((copy: { srcs: string[]; dst: string }) => copy.srcs[0] === "duckstream/feldera.json" && copy.dst === "/app/computations/analytics.feldera.json"));
    if (duckstreamEngine === "feldera") {
      assert.equal(feldera.dockerfile.from.name, "images.feldera.com/feldera/pipeline-manager:0.367.0@sha256:42819714d16f7d5d37c17c87812ce98fb23efd2b1bfbf95b4889877f14693272");
      assert.match(feldera.dockerfile.preamble.join("\n"), /\[profile\.unoptimized\].*strip = "symbols"/);
      assert.deepEqual(feldera.compose.healthcheck.test, ["CMD", "httpcheck", "http://127.0.0.1:8080/healthz"]);
      assert.equal(feldera.compose.ports, undefined);
      assert.equal(compute.compose.depends_on.feldera.condition, "service_healthy");
      assert.equal(compute.compose.environment.FELDERA_URL, "http://feldera:8080");
      assert.equal(feldera.compose.environment.FELDERA_DATABASE_URL, compute.compose.environment.DATABASE_URL);
      assert.match(feldera.compose.environment.FELDERA_DATABASE_URL, /\$\{POSTGRES_PASSWORD:-postgres\}/);
    } else {
      assert.equal(feldera, undefined);
      assert.equal(compute.compose.depends_on.feldera, undefined);
      assert.equal(compute.compose.environment.FELDERA_URL, undefined);
    }
  }
});

Deno.test("an AI effect or capability turns on the tsbifrost gateway on airlock-out", async () => {
  const got = await exported(
    { effects: [{ name: "draft", ai: "text", tier: "cheap" }], effectInterpreters: "SELECT 1;" },
    "surface.targets",
    { ai: { text: ["browser", "cheap", "heavy"], image: ["browser", "cheap", "heavy"] } },
  );
  assert.equal(got.ok, true, got.stderr);
  assert.ok(got.value.tsbifrost, "tsbifrost target emitted when AI is used");
  assert.equal(got.value.tsbifrost.compose.environment.TSBIFROST_PORT, "8090");
  assert.equal(got.value.tsbifrost.compose.environment.AI_TARGET, "${AI_TARGET:-${SAYT_PLATFORM:-docker}}");
  assert.equal(got.value.tsbifrost.compose.environment.CF_ACCOUNT_ID, "${CF_ACCOUNT_ID:-}");
  assert.equal(got.value.tsbifrost.compose.environment.CF_API_TOKEN, "${CF_API_TOKEN:-}");
  assert.equal(got.value.tsbifrost.compose.environment.GEMINI_API_KEY, "${GEMINI_API_KEY:-}");
  assert.equal(got.value.tsbifrost.compose.environment.GOOGLE_API_KEY, "${GOOGLE_API_KEY:-}");
  assert.equal(got.value.tsbifrost.compose.environment.OPENAI_API_KEY, "${OPENAI_API_KEY:-}");
  assert.deepEqual(got.value.tsbifrost.compose.networks, ["airlock-out", "default", "airlock-egress"]);
  assert.ok(got.value["airlock-mesh"].compose.depends_on.tsbifrost, "airlock-mesh depends on tsbifrost");
  assert.match(got.value["airlock-mesh"].compose.environment.AIRLOCK_BRIDGES, /\btsbifrost\b/);
});

Deno.test("an explicit tenancy baseline replaces the image floor once", async () => {
  const baseline = "services/database/migrations/003_rls.sql";
  const generated = await copied({ migrations: [baseline, "m/004_types.sql"] });
  assert.equal(generated.ok, true, generated.stderr);
  assert.deepEqual(generated.value, [baseline, "m/004_types.sql"]);
  const duplicate = await copied({ migrations: [baseline, baseline] });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.stderr, /duplicate migration/);
  const collision = await copied({ migrations: [baseline, "other/003_rls.sql"] });
  assert.equal(collision.ok, false);
  assert.match(collision.stderr, /_initdb\."003": conflicting values/);
});

// Every docker app's appliance compiled the same toolchain in a stage of its
// own, its server headers pinned apart from the server it ran: one image now,
// against the appliance's one PostgreSQL version.
Deno.test("the appliance's extensions build once, against the appliance's own PostgreSQL", async () => {
  const out = await new Deno.Command("cue", { args: ["export", ".:cluster", "-e", "#AppliancePostgres"], cwd: MECHA, stdout: "piped" }).output();
  assert.equal(out.success, true);
  const version: string = JSON.parse(new TextDecoder().decode(out.stdout));
  const build = await Deno.readTextFile(`${MECHA}.bayt/Dockerfile.extensions-build`);
  for (const s of [`postgresql18-server-devel=${version}`, "github.com/plv8/pljs.git", "plv8.control", "sha256sum -c", "/pg-extensions/lib/"]) {
    assert.ok(build.includes(s), `${s} missing from the extensions build`);
  }
  assert.ok(!build.includes("zig"), "a second toolchain");
});

// The published extensions image was its build stage: the toolchain every
// appliance pulled to copy two libraries and their extension files.
Deno.test("the published extensions image holds the extensions alone", async () => {
  const dockerfile = await Deno.readTextFile(`${MECHA}.bayt/Dockerfile.extensions-image`);
  const stage = dockerfile.split(/\n(?=FROM )/)[1];
  assert.match(stage, /^FROM scratch AS extensions-image\n/);
  assert.ok(stage.includes("COPY --link --from=libraries_mecha-extensions-build /pg-extensions /pg-extensions"), stage);
  assert.ok(!/zypper|gcc|postgresql18-server-devel/.test(stage), `the toolchain ships: ${stage}`);
});

// A bridge's container built for the appliance lost its build dependencies
// with the stack's waits: one copying from a sibling target built without it.
Deno.test("a bridge's appliance build keeps its own dependencies, without the stack's waits", async () => {
  const state = {effects: [{name: "fetch", bridge: "crawl"}], bridges: [{name: "crawl", container: "crawler", targets: ["docker"], appliance: {srcs: ["/usr/local/bin/crawl"], command: ["/usr/local/bin/crawl"], port: 8091}}]};
  const got = await runtimeWith(state, `{support: {dockerfile: from: name: "support@sha256:fixture", compose: {}}, crawler: {deps: [":support:outs"], dockerfile: {from: name: "crawler@sha256:fixture", copy: [{from: ref: ":support", srcs: ["/lib/x"], dst: "/lib/x"}]}}}`);
  assert.equal(got.ok, true, got.stderr);
  assert.deepEqual(got.value["crawler-appliance"].deps, [":support:outs"]);
  assert.equal(got.value["crawler-appliance"].compose.manual, true);
});
