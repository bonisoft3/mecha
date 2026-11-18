import { assert, assertEquals, assertRejects } from "@std/assert";
import pg from "npm:pg@8.16.3";
import { NativeRuntime } from "./native-runtime.ts";
import { type Batches, openBatches } from "./batches.ts";
import { NativeRisingWave } from "./native-risingwave.ts";
import type { RisingWaveSqlSession } from "./risingwave.ts";
import {
  type IncrementalProgram,
  installSources,
} from "./native-sources.ts";

function bootstrapFixture(
  pollFn: (
    poll: number,
  ) => { flushed: boolean; counts: Record<string, number> },
  secondSource = false,
) {
  const originalNow = Date.now;
  let now = 0;
  let polls = 0;
  let registeredPipeline: unknown;
  const sourceNames = ["probe", ...(secondSource ? ["stuck"] : [])];

  const client = {
    query: (sql: string, args?: unknown[]) => {
      if (sql.includes("INSERT INTO compute.native_epoch")) {
        registeredPipeline = args?.[4];
      }
      if (sql.includes("SELECT count(*)::int AS n FROM")) {
        return Promise.resolve({ rows: [{ n: 100 }] });
      }
      if (sql.includes("AS present")) {
        return Promise.resolve({ rows: [{ present: false }] });
      }
      return Promise.resolve({ rows: [] });
    },
    release() {},
  };

  let latestSnapshot = { flushed: false, counts: {} as Record<string, number> };
  const db = {
    connect: () => Promise.resolve(client),
    query: (sql: string) => {
      if (sql.includes("pg_replication_slots")) {
        latestSnapshot = pollFn(++polls);
        return Promise.resolve({
          rows: [{ active: true, flushed: latestSnapshot.flushed }],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  } as unknown as pg.Pool;

  const session: RisingWaveSqlSession = {
    query<R extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: R[] }> {
      if (sql.includes("information_schema.schemata")) {
        return Promise.resolve({
          rows: [{ present: "rw_startup" }] as unknown as R[],
        });
      }
      for (const name of sourceNames) {
        if (sql.includes(`FROM cdc_${name}`)) {
          const n = latestSnapshot.counts[name] ?? 0;
          return Promise.resolve({ rows: [{ n }] as unknown as R[] });
        }
      }
      return Promise.resolve({ rows: [] });
    },
    end() {
      return Promise.resolve();
    },
  };

  Date.now = () => now;
  const program: IncrementalProgram = {
    sql:
      sourceNames.map((name) => `CREATE TABLE ${name}(id VARCHAR);\n`).join("") +
      "CREATE VIEW empty AS SELECT 1;",
    inputs: Object.fromEntries(
      sourceNames.map((name) => [
        name,
        {
          query: "SELECT id FROM items",
          fields: [{ name: "id", type: "VARCHAR" }],
        },
      ]),
    ),
    outputs: {},
    incremental: { inputs: {}, outputs: {} },
  };
  const runtime = new NativeRisingWave(
    "http://risingwave:4566",
    "startup",
    program,
    "a".repeat(64),
    "postgres://postgres@database/app",
    () => Promise.resolve(session),
  );
  return {
    initialize: async () => {
      await runtime.initialize(db, {}, []);
      assertEquals(registeredPipeline, "http://risingwave:4566/pipelines/startup");
    },
    advance: (minutes: number) => {
      now += minutes * 60000;
    },
    [Symbol.dispose]() {
      Date.now = originalNow;
    },
  };
}

Deno.test("native bootstrap permits a progressing snapshot beyond ten minutes", async () => {
  using fake = bootstrapFixture((poll) => {
    fake.advance(4);
    return {
      flushed: true,
      counts: { probe: poll === 5 ? 100 : poll * 20 },
    };
  });
  await fake.initialize();
});

Deno.test("native bootstrap fails when neither ingestion nor the circuit advances", async () => {
  using fake = bootstrapFixture(() => {
    fake.advance(11);
    return { flushed: false, counts: { probe: 0 } };
  });
  await assertRejects(
    fake.initialize,
    Error,
    "native CDC bootstrap made no progress for ten minutes",
  );
});

Deno.test("progress on another source cannot hide a stalled bootstrap", async () => {
  using fake = bootstrapFixture((poll) => {
    fake.advance(4);
    return {
      flushed: true,
      counts: { probe: poll * 100, stuck: 0 },
    };
  }, true);
  await assertRejects(
    fake.initialize,
    Error,
    "native CDC bootstrap made no progress for ten minutes: stuck",
  );
});

// Derived materialized views must wait for CDC table snapshots and captured_*
// seeding so multi-hundred-thousand-row backfills do not stall barriers or
// retract intermediate aggregates on every CDC batch.
Deno.test("native bootstrap finishes CDC snapshots and baseline ingress before creating derived views", async () => {
  const order: string[] = [];
  let countPolls = 0;
  const client = {
    query: (sql: string) => {
      if (sql.includes("SELECT count(*)::int AS n FROM")) {
        return Promise.resolve({ rows: [{ n: 2 }] });
      }
      if (sql.includes("AS present")) {
        return Promise.resolve({ rows: [{ present: false }] });
      }
      return Promise.resolve({ rows: [] });
    },
    release() {},
  };
  const db = {
    connect: () => Promise.resolve(client),
    query: (sql: string) =>
      Promise.resolve({
        rows: sql.includes("pg_replication_slots")
          ? [{ active: true, flushed: true }]
          : [],
      }),
  } as unknown as pg.Pool;
  const session: RisingWaveSqlSession = {
    query<R extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: R[] }> {
      if (sql.includes("information_schema.schemata")) {
        return Promise.resolve({
          rows: [{ present: "rw_ordered" }] as unknown as R[],
        });
      }
      if (sql.startsWith("SELECT count(*)::int AS n FROM cdc_source_item")) {
        const n = ++countPolls >= 2 ? 2 : 1;
        order.push(`poll:${n}`);
        return Promise.resolve({ rows: [{ n }] as unknown as R[] });
      }
      if (
        sql.startsWith("CREATE ") ||
        sql.startsWith("INSERT INTO captured_")
      ) {
        order.push(sql.split(/\s+/).slice(0, 3).join(" "));
      }
      return Promise.resolve({ rows: [] });
    },
    end: () => Promise.resolve(),
  };
  const program: IncrementalProgram = {
    sql: [
      "CREATE TABLE source_item(id VARCHAR);",
      "CREATE LOCAL VIEW local_items AS SELECT id FROM source_item;",
      "CREATE MATERIALIZED VIEW result_items AS SELECT id FROM local_items;",
    ].join("\n"),
    inputs: {
      source_item: {
        query: "SELECT id FROM item",
        fields: [{ name: "id", type: "VARCHAR" }],
      },
    },
    outputs: {
      items: {
        view: "result_items",
        fields: [{ name: "id", type: "VARCHAR" }],
      },
    },
    incremental: {
      inputs: { source_item: { table: "item", projection: "id" } },
      outputs: { items: { partitionQuery: "SELECT '' AS __partition, id FROM result_items" } },
    },
  };
  const runtime = new NativeRisingWave(
    "http://risingwave:4566",
    "ordered",
    program,
    "a".repeat(64),
    "postgres://postgres@database/app",
    () => Promise.resolve(session),
  );
  await runtime.initialize(db, { items: [{ __partition: "", id: "seed" }] }, []);
  assertEquals(order, [
    "CREATE SCHEMA \"rw_ordered\"",
    "CREATE TABLE __ack_state",
    "CREATE SOURCE pg_shared_source",
    "CREATE TABLE captured_items",
    "INSERT INTO captured_items",
    "CREATE TABLE cdc_source_item",
    "CREATE VIEW source_item",
    "poll:1",
    "poll:2",
    "CREATE VIEW local_items",
    "CREATE MATERIALIZED VIEW",
    "CREATE VIEW stream_items",
    "CREATE MATERIALIZED VIEW",
  ]);
});

Deno.test("native acknowledge casts DOUBLE literals from text to avoid RisingWave DECIMAL rounding", async () => {
  const executed: string[] = [];
  const client = {
    query: (sql: string) =>
      Promise.resolve({
        rows: sql.includes("AS present") ? [{ present: false }] : [],
      }),
    release() {},
  };
  const db = {
    connect: () => Promise.resolve(client),
    query: () => Promise.resolve({ rows: [] }),
  } as unknown as pg.Pool;
  const session: RisingWaveSqlSession = {
    query<R extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: R[] }> {
      executed.push(sql);
      return Promise.resolve({ rows: [] });
    },
    end() {
      return Promise.resolve();
    },
  };
  const program: IncrementalProgram = {
    sql: "CREATE VIEW games AS SELECT '' AS id, 0.0::double precision AS away_off;",
    inputs: {},
    outputs: {
      games: {
        view: "games",
        fields: [
          { name: "id", type: "VARCHAR" },
          { name: "away_off", type: "DOUBLE" },
        ],
      },
    },
    incremental: {
      inputs: {},
      outputs: {
        games: { partitionQuery: "SELECT '' AS __partition, * FROM games" },
      },
    },
  };
  const runtime = new NativeRisingWave(
    "http://risingwave:4566",
    "chances",
    program,
    "a".repeat(64),
    "postgres://postgres@database/app",
    () => Promise.resolve(session),
  );
  await runtime.initialize(db, { games: [] }, []);
  await runtime.acknowledge("step-1", {
    games: [
      {
        row: { __partition: "p1", id: "g1", away_off: 0.4494880139827728 },
        weight: 1,
      },
    ],
  });
  const insert = executed.find((sql) => sql.startsWith("INSERT INTO captured_games"));
  assert(
    insert?.includes("'0.4494880139827728'::double precision"),
    `expected string-to-double cast in ${insert}`,
  );
});

// PostgreSQL jsonb reorders object keys by length before lexicographical order,
// so baseline rows reloaded from compute.stream_partition.inputs arrive with
// short keys (`id`) ahead of `__partition`. Retracting that row on acknowledge
// must produce the identical `__key` as baseline insertion.
Deno.test("native ingress keys captured rows in schema order regardless of jsonb key order", async () => {
  const keys = new Set<string>();
  const client = {
    query: (sql: string) =>
      Promise.resolve({
        rows: sql.includes("AS present") ? [{ present: false }] : [],
      }),
    release() {},
  };
  const db = {
    connect: () => Promise.resolve(client),
    query: () => Promise.resolve({ rows: [] }),
  } as unknown as pg.Pool;
  const mults = new Map<string, number>();
  const session: RisingWaveSqlSession = {
    query<R extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: R[] }> {
      const sel = /^SELECT __key, __rw_mult FROM captured_games WHERE __key IN \('((?:''|[^'])*)'\)/.exec(sql);
      if (sel) {
        const k = sel[1].replaceAll("''", "'");
        const m = mults.get(k);
        return Promise.resolve({
          rows: (m !== undefined ? [{ __key: k, __rw_mult: m }] : []) as unknown as R[],
        });
      }
      const del = /^DELETE FROM captured_games WHERE __key IN \('((?:''|[^'])*)'\)/.exec(sql);
      if (del) {
        const k = del[1].replaceAll("''", "'");
        keys.delete(k);
        mults.delete(k);
      }
      const ins = /^INSERT INTO captured_games \([^)]+\) VALUES \('((?:''|[^'])*)',(\d+)/.exec(sql);
      if (ins) {
        const k = ins[1].replaceAll("''", "'");
        keys.add(k);
        mults.set(k, Number(ins[2]));
      }
      return Promise.resolve({ rows: [] });
    },
    end: () => Promise.resolve(),
  };
  const program: IncrementalProgram = {
    sql: "CREATE VIEW games AS SELECT '' AS id, 0 AS amount;",
    inputs: {},
    outputs: {
      games: {
        view: "games",
        fields: [{ name: "id", type: "VARCHAR" }, { name: "amount", type: "INTEGER" }],
      },
    },
    incremental: {
      inputs: {},
      outputs: { games: { partitionQuery: "SELECT '' AS __partition, * FROM games" } },
    },
  };
  const runtime = new NativeRisingWave(
    "http://risingwave:4566",
    "chances",
    program,
    "a".repeat(64),
    "postgres://postgres@database/app",
    () => Promise.resolve(session),
  );
  const dup = JSON.parse('{"id":"g1","amount":10,"__partition":"p1"}');
  await runtime.initialize(
    db,
    { games: [dup, dup] },
    [],
  );
  assertEquals(keys.size, 1);
  assertEquals([...mults.values()], [2]);
  await runtime.acknowledge("step-dec", {
    games: [{ row: { __partition: "p1", id: "g1", amount: 10 }, weight: -1 }],
  });
  assertEquals(keys.size, 1);
  assertEquals([...mults.values()], [1]);
  await runtime.acknowledge("step-del", {
    games: [{ row: { __partition: "p1", id: "g1", amount: 10 }, weight: -1 }],
  });
  assertEquals(keys.size, 0);
});

