import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { assert, assertEquals, assertRejects } from "@std/assert";
import pg from "npm:pg@8.16.3";
import { PostgresJobCache } from "./job-cache.ts";
import { pgTest, postgres } from "./pg-test.ts";

const key = (n: number) => n.toString(16).padStart(64, "0");
const storedBytes = (json: string) =>
  zstdCompressSync(Buffer.from(json, "utf8")).byteLength + 128;

pgTest(
  "job cache compresses payloads with Zstd, upgrades legacy text storage, and bounds recency, bytes and entries",
  async () => {
    await using server = await postgres();
    const db = new pg.Pool({ connectionString: server.url });
    try {
      await db.query(`
        CREATE SCHEMA compute;
        CREATE TABLE compute.job_result (
          key text PRIMARY KEY,
          result text NOT NULL,
          bytes bigint NOT NULL,
          accessed timestamptz NOT NULL DEFAULT clock_timestamp()
        );
        CREATE TABLE compute.job_cache_size (
          singleton boolean PRIMARY KEY DEFAULT true,
          entries bigint NOT NULL,
          bytes bigint NOT NULL
        );
        INSERT INTO compute.job_result(key, result, bytes) VALUES ('${key(99)}', '{"legacy":true}', 143);
        INSERT INTO compute.job_cache_size(entries, bytes) VALUES (1, 143);
      `);
      const v1 = '{"value":1}';
      const v2 = '{"value":2}';
      const v3 = '{"value":3}';
      const v6 = JSON.stringify("é");
      const repetitive = JSON.stringify("x".repeat(4000));
      assert(storedBytes(repetitive) < 300);
      const incompressible = JSON.stringify(randomBytes(1200).toString("base64"));
      assert(storedBytes(incompressible) > 1000);
      {
        await using cache = await PostgresJobCache.open(server.url, {
          maxEntries: 2,
          maxBytes: 1000,
        });
        assertEquals(await cache.get([key(99)]), new Map());
        await cache.put(key(1), v1);
        await cache.put(key(2), v2);
        await cache.get([key(1)]);
        await cache.put(key(3), v3);
        assertEquals(
          await cache.get([key(1), key(2), key(3)]),
          new Map([
            [key(1), v1],
            [key(3), v3],
          ]),
        );
        await assertRejects(
          () => cache.put(key(1), '{"value":7}'),
          Error,
          "conflicting results",
        );
        await assertRejects(() => cache.put(key(4), "partial"), SyntaxError);
        await cache.put(key(5), incompressible);
        assertEquals(await cache.get([key(4), key(5)]), new Map());
        assertEquals(
          (await db.query("SELECT entries,bytes FROM compute.job_cache_size"))
            .rows,
          [{
            entries: "2",
            bytes: String(storedBytes(v1) + storedBytes(v3)),
          }],
        );
      }
      {
        const singleBudget = storedBytes(v3) + storedBytes(v6) - 1;
        await using cache = await PostgresJobCache.open(server.url, {
          maxEntries: 10,
          maxBytes: singleBudget,
        });
        assertEquals((await cache.get([key(1), key(3)])).size, 1);
        await cache.put(key(6), v6);
        const retained = await cache.get([key(1), key(3), key(6)]);
        assertEquals(retained, new Map([[key(6), v6]]));
        const { rows } = await db.query(
          `SELECT s.entries,s.bytes,count(r.*)::text AS actual_entries,
        coalesce(sum(r.bytes),0)::text AS actual_bytes FROM compute.job_cache_size s
        LEFT JOIN compute.job_result r ON true GROUP BY s.entries,s.bytes`,
        );
        assertEquals(rows, [{
          entries: "1",
          bytes: String(storedBytes(v6)),
          actual_entries: "1",
          actual_bytes: String(storedBytes(v6)),
        }]);
      }
      {
        await using cache = await PostgresJobCache.open(server.url, {
          maxEntries: 10,
          maxBytes: 400,
        });
        await cache.put(key(7), repetitive);
        assertEquals(
          await cache.get([key(7)]),
          new Map([[key(7), repetitive]]),
        );
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
