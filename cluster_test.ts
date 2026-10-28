// What a cluster refuses of the steps its database runs at initdb, which
// services its change feed brings, and where it places the airlock.
//
//   deno test --no-config --no-lock --allow-read --allow-run=cue cluster_test.ts

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ENDOWABLE } from "./services/compute/language.ts";

const MECHA = fileURLToPath(new URL(".", import.meta.url));

type Effect = { name: string; origin?: string; bridge?: string; handler?: string; endpoint?: string; secrets?: string[] };
type Bridge = { name: string; container: string; port?: number };
type State = {
  migrations: string[];
  pipelines: { name: string; file: string }[];
  schedules: string[];
  computations: { name: string; file: string; to: string[]; wasm: string[]; onComplete?: string }[];
  effects?: Effect[];
  effectInterpreters?: string;
  pgroll?: Record<string, { operations: unknown[] }>;
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

Deno.test("a computation alone gets a durable CDC consumer without a clock", async () => {
  const got = await exported({
    computations: [{ name: "c", file: "c.js", to: ["sink"], wasm: [] }],
  }, "surface.targets");
  assert.equal(got.ok, true, got.stderr);
  assert.equal(got.value.clock, undefined);
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
    assert.deepEqual(upgrade.compose.depends_on.migrate, Object.keys(pgroll).length ? { condition: "service_completed_successfully" } : undefined);
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

const MAIL: Bridge = { name: "mail", container: "smtp" };
const CONFIRM: Effect = { name: "confirm", bridge: "mail" };
const mailConfig = { image: {name: "img"}, server: "smtp.mail.example:587", domain: "airlock.example" };
const mailTarget = (config = mailConfig) => `(#MailContainer & ${JSON.stringify(config)}).target`;
const withContainers = (state: Partial<State>, containers: string) => `(${cluster(state, {})} & {surface: targets: ${containers}})`;
const runtimeWith = (state: Partial<State>, containers: string, field = "targets") =>
  evaluated(`(#Runtime & {project: "p", cluster: ${withContainers(state, containers)}}).${field}`);

Deno.test("mail is an ordinary container serving an Airlock bridge", async () => {
  const config = {...mailConfig, user: "MAIL_USER_VAR", password: "MAIL_PASSWORD_VAR"};
  const got = await runtimeWith({effects: [PROBE, CONFIRM], bridges: [MAIL]}, `{smtp: ${mailTarget(config)}}`);
  assert.equal(got.ok, true, got.stderr);
  const t = got.value;
  const bridge = t.smtp;
  assert.deepEqual(bridge.dockerfile.cmd, [
    "run", "--frozen", "--allow-net=0.0.0.0:8080,smtp.mail.example:587",
    "--allow-env=MAIL_SMTP,MAIL_TLS,MAIL_MESSAGE_ID_DOMAIN,MAIL_USER,MAIL_PASSWORD,ETHEREAL_API,ETHEREAL_API_KEY,ETHEREAL_CACHE,ETHEREAL_WEB",
    "--allow-sys=hostname", "mail.ts",
  ]);
  assert.deepEqual(bridge.compose.networks, {"airlock-out": {aliases: ["smtp"]}, "bridge-mail-egress": {aliases: ["smtp"]}});
  const networks = await exported({ effects: [PROBE, CONFIRM], bridges: [MAIL] }, "surface.networks");
  assert.deepEqual(networks.value["bridge-mail-egress"], {});
  assert.deepEqual(bridge.compose.environment, {
    MAIL_SMTP: "smtp.mail.example:587",
    MAIL_TLS: "starttls",
    MAIL_MESSAGE_ID_DOMAIN: "airlock.example",
    MAIL_USER: "${MAIL_USER_VAR:?MAIL_USER_VAR is required: mail container's user}",
    MAIL_PASSWORD: "${MAIL_PASSWORD_VAR:?MAIL_PASSWORD_VAR is required: mail container's password}",
  });
  assert.equal(t["airlock-mesh"].compose.environment.AIRLOCK_BRIDGES, "mail");
  assert.deepEqual(t["airlock-mesh"].compose.depends_on["p-smtp"], { condition: "service_started" });
  assert.ok(t["airlock-mesh"].deps.includes(":smtp:outs"));
  assert.equal(t["airlock-mesh"].compose.environment.AIRLOCK_ORIGINS, "https://sink.example.test");
});

Deno.test("mail container retains its server, domain and paired credential validation", async () => {
  for (const config of [
    { ...mailConfig, server: "smtp.mail.example" },
    { ...mailConfig, server: "database:5432" },
    { ...mailConfig, server: "10.0.0.1:25" },
    { ...mailConfig, domain: "airlock" },
    { ...mailConfig, tls: "implicit" },
    { ...mailConfig, user: "MAIL_USER_VAR" },
  ]) {
    const got = await evaluated(mailTarget(config));
    assert.equal(got.ok, false, JSON.stringify(config));
  }
});

Deno.test("a custom acquisition container gets the bridge role without mail configuration or implicit database access", async () => {
  const state = {effects: [{name: "fetch", bridge: "crawl"}], bridges: [{name: "crawl", container: "crawler", port: 9090}]};
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

Deno.test("a cluster takes the published images and no others", async () => {
  const out = await new Deno.Command("cue", {
    args: ["export", ".:cluster", "-e", "{images: [for k, _ in #Cluster.meta.images {k}], published: #Images}"],
    cwd: MECHA, stdout: "piped", stderr: "piped",
  }).output();
  assert.equal(out.success, true, new TextDecoder().decode(out.stderr));
  const { images, published } = JSON.parse(new TextDecoder().decode(out.stdout));
  assert.deepEqual([...images].sort(), [...published].sort());
  assert.deepEqual([...published].sort(), ["airlock", "auth", "clock", "compute", "conduit", "database", "mesh", "ticker"]);
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