Deno.test("native bootstrap converges when concurrent deletes shrink mirror rows below pre-slot count", async () => {
  const client = {
    query: (sql: string) => {
      if (sql.includes("SELECT count(*)::int AS n FROM")) {
        return Promise.resolve({ rows: [{ n: 100 }] });
      }
      if (sql.includes("AS present")) {
        return Promise.resolve({ rows: [{ present: false }] });
      }
      return Promise.resolve({ rows: [] });
    },
    release() {},
  };
  const db = {
    connect: () => Promise.resolve(client),
    query: (sql: string) => {
      if (sql.includes("pg_replication_slots")) {
        return Promise.resolve({ rows: [{ active: true, flushed: true }] });
      }
      if (sql.includes("SELECT count(*)::int AS n FROM")) {
        return Promise.resolve({ rows: [{ n: 40 }] });
      }
      return Promise.resolve({ rows: [] });
    },
  } as unknown as pg.Pool;
  const session: RisingWaveSqlSession = {
    query<R extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ): Promise<{ rows: R[] }> {
      if (sql.includes("information_schema.schemata")) {
        return Promise.resolve({ rows: [{ present: "rw_startup" }] as unknown as R[] });
      }
      if (sql.includes("FROM cdc_probe")) {
        return Promise.resolve({ rows: [{ n: 40 }] as unknown as R[] });
      }
      return Promise.resolve({ rows: [] });
    },
    end: () => Promise.resolve(),
  };
  const program: IncrementalProgram = {
    sql: "CREATE TABLE probe(id VARCHAR);\nCREATE VIEW empty AS SELECT 1;",
    inputs: {
      probe: { query: "SELECT id FROM items", fields: [{ name: "id", type: "VARCHAR" }] },
    },
    outputs: {},
    incremental: { inputs: {}, outputs: {} },
  };
  const runtime = new NativeRisingWave(
    "http://risingwave:4566",
    "startup",
    program,
    "a".repeat(64),
    "postgres://postgres@database/app",
    () => Promise.resolve(session),
  );
  await runtime.initialize(db, {}, []);
});

