import { assert, assertEquals, assertRejects } from "@std/assert";
import { Feldera, type FelderaProgram } from "./feldera.ts";
import type { Row } from "./main.ts";

const endpoint = Deno.env.get("FELDERA_TEST_URL");
Deno.test({
  name:
    "pinned Feldera preserves duplicate weights, updates, deletes, microseconds, and fences a real restart",
  ignore: !endpoint,
  async fn() {
    const name = "compute-adapter-integration";
    const path = `${endpoint}/v0/pipelines/${name}`;
    const program: FelderaProgram = {
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
    const f = new Feldera(endpoint!, name, program);
    const api = async (suffix: string, method = "GET") => {
      const response = await fetch(path + suffix, { method });
      if (!response.ok) {
        throw new Error(
          `${method} ${suffix}: ${response.status}: ${await response.text()}`,
        );
      }
      return await response.json();
    };
    const status = async (wanted: string) => {
      const deadline = Date.now() + 30000;
      do {
        const state = await api("");
        if (
          wanted === "Cleared"
            ? state.storage_status === wanted
            : state.deployment_status === wanted
        ) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      throw new Error(`pipeline failed to reach ${wanted}`);
    };
    try {
      assertEquals(await f.capture(reader), {
        result: [a, a],
        totals: [{ id: 1, n: 2, total: 3 }],
        corpus: [{ id: "the", n: 2 }],
      });
      const incarnation = (await api("/stats")).global_metrics.incarnation_uuid;
      source = [{ ...a, amount: 2.5 }];
      assertEquals(await f.capture(reader), {
        result: source,
        totals: [{ id: 1, n: 1, total: 2.5 }],
        corpus: [{ id: "the", n: 1 }],
      });
      assertEquals(
        (await api("/stats")).global_metrics.incarnation_uuid,
        incarnation,
      );
      assertEquals((await api("/stats")).global_metrics.total_input_records, 5);
      source = [];
      assertEquals(await f.capture(reader), {
        result: [],
        totals: [],
        corpus: [{ id: "the", n: 0 }],
      });
      await api("/stop?force=true", "POST");
      await status("Stopped");
      await api("/start", "POST");
      await status("Running");
      await assertRejects(() => f.capture(reader), Error, "restarted");
      await assertRejects(() => f.capture(reader), Error, "poisoned");
      source = [a];
      assertEquals(
        await new Feldera(endpoint!, name, program).capture(reader),
        {
          result: [a],
          totals: [{ id: 1, n: 1, total: 1.5 }],
          corpus: [{ id: "the", n: 1 }],
        },
      );
    } finally {
      await api("/stop?force=true", "POST");
      await status("Stopped");
      await api("/clear", "POST");
      await status("Cleared");
      const response = await fetch(path, { method: "DELETE" });
      assert(response.ok, `cleanup: ${response.status}`);
      await response.text();
    }
  },
});
