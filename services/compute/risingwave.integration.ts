import { assertEquals } from "@std/assert";
import { RisingWave, type RisingWaveProgram } from "./risingwave.ts";
import type { Row } from "./main.ts";

const endpoint = Deno.env.get("RISINGWAVE_TEST_URL") ??
  Deno.env.get("RISINGWAVE_URL");

Deno.test({
  name:
    "pinned RisingWave preserves duplicate weights, updates, deletes, and microseconds",
  ignore: !endpoint,
  async fn() {
    const name = "compute-adapter-integration";
    const program: RisingWaveProgram = {
      sql: `CREATE TABLE source (id BIGINT, stamp TIMESTAMP, amount DOUBLE);
        CREATE MATERIALIZED VIEW result AS SELECT * FROM source;
        CREATE MATERIALIZED VIEW totals AS SELECT id, COUNT(*) AS n, SUM(amount) AS total FROM source GROUP BY id;
        CREATE MATERIALIZED VIEW corpus AS SELECT CAST('the' AS VARCHAR(3)) AS id, COUNT(*) AS n FROM source;`,
      inputs: {
        source: {
          query: "frozen snapshot",
          fields: [{ name: "id", type: "BIGINT" }, {
            name: "stamp",
            type: "TIMESTAMP",
          }, { name: "amount", type: "DOUBLE" }],
        },
      },
      outputs: {
        corpus: {
          view: "corpus",
          fields: [{ name: "id", type: "VARCHAR" }, {
            name: "n",
            type: "BIGINT",
          }],
        },
        result: {
          view: "result",
          fields: [{ name: "id", type: "BIGINT" }, {
            name: "stamp",
            type: "TIMESTAMP",
          }, { name: "amount", type: "DOUBLE" }],
        },
        totals: {
          view: "totals",
          fields: [{ name: "id", type: "BIGINT" }, {
            name: "n",
            type: "BIGINT",
          }, { name: "total", type: "DOUBLE" }],
        },
      },
    };
    const a = { id: 1, stamp: "2026-10-23T03:10:02.123456Z", amount: 1.5 };
    let source: Row[] = [a, a];
    const reader = { query: () => Promise.resolve(source) };
    const rw = new RisingWave(endpoint!, name, program);
    try {
      assertEquals(await rw.capture(reader), {
        result: [a, a],
        totals: [{ id: 1, n: 2, total: 3 }],
        corpus: [{ id: "the", n: 2 }],
      });
      source = [{ ...a, amount: 2.5 }];
      assertEquals(await rw.capture(reader), {
        result: source,
        totals: [{ id: 1, n: 1, total: 2.5 }],
        corpus: [{ id: "the", n: 1 }],
      });
      source = [];
      assertEquals(await rw.capture(reader), {
        result: [],
        totals: [],
        corpus: [{ id: "the", n: 0 }],
      });
    } finally {
      await rw.close();
    }
  },
});
