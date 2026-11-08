import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import pg from "npm:pg@8.16.3";
import { NativeRuntime } from "./native-runtime.ts";
import { type Batches, openBatches } from "./batches.ts";
import {
  type CompilationProfile,
  compilationProfile,
  NativeFeldera,
  replicationIdentity,
} from "./native-feldera.ts";
import {
  type IncrementalProgram,
  installSources,
  sourceSchema,
} from "./native-sources.ts";

function startup(
  compile: (poll: number) => string,
  deploy = () => "Running",
  profile?: CompilationProfile,
  errors: Record<string, unknown> = {},
) {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = 0;
  let created = false;
  let started = false;
  let sql = "";
  let programConfig: unknown;
  let compilePolls = 0;
  let deployPolls = 0;
  let registeredPipeline: unknown;
  const state = {
    deployment_id: "deployment",
    deployment_status: "Stopped",
    program_status: "Pending",
    platform_version: "0.367.0",
    program_code: "",
  };
  const client = {
    query: (sql: string, args?: unknown[]) => {
      if (sql.includes("INSERT INTO compute.native_epoch")) registeredPipeline = args?.[4];
      return Promise.resolve({ rows: sql.includes("AS present") ? [{ present: false }] : [] });
    },
    release() {},
  };
  const db = {
    connect: () => Promise.resolve(client),
    query: (sql: string) =>
      Promise.resolve({
        rows: sql.includes("AS present") ? [{ present: true }] : [],
      }),
  } as unknown as pg.Pool;
  Date.now = () => now;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "PUT") {
      assertEquals(registeredPipeline, "http://manager/v0/pipelines/startup");
      created = true;
      const body = JSON.parse(String(init.body));
      sql = body.program_code;
      programConfig = body.program_config;
      return Promise.resolve(Response.json({}));
    }
    if (url.pathname.endsWith("/start")) {
      started = true;
      return Promise.resolve(Response.json({}));
    }
    if (url.pathname.endsWith("/stats")) {
      return Promise.resolve(Response.json({
        global_metrics: { incarnation_uuid: "incarnation" },
        inputs: [],
      }));
    }
    if (!created) return Promise.resolve(new Response(null, { status: 404 }));
    if (!started) state.program_status = compile(++compilePolls);
    else state.deployment_status = deploy();
    if (started) deployPolls++;
    return Promise.resolve(Response.json({ ...state, ...errors, program_code: sql }));
  };
  const program: IncrementalProgram = {
    sql: "CREATE VIEW empty AS SELECT 1;",
    inputs: {},
    outputs: {},
    incremental: { inputs: {}, outputs: {} },
  };
  const runtime = new NativeFeldera(
    "http://manager",
    "startup",
    program,
    "a".repeat(64),
    "postgres://postgres@database/app",
    profile,
  );
  return {
    initialize: () => runtime.initialize(db, {}, []),
    advance: (minutes: number) => {
      now += minutes * 60000;
    },
    get started() {
      return started;
    },
    get programConfig() {
      return programConfig;
    },
    get compilePolls() {
      return compilePolls;
    },
    get deployPolls() {
      return deployPolls;
    },
    [Symbol.dispose]() {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    },
  };
}

Deno.test("native compilation defaults to optimized and explicitly permits faster test builds", async () => {
  assertEquals(compilationProfile(), "optimized");
  assertEquals(compilationProfile("optimized"), "optimized");
  assertEquals(compilationProfile("unoptimized"), "unoptimized");
  for (const invalid of ["", "auto", "release", "dev"]) {
    assertThrows(
      () => compilationProfile(invalid),
      Error,
      "unsupported FELDERA_COMPILATION_PROFILE",
    );
  }
  for (const profile of [undefined, "unoptimized"] as const) {
    using fake = startup(() => "Success", undefined, profile);
    await fake.initialize();
    assertEquals(fake.programConfig, { profile: profile ?? "optimized" });
  }
});

Deno.test("native startup permits optimized compilation beyond ten minutes", async () => {
  using fake = startup((poll) => {
    if (poll === 1) {
      fake.advance(11);
      assertEquals(fake.started, false);
      return "CompilingRust";
    }
    return "Success";
  });
  await fake.initialize();
  assertEquals(fake.compilePolls, 2);
  assertEquals(fake.started, true);
});

