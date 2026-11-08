import { assertEquals, assertRejects } from "@std/assert";
import pg from "npm:pg@8.16.3";
import { PostgresJobCache } from "./job-cache.ts";
import { pgTest, postgres } from "./pg-test.ts";

const key = (n: number) => n.toString(16).padStart(64, "0");

pgTest(
  "job cache bounds recency, payload bytes and entries across restart without partial or conflicting answers",
  async () => {
    await using server = await postgres();
    const db = new pg.Pool({ connectionString: server.url });
    try {
      {
        await using cache = await PostgresJobCache.open(server.url, {
          maxEntries: 2,
          maxBytes: 1000,
        });
        await cache.put(key(1), '{"value":1}');
        await cache.put(key(2), '{"value":2}');
        await cache.get([key(1)]);
        await cache.put(key(3), '{"value":3}');
        assertEquals(
          await cache.get([key(1), key(2), key(3)]),
          new Map([
            [key(1), '{"value":1}'],
            [key(3), '{"value":3}'],
          ]),
        );
        await assertRejects(
          () => cache.put(key(1), '{"value":7}'),
          Error,
          "conflicting results",
        );
        await assertRejects(() => cache.put(key(4), "partial"), SyntaxError);
        await cache.put(key(5), JSON.stringify("x".repeat(1000)));
        assertEquals(await cache.get([key(4), key(5)]), new Map());
        assertEquals(
          (await db.query("SELECT entries,bytes FROM compute.job_cache_size"))
            .rows,
          [{ entries: "2", bytes: "278" }],
        );
      }
      {
        await using cache = await PostgresJobCache.open(server.url, {
          maxEntries: 10,
          maxBytes: 270,
        });
        assertEquals((await cache.get([key(1), key(3)])).size, 1);
        await cache.put(key(6), JSON.stringify("é"));
        const retained = await cache.get([key(1), key(3), key(6)]);
        assertEquals(retained, new Map([[key(6), '"é"']]));
        const { rows } = await db.query(
          `SELECT s.entries,s.bytes,count(r.*)::text AS actual_entries,
        coalesce(sum(r.bytes),0)::text AS actual_bytes FROM compute.job_cache_size s
        LEFT JOIN compute.job_result r ON true GROUP BY s.entries,s.bytes`,
        );
        assertEquals(rows, [{
          entries: "1",
          bytes: "132",
          actual_entries: "1",
          actual_bytes: "132",
        }]);
      }
      await assertRejects(
        () => PostgresJobCache.open(server.url, { maxBytes: 0 }),
        Error,
        "positive safe integer",
      );
    } finally {
      await db.end();
    }
  },
);
