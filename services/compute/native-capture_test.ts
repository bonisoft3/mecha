import { assert, assertEquals, assertRejects } from "@std/assert";
import pg from "npm:pg@8.16.3";
import { NativeFeldera } from "./native-feldera.ts";
import { DeltaStore } from "./deltas.ts";
import { type IncrementalProgram, installSources } from "./native-sources.ts";

Deno.test({
  name:
    "native capture keeps heterogeneous outputs and validation in one request snapshot",
  ignore: Deno.env.get("NATIVE_FELDERA_INTEGRATION") !== "1",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "native-capture-test-",
    });
    const project = "capture-test-" + crypto.randomUUID().slice(0, 8);
    const file = directory + "/compose.yaml";
    await Deno.writeTextFile(
      file,
      `services:
  postgres:
    image: postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3
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
    const originalFetch = globalThis.fetch;
    let captures = false;
    let queries: string[] = [];
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (captures && url.pathname.endsWith("/query")) {
        queries.push(url.searchParams.get("sql")!);
      }
      return originalFetch(input, init);
    };
    let db: pg.Pool | undefined;
    try {
      await compose("up", "-d", "--wait");
      db = new pg.Pool({
        connectionString: "postgres://postgres:spike@" +
          await compose("port", "postgres", "5432") + "/spike",
      });
      const endpoint = "http://" + await compose("port", "feldera", "8080");
      const fields = [
        { name: "record_id", type: "INTEGER" },
        { name: "amount", type: "INTEGER" },
        { name: "label", type: "VARCHAR" },
        { name: "occurred", type: "TIMESTAMP" },
        { name: "flag", type: "BOOLEAN" },
      ];
      const program: IncrementalProgram = {
        sql:
          `CREATE TABLE source_rows(record_id INTEGER,amount INTEGER,label VARCHAR,occurred TIMESTAMP(6),flag BOOLEAN);
          CREATE VIEW detail AS SELECT * FROM source_rows;
          CREATE VIEW summary AS SELECT COUNT(*) AS n,SUM(amount) AS total FROM source_rows;`,
        inputs: { source_rows: { query: "", fields } },
        outputs: {
          detail: { view: "detail", fields },
          summary: {
            view: "summary",
            fields: [{ name: "n", type: "BIGINT" }, {
              name: "total",
              type: "BIGINT",
            }],
          },
        },
        incremental: {
          inputs: {
            source_rows: {
              table: "items",
              projection: "id AS record_id,amount,label,occurred,flag",
            },
          },
          outputs: {
            detail: {
              partitionQuery: "SELECT '' AS __partition,* FROM detail",
            },
            summary: {
              partitionQuery: "SELECT '' AS __partition,* FROM summary",
            },
          },
          checks: {
            negative_amount: "SELECT record_id FROM source_rows WHERE amount<0",
          },
        },
      };
      await db.query(`CREATE SCHEMA compute;
        CREATE TABLE compute.native_epoch(name text PRIMARY KEY,publications text[] NOT NULL,slots text[] NOT NULL);
        CREATE TABLE items(id integer PRIMARY KEY,amount integer NOT NULL,label text NOT NULL,occurred timestamp(6) NOT NULL,flag boolean);
        INSERT INTO items SELECT id,id,'initial','2026-01-02 03:04:05.123456'::timestamp,CASE WHEN id%2=0 THEN true ELSE NULL END FROM generate_series(1,256) id;`);
      const client = await db.connect();
      const version = "e".repeat(64);
      try {
        await client.query("BEGIN");
        await installSources(client, program, version, "capture-test");
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      const runtime = new NativeFeldera(
        endpoint,
        "capture-test",
        program,
        version,
        "postgres://postgres:spike@postgres:5432/spike",
      );
      await runtime.initialize(db, { detail: [], summary: [] }, []);
      const store = new DeltaStore({
        detail: "__partition",
        summary: "__partition",
      });
      store.bootstrap({ detail: [], summary: [] });
      let sequence = 0;
      const capture = async () => {
        queries = [];
        captures = true;
        let delta;
        try {
          delta = await runtime.capture();
        } finally {
          captures = false;
        }
        assertEquals(
          queries.length,
          1,
          "one HTTP SQL request must capture every output and validation relation",
        );
        store.apply(delta);
        const state = store.capture("");
        assertEquals(state.summary.length, 1);
        assertEquals(state.summary[0].n, state.detail.length);
        assertEquals(
          state.summary[0].total,
          state.detail.reduce((total, row) => total + Number(row.amount), 0),
        );
        for (const row of state.detail) {
          assertEquals(row.occurred, "2026-01-02T03:04:05.123456Z");
          assertEquals(row.flag, Number(row.record_id) % 2 === 0 ? true : null);
          assert(typeof row.label === "string");
        }
        await runtime.acknowledge(String(sequence++), delta);
        return state;
      };
      assertEquals((await capture()).detail.length, 256);
      // Every cut must satisfy the aggregate/detail invariant even if a source transaction is split.
      for (let wave = 1; wave <= 6; wave++) {
        const writes = (async () => {
          for (let update = 0; update < 8; update++) {
            await db!.query("UPDATE items SET amount=amount+1,label=$1", [
              "wave-" + wave,
            ]);
          }
        })();
        for (const result of await Promise.allSettled([writes, capture()])) {
          if (result.status === "rejected") throw result.reason;
        }
      }
      const deadline = Date.now() + 60000;
      let state = await capture();
      while (
        state.detail.some((r) => r.label !== "wave-6") ||
        state.summary[0].total !== 256 * 257 / 2 + 256 * 48
      ) {
        assert(Date.now() < deadline, "final source updates did not converge");
        await new Promise((resolve) => setTimeout(resolve, 50));
        state = await capture();
      }
      assertEquals(state.summary[0].total, 256 * 257 / 2 + 256 * 48);
      await db.query("UPDATE items SET amount=-1 WHERE id=1");
      const invalidDeadline = Date.now() + 30000;
      for (;;) {
        const response = await fetch(
          endpoint + "/v0/pipelines/capture-test/query?" +
            new URLSearchParams({
              sql: "SELECT * FROM invalid_negative_amount",
              format: "json",
            }),
        );
        assert(response.ok);
        if ((await response.text()).trim()) break;
        assert(Date.now() < invalidDeadline, "invalid source row not observed");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      queries = [];
      captures = true;
      try {
        await assertRejects(() => runtime.capture(), Error, "negative_amount");
      } finally {
        captures = false;
      }
      assertEquals(
        queries.length,
        1,
        "validation must share the captured output snapshot",
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (db) await db.end();
      await compose("down", "-v");
      await Deno.remove(directory, { recursive: true });
    }
  },
});