Deno.test("native startup bounds compilation and keeps deployment waits shorter", async () => {
  {
    using fake = startup(() => {
      fake.advance(11);
      return "CompilingRust";
    });
    await assertRejects(fake.initialize, Error, "Compiled timed out");
    assertEquals(fake.compilePolls, 2);
    assertEquals(fake.started, false);
  }
  {
    using fake = startup(() => "Success", () => {
      fake.advance(6);
      return "Provisioning";
    });
    await assertRejects(fake.initialize, Error, "Running timed out");
    assertEquals(fake.deployPolls, 2);
  }
});

Deno.test("native startup fails immediately on a terminal compiler error", async () => {
  using fake = startup(() => "RustError", undefined, undefined, {
    program_error: { rust_compilation: { stderr: "linker diagnostic" } },
  });
  const error = await assertRejects(fake.initialize, Error, "RustError/Stopped");
  assert(error.message.includes("linker diagnostic"));
  assert(!error.message.includes("CREATE VIEW"));
  assertEquals(fake.compilePolls, 1);
  assertEquals(fake.started, false);
});

Deno.test("native CDC identity matches pinned ETL IDs", async () => {
  assertEquals(
    await replicationIdentity(
      "postgres://postgres:spike@postgres:5432/spike",
      "native_cdc_1",
      "public.a",
    ),
    {
      id: "-2971398649866695882",
      slot: "supabase_etl_apply_15475345423842855734",
    },
  );
  assertEquals(
    await replicationIdentity(
      "postgres://postgres:changed@postgres/spike?sslmode=disable",
      "native_cdc_1",
      "public.a",
    ),
    await replicationIdentity(
      "postgres://postgres:spike@postgres:5432/spike",
      "native_cdc_1",
      "public.a",
    ),
  );
});

