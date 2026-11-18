import { assert, assertEquals, assertRejects } from "@std/assert";
import pg from "npm:pg@8.16.3";
import { NativeRisingWave } from "./native-risingwave.ts";
import { defaultRisingWaveConnect } from "./risingwave.ts";
import { DeltaStore } from "./deltas.ts";
import { type IncrementalProgram, installSources } from "./native-sources.ts";

Deno.test({
  name:
    "native capture keeps heterogeneous outputs and validation in one request snapshot",
  ignore: Deno.env.get("NATIVE_RISINGWAVE_INTEGRATION") !== "1",
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
    let captures = false;
    let queries: string[] = [];
    const trackedConnect = async (connStr: string) => {
      const session = await defaultRisingWaveConnect(connStr);
      return {
        query<R extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          values?: unknown[],
        ): Promise<{ rows: R[] }> {
          if (captures && text.includes("UNION ALL")) {
            queries.push(text);
          }
          return session.query<R>(text, values);
        },
        end() {
          return session.end();
        },
      };
    };
    let db: pg.Pool | undefined;
    try {
      await compose("up", "-d", "--wait");
      db = new pg.Pool({
        connectionString: "postgres://postgres:spike@" +
          await compose("port", "postgres", "5432") + "/spike",
      });
      const endpoint = "http://" + await compose("port", "risingwave", "4566");
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
          CREATE VIEW labels AS SELECT label FROM source_rows;
          CREATE VIEW summary AS SELECT COUNT(*) AS n,SUM(amount) AS total FROM source_rows;`,
        inputs: { source_rows: { query: "", fields } },
        outputs: {
          detail: { view: "detail", fields },
          labels: {
            view: "labels",
            fields: [{ name: "label", type: "VARCHAR" }],
          },
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
            labels: {
              partitionQuery: "SELECT '' AS __partition,* FROM labels",
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
      const runtime = new NativeRisingWave(
        endpoint,
        "capture-test",
        program,
        version,
        "postgres://postgres:spike@postgres:5432/spike",
        trackedConnect,
      );
      await runtime.initialize(db, { detail: [], labels: [], summary: [] }, []);
      const store = new DeltaStore({
        detail: "__partition",
        labels: "__partition",
        summary: "__partition",
      });
      store.bootstrap({ detail: [], labels: [], summary: [] });
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
          "one SQL request must capture every output and validation relation",
        );
        store.apply(delta);
        const state = store.capture("");
        assertEquals(state.summary.length, 1);
        assertEquals(state.summary[0].n, state.detail.length);
        assertEquals(state.labels.length, state.detail.length);
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
        queries = [];
        captures = true;
        try {
          await runtime.capture();
        } catch (err) {
          if (err instanceof Error && err.message.includes("negative_amount")) {
            assertEquals(
              queries.length,
              1,
              "validation must share the captured output snapshot",
            );
            break;
          }
          throw err;
        } finally {
          captures = false;
        }
        assert(Date.now() < invalidDeadline, "invalid source row not observed");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await assertRejects(() => runtime.capture(), Error, "negative_amount");
      await runtime.close();
    } finally {
      if (db) await db.end();
      await compose("down", "-v");
      await Deno.remove(directory, { recursive: true });
    }
  },
});