Deno.test({
  name:
    "native CDC runtime captures deltas, restores baseline, and retires only owned slots",
  ignore: Deno.env.get("NATIVE_RISINGWAVE_INTEGRATION") !== "1",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "native-risingwave-test-",
    });
    const project = "native-test-" + crypto.randomUUID().slice(0, 8);
    const file = directory + "/compose.yaml";
    await Deno.writeTextFile(
      file,
      `services:
  postgres:
    image: bonitao/mecha-database:0.26.0@sha256:bc17c811912900b9ed4ba691167be6dc56f961b437dd765bebd4e53148aa92ec
    command: [postgres, -c, wal_level=logical, -c, max_replication_slots=20]
    environment: {POSTGRES_PASSWORD: spike, POSTGRES_DB: spike}
    ports: ["127.0.0.1::5432"]
    healthcheck:
      test: [CMD-SHELL, "pg_isready -U postgres -d spike"]
      interval: 1s
      timeout: 3s
      retries: 30
  risingwave:
    image: risingwavelabs/risingwave:v3.1.1@sha256:b869358fa704250d25045d3575145ca59cfb67a558a08fa4f8fd375874c24d63
    command: [single_node]
    ports: ["127.0.0.1::4566"]
    healthcheck:
      test: [CMD-SHELL, "bash -c '</dev/tcp/127.0.0.1/4566'"]
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
      const pgAddr = await compose("port", "postgres", "5432");
      const rwAddr = await compose("port", "risingwave", "4566");
      db = new pg.Pool({
        connectionString: "postgres://postgres:spike@" + pgAddr + "/spike",
      });
      const endpoint = "http://" + rwAddr;
      const uri = "postgres://postgres:spike@postgres:5432/spike";
      const version = "a".repeat(64);
      const program: IncrementalProgram = JSON.parse(
        await Deno.readTextFile(
          new URL("./fixtures/native-integration.json", import.meta.url),
        ),
      );
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
      const runtime = new NativeRisingWave(
        endpoint,
        "native-runtime-test",
        program,
        version,
        uri,
      );
      await runtime.initialize(db, { totals: [] }, []);
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
      await db.query("UPDATE items SET amount=11 WHERE id='one'");
      await until(() => runtime.pending(), "CDC update");
      const changed = await runtime.capture();
      assertEquals(changed.totals.toSorted((a, b) => a.weight - b.weight), [
        { row: { __partition: "a", group_id: "a", amount: 5 }, weight: -1 },
        { row: { __partition: "a", group_id: "a", amount: 14 }, weight: 1 },
      ]);
      await runtime.acknowledge("update", changed);
      assertEquals(await runtime.pending(), false);
      const baseline = [
        { __partition: "a", group_id: "a", amount: 14 },
        { __partition: "b", group_id: "b", amount: 7 },
      ];
      await runtime.close();
      const restarted = new NativeRisingWave(
        endpoint,
        runtime.name,
        program,
        version,
        uri,
      );
      await restarted.initialize(db, { totals: baseline }, [
        "initial",
        "update",
      ]);
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
      await restarted.close();

      await db.query(`CREATE ROLE service NOLOGIN;
        CREATE OR REPLACE FUNCTION public.app_pre_request() RETURNS void LANGUAGE plpgsql AS $$BEGIN END$$;
        CREATE TABLE runtime_items(id text PRIMARY KEY,group_id text NOT NULL,amount integer NOT NULL);
        INSERT INTO runtime_items VALUES('one','a',2),('two','a',3),('three','b',7);
        CREATE TABLE runtime_sink(id text PRIMARY KEY,amount integer NOT NULL);
        GRANT ALL ON runtime_sink TO service;`);
      const fullProgram: IncrementalProgram = {
        ...program,
        sql: `${program.sql} CREATE VIEW counts AS SELECT group_id,COUNT(*) AS cnt FROM source_rows GROUP BY group_id;`,
        outputs: {
          ...program.outputs,
          counts: {
            view: "counts",
            fields: [
              { name: "group_id", type: "VARCHAR" },
              { name: "cnt", type: "BIGINT" },
            ],
          },
        },
        incremental: {
          ...program.incremental,
          inputs: {
            source_rows: {
              table: "runtime_items",
              projection: "group_id,amount",
            },
          },
          outputs: {
            ...program.incremental.outputs,
            counts: {
              partitionQuery:
                "SELECT group_id AS __partition,group_id,cnt FROM counts",
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
      const options = { coalesceMs: 0, pollInterval: 20 };
      const full = new NativeRuntime(
        db,
        endpoint,
        computation,
        fullProgram,
        "b".repeat(64),
        uri,
        { role: "service" },
      );
      const connectionString = db.options.connectionString!;
      batches = await openBatches(connectionString, [full.spec], options);
      await full.initialize();
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
      const { rows: [firstEpoch] } = await db.query(
        "SELECT slots, publications FROM compute.native_epoch WHERE name=$1",
        [computation.name],
      );
      await batches.close();
      batches = undefined;
      await full.close();

      // Persisted COMPUTE_STATE_DIR across restarts reattaches without dropping
      // the replication slot or recomputing unchanged partitions, while still
      // streaming subsequent WAL mutations.
      const reattached = new NativeRuntime(
        db,
        endpoint,
        computation,
        fullProgram,
        "b".repeat(64),
        uri,
        { role: "service" },
      );
      batches = await openBatches(connectionString, [reattached.spec], options);
      await reattached.initialize();
      const { rows: [reattachedEpoch] } = await db.query(
        "SELECT slots, publications FROM compute.native_epoch WHERE name=$1",
        [computation.name],
      );
      assertEquals(reattachedEpoch.slots, firstEpoch.slots);
      assertEquals(reattachedEpoch.publications, firstEpoch.publications);
      assert(await reattached.pending());
      await batches.invalidateNames([computation.name]);
      await until(async () => {
        const { rows: [state] } = await db!.query(
          "SELECT requested=completed AS done FROM compute.batch WHERE name=$1",
          [computation.name],
        );
        return state.done;
      }, "warm reattach idle verification");
      assertEquals(calculations, 2);

      await db.query("UPDATE runtime_items SET amount=5 WHERE id='one'");
      await until(() => reattached.pending(), "CDC update after warm reattach");
      await batches.invalidateNames([computation.name]);
      await until(async () => {
        const { rows: [state] } = await db!.query(
          "SELECT requested=completed AS done FROM compute.batch WHERE name=$1",
          [computation.name],
        );
        return state.done;
      }, "warm reattach CDC publication");
      assertEquals(calculations, 3);
      assertEquals(
        (await db.query("SELECT * FROM runtime_sink ORDER BY id")).rows,
        [{ id: "a", amount: 16 }, { id: "b", amount: 14 }],
      );
      await batches.close();
      batches = undefined;
      await reattached.close();

      // Changing the computation version invalidates warm attach, retires the
      // prior slot and publication, and rebuilds cleanly.
      const upgraded = new NativeRuntime(
        db,
        endpoint,
        computation,
        fullProgram,
        "c".repeat(64),
        uri,
        { role: "service" },
      );
      batches = await openBatches(connectionString, [upgraded.spec], options);
      await upgraded.initialize();
      const { rows: retiredSlots } = await db.query(
        "SELECT slot_name FROM pg_replication_slots WHERE slot_name=ANY($1::text[])",
        [firstEpoch.slots],
      );
      assertEquals(retiredSlots, []);
      await batches.close();
      batches = undefined;
      await upgraded.close();
    } finally {
      if (batches) await batches.close();
      if (db) await db.end();
      await compose("down", "-v");
      await Deno.remove(directory, { recursive: true });
    }
  },
});