Deno.test({
  name:
    "native CDC runtime captures deltas, restores baseline, and retires only owned slots",
  ignore: Deno.env.get("NATIVE_FELDERA_INTEGRATION") !== "1",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const profile = compilationProfile(Deno.env.get("FELDERA_COMPILATION_PROFILE"));
    const directory = await Deno.makeTempDir({
      prefix: "native-feldera-test-",
    });
    const project = "native-test-" + crypto.randomUUID().slice(0, 8);
    const file = directory + "/compose.yaml";
    await Deno.writeTextFile(
      file,
      `services:
  postgres:
    image: bonitao/mecha-database:0.8.0@sha256:ccb59fdc18217eb679456c62b0f5aa05d79138bcc8c431087984a6ff1e2b552b
    command: [postgres, -c, wal_level=logical, -c, max_replication_slots=20]
    environment: {POSTGRES_PASSWORD: spike, POSTGRES_DB: spike}
    ports: ["127.0.0.1::5432"]
    healthcheck:
      test: [CMD-SHELL, "pg_isready -U postgres -d spike"]
      interval: 1s
      timeout: 3s
      retries: 30
  feldera:
    image: images.feldera.com/feldera/pipeline-manager:0.367.0@sha256:42819714d16f7d5d37c17c87812ce98fb23efd2b1bfbf95b4889877f14693272
    environment: {FELDERA_DATABASE_URL: "postgres://postgres:spike@postgres:5432/spike"}
    ports: ["127.0.0.1::8080"]
    healthcheck:
      test: [CMD, curl, --fail, http://localhost:8080/healthz]
      interval: 1s
      timeout: 3s
      retries: 60
    depends_on:
      postgres: {condition: service_healthy}
`,
    );
    async function compose(...args: string[]) {
      const result = await new Deno.Command("docker", {
        args: ["compose", "-p", project, "-f", file, ...args],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(result.success, new TextDecoder().decode(result.stderr));
      return new TextDecoder().decode(result.stdout).trim();
    }
    async function until(check: () => Promise<boolean>, label: string) {
      const deadline = Date.now() + 30000;
      do {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      throw new Error(label + " timed out");
    }
    let db: pg.Pool | undefined;
    let batches: Batches | undefined;
    try {
      await compose("up", "-d", "--wait");
      db = new pg.Pool({
        connectionString: "postgres://postgres:spike@" +
          await compose("port", "postgres", "5432") + "/spike",
      });
      const endpoint = "http://" + await compose("port", "feldera", "8080");
      const uri = "postgres://postgres:spike@postgres:5432/spike";
      const version = "a".repeat(64);
      const program: IncrementalProgram = {
        sql:
          "CREATE TABLE source_rows (group_id VARCHAR, amount INTEGER); CREATE VIEW totals AS SELECT group_id,SUM(amount) AS amount FROM source_rows GROUP BY group_id;",
        inputs: {
          source_rows: {
            query: "SELECT group_id,amount FROM source_rows",
            fields: [{ name: "group_id", type: "VARCHAR" }, {
              name: "amount",
              type: "INTEGER",
            }],
          },
        },
        outputs: {
          totals: {
            view: "totals",
            fields: [{ name: "group_id", type: "VARCHAR" }, {
              name: "amount",
              type: "BIGINT",
            }],
          },
        },
        incremental: {
          inputs: {
            source_rows: { table: "items", projection: "group_id,amount" },
          },
          outputs: {
            totals: {
              partitionQuery:
                "SELECT group_id AS __partition,group_id,amount FROM totals",
            },
          },
        },
      };
      await db.query(`CREATE SCHEMA compute;
        CREATE TABLE compute.native_epoch(name text PRIMARY KEY,publications text[] NOT NULL,slots text[] NOT NULL);
        CREATE TABLE items(id text PRIMARY KEY,group_id text NOT NULL,amount integer NOT NULL,ignored text);
        INSERT INTO items VALUES('one','a',2,'before'),('two','a',3,'before'),('three','b',7,'before');
        CREATE TABLE unrelated(id integer PRIMARY KEY);
        CREATE PUBLICATION unrelated_publication FOR TABLE unrelated;`);
      await db.query(
        "SELECT pg_create_logical_replication_slot('unrelated_slot','pgoutput')",
      );
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await installSources(client, program, version);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const runtime = new NativeFeldera(
        endpoint,
        "native-runtime-test",
        program,
        version,
        uri,
        profile,
      );
      try {
        await runtime.initialize(db, { totals: [] }, []);
      } catch (error) {
        const diagnostics =
          await (await fetch(endpoint + "/v0/pipelines/" + runtime.name))
            .json();
        throw new Error(
          JSON.stringify({
            program: diagnostics.program_error,
            deployment: diagnostics.deployment_error,
          }),
          { cause: error },
        );
      }
      const configured =
        await (await fetch(endpoint + "/v0/pipelines/" + runtime.name)).json();
      assert(configured.program_code.includes("${env:FELDERA_DATABASE_URL}"));
      assertEquals(configured.program_code.includes(uri), false);
      assertEquals(configured.program_config.profile, profile);
      assertEquals(configured.program_code.includes("postgres:spike"), false);
      assert(await runtime.pending());
      const initial = await runtime.capture();
      assertEquals(
        initial.totals.toSorted((a, b) =>
          String(a.row.group_id).localeCompare(String(b.row.group_id))
        ),
        [
          { row: { __partition: "a", group_id: "a", amount: 5 }, weight: 1 },
          { row: { __partition: "b", group_id: "b", amount: 7 }, weight: 1 },
        ],
      );
      await runtime.acknowledge("initial", initial);
      assertEquals(await runtime.pending(), false);
      await runtime.acknowledge("initial", initial);
      assertEquals(await runtime.pending(), false);
      const { rows: [epoch] } = await db.query(
        "SELECT * FROM compute.native_epoch WHERE name=$1",
        [runtime.name],
      );
      const identity = await replicationIdentity(
        uri,
        epoch.publications[0],
        sourceSchema(version) + ".source_rows",
      );
      assert(epoch.slots.includes(identity.slot));
      const { rows: phases } = await db.query(
        "SELECT state FROM etl.replication_state WHERE pipeline_id=$1 AND is_current",
        [identity.id],
      );
      assertEquals(phases.length, 1);
      assert(["sync_done", "ready"].includes(phases[0].state));
      const carrierQuery = `SELECT __key,xmin::text FROM "${
        sourceSchema(version)
      }".source_rows ORDER BY __key`;
      const beforeIgnored = (await db.query(carrierQuery)).rows;
      await db.query(
        "UPDATE items SET ignored='after'; INSERT INTO unrelated VALUES(1)",
      );
      assertEquals((await db.query(carrierQuery)).rows, beforeIgnored);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assertEquals(await runtime.pending(), false);
      await db.query("UPDATE items SET amount=11 WHERE id='one'");
      await until(() => runtime.pending(), "CDC update");
      const changed = await runtime.capture();
      assertEquals(changed.totals.toSorted((a, b) => a.weight - b.weight), [
        { row: { __partition: "a", group_id: "a", amount: 5 }, weight: -1 },
        { row: { __partition: "a", group_id: "a", amount: 14 }, weight: 1 },
      ]);
      await runtime.acknowledge("update", changed);
      assertEquals(await runtime.pending(), false);
      const baseline = [{ __partition: "a", group_id: "a", amount: 14 }, {
        __partition: "b",
        group_id: "b",
        amount: 7,
      }];
      const restarted = new NativeFeldera(
        endpoint,
        runtime.name,
        program,
        version,
        uri,
        profile,
      );
      await restarted.initialize(db, { totals: baseline }, [
        "initial",
        "update",
      ]);
      assertEquals(await restarted.pending(), false);
      await restarted.acknowledge("update", changed);
      assertEquals(await restarted.pending(), false);
      const { rows: oldSlots } = await db.query(
        "SELECT slot_name FROM pg_replication_slots WHERE slot_name=ANY($1::text[])",
        [epoch.slots],
      );
      assertEquals(oldSlots, []);
      const { rows: oldPublications } = await db.query(
        "SELECT pubname FROM pg_publication WHERE pubname=ANY($1::text[])",
        [epoch.publications],
      );
      assertEquals(oldPublications, []);
      assertEquals(
        (await db.query(
          "SELECT slot_name FROM pg_replication_slots WHERE slot_name='unrelated_slot'",
        )).rows.length,
        1,
      );
      assertEquals(
        (await db.query(
          "SELECT pubname FROM pg_publication WHERE pubname='unrelated_publication'",
        )).rows.length,
        1,
      );
      await db.query("DELETE FROM items WHERE id='three'");
      await until(() => restarted.pending(), "CDC delete");
      const deleted = await restarted.capture();
      assertEquals(deleted.totals, [{ row: baseline[1], weight: -1 }]);
      await restarted.acknowledge("delete", deleted);
      assertEquals(await restarted.pending(), false);
      const stopped = await fetch(
        endpoint + "/v0/pipelines/" + runtime.name + "/stop?force=true",
        { method: "POST" },
      );
      assert(stopped.ok);
      await stopped.text();
      await until(
        async () =>
          (await (await fetch(endpoint + "/v0/pipelines/" + runtime.name))
            .json()).deployment_status === "Stopped",
        "stop class fixture",
      );
      await db.query(`CREATE ROLE service NOLOGIN;
        CREATE OR REPLACE FUNCTION public.app_pre_request() RETURNS void LANGUAGE plpgsql AS $$BEGIN END$$;
        CREATE TABLE runtime_items(id text PRIMARY KEY,group_id text NOT NULL,amount integer NOT NULL);
        INSERT INTO runtime_items VALUES('one','a',2),('two','a',3),('three','b',7);
        CREATE TABLE runtime_sink(id text PRIMARY KEY,amount integer NOT NULL);
        GRANT ALL ON runtime_sink TO service;`);
      const fullProgram: IncrementalProgram = {
        ...program,
        incremental: {
          ...program.incremental,
          inputs: {
            source_rows: {
              table: "runtime_items",
              projection: "group_id,amount",
            },
          },
        },
      };
      let calculations = 0;
      const computation = {
        name: "native-runtime-publication",
        to: ["runtime_sink"],
        calculate(input: unknown) {
          calculations++;
          const { totals } = input as {
            totals: { group_id: string; amount: number }[];
          };
          return Promise.resolve({
            runtime_sink: totals.map((r) => ({
              id: r.group_id,
              amount: r.amount * 2,
            })),
          });
        },
      };
      const abandonedVersion = "c".repeat(64);
      const unrelatedVersion = "d".repeat(64);
      const abandonedInstaller = await db.connect();
      try {
        await abandonedInstaller.query("BEGIN");
        await installSources(
          abandonedInstaller,
          fullProgram,
          abandonedVersion,
          computation.name,
        );
        await installSources(
          abandonedInstaller,
          fullProgram,
          unrelatedVersion,
          "unrelated-source-owner",
        );
        await abandonedInstaller.query("COMMIT");
      } finally {
        abandonedInstaller.release();
      }
      assertEquals(
        (await db.query(
          "SELECT source_schema FROM compute.native_sources WHERE name=$1",
          [computation.name],
        )).rows,
        [{ source_schema: sourceSchema(abandonedVersion) }],
      );
      assertEquals(
        (await db.query("SELECT name FROM compute.native_epoch WHERE name=$1", [
          computation.name,
        ])).rows,
        [],
      );
      const options = { coalesceMs: 0, pollInterval: 20 };
      let full = new NativeRuntime(
        db,
        endpoint,
        computation,
        fullProgram,
        "b".repeat(64),
        uri,
        { role: "service" },
        profile,
      );
      const connectionString = db.options.connectionString!;
      batches = await openBatches(connectionString, [full.spec], options);
      await full.initialize();
      assertEquals(
        (await db.query(
          "SELECT to_regnamespace($1)::text AS abandoned,to_regnamespace($2)::text AS unrelated,to_regnamespace($3)::text AS active",
          [
            sourceSchema(abandonedVersion),
            sourceSchema(unrelatedVersion),
            sourceSchema("b".repeat(64)),
          ],
        )).rows,
        [{
          abandoned: null,
          unrelated: sourceSchema(unrelatedVersion),
          active: sourceSchema("b".repeat(64)),
        }],
      );
      assertEquals(
        (await db.query(
          "SELECT source_schema FROM compute.native_sources WHERE name=$1",
          [computation.name],
        )).rows,
        [{ source_schema: sourceSchema("b".repeat(64)) }],
      );
      assertEquals(
        (await db.query(
          "SELECT source_schema FROM compute.native_sources WHERE name='unrelated-source-owner'",
        )).rows,
        [{ source_schema: sourceSchema(unrelatedVersion) }],
      );
      const settle = async () => {
        assert(await full.pending());
        await batches!.invalidateNames([computation.name]);
        await until(async () => {
          const { rows: [state] } = await db!.query(
            "SELECT requested=completed AS done FROM compute.batch WHERE name=$1",
            [computation.name],
          );
          return state.done;
        }, "durable native publication");
        assertEquals(await full.pending(), false);
      };
      await settle();
      assertEquals(calculations, 2);
      assertEquals(
        (await db.query("SELECT * FROM runtime_sink ORDER BY id")).rows,
        [{ id: "a", amount: 10 }, { id: "b", amount: 14 }],
      );
      const beforePoint =
        (await db.query("SELECT xmin::text FROM runtime_sink WHERE id='b'"))
          .rows;
      await db.query("UPDATE runtime_items SET amount=11 WHERE id='one'");
      await until(() => full.pending(), "durable runtime CDC update");
      await settle();
      assertEquals(calculations, 3);
      assertEquals(
        (await db.query("SELECT * FROM runtime_sink ORDER BY id")).rows,
        [{ id: "a", amount: 28 }, { id: "b", amount: 14 }],
      );
      assertEquals(
        (await db.query("SELECT xmin::text FROM runtime_sink WHERE id='b'"))
          .rows,
        beforePoint,
      );
      const beforeRestart =
        (await db.query("SELECT id,xmin::text FROM runtime_sink ORDER BY id"))
          .rows;
      await batches.close();
      batches = undefined;
      full = new NativeRuntime(
        db,
        endpoint,
        computation,
        fullProgram,
        "b".repeat(64),
        uri,
        { role: "service" },
        profile,
      );
      batches = await openBatches(connectionString, [full.spec], options);
      await full.initialize();
      await settle();
      assertEquals(calculations, 3);
      assertEquals(
        (await db.query("SELECT id,xmin::text FROM runtime_sink ORDER BY id"))
          .rows,
        beforeRestart,
      );
      await db.query("DELETE FROM runtime_items WHERE id='three'");
      await until(() => full.pending(), "durable runtime CDC delete");
      await settle();
      assertEquals(calculations, 4);
      assertEquals(
        (await db.query("SELECT * FROM runtime_sink ORDER BY id")).rows,
        [{ id: "a", amount: 28 }],
      );
      await db.query("UPDATE runtime_sink SET amount=999 WHERE id='a'");
      await settle();
      assertEquals(calculations, 5);
      assertEquals(
        (await db.query("SELECT * FROM runtime_sink ORDER BY id")).rows,
        [{ id: "a", amount: 28 }],
      );
      await db.query("TRUNCATE runtime_sink");
      await settle();
      assertEquals(calculations, 6);
      assertEquals(
        (await db.query("SELECT * FROM runtime_sink ORDER BY id")).rows,
        [{ id: "a", amount: 28 }],
      );
      assertEquals(
        (await db.query(
          `SELECT amount FROM "${
            sourceSchema(unrelatedVersion)
          }".source_rows WHERE __key='one'`,
        )).rows,
        [{ amount: 11 }],
      );
      await batches.close();
      batches = undefined;
    } finally {
      if (batches) await batches.close();
      if (db) await db.end();
      await compose("down", "-v");
      await Deno.remove(directory, { recursive: true });
    }
  },
});
