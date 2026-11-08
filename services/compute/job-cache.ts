import pg from "npm:pg@8.16.3";
import type { JobCache } from "./workers.ts";

/** Disposable pure-function answers; Durex retains the invocation and publication receipt. */
export class PostgresJobCache implements JobCache {
  private constructor(
    private db: pg.Pool,
    private maxEntries: number,
    private maxBytes: number,
  ) {}

  static async open(
    connectionString: string,
    options: { maxEntries?: number; maxBytes?: number } = {},
  ): Promise<PostgresJobCache> {
    const maxEntries = options.maxEntries ?? 100_000;
    const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    for (const [name, limit] of Object.entries({ maxEntries, maxBytes })) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error(`${name} must be a positive safe integer`);
      }
    }
    const db = new pg.Pool({ connectionString, max: 1 });
    try {
      await db.query(
        await Deno.readTextFile(new URL("./job-cache.sql", import.meta.url)),
      );
      const cache = new PostgresJobCache(db, maxEntries, maxBytes);
      await cache.write(async () => {});
      return cache;
    } catch (error) {
      await db.end();
      throw error;
    }
  }

  async get(keys: string[]): Promise<Map<string, string>> {
    if (keys.length === 0) return new Map();
    const { rows } = await this.db.query<{ key: string; result: string }>(
      `UPDATE compute.job_result SET accessed=clock_timestamp()
       WHERE key=ANY($1::text[]) RETURNING key,result`,
      [keys],
    );
    return new Map(rows.map(({ key, result }) => [key, result]));
  }

  async put(key: string, result: string): Promise<void> {
    JSON.parse(result);
    const bytes = new TextEncoder().encode(result).byteLength + 128;
    if (bytes > this.maxBytes) return;
    await this.write(async (client) => {
      const { rows: [existing] } = await client.query(
        "SELECT result FROM compute.job_result WHERE key=$1",
        [key],
      );
      if (existing) {
        if (existing.result !== result) {
          throw new Error(`pure WASM job produced conflicting results: ${key}`);
        }
        return;
      }
      await client.query(
        "INSERT INTO compute.job_result(key,result,bytes) VALUES ($1,$2,$3)",
        [key, result, bytes],
      );
      await client.query(
        "UPDATE compute.job_cache_size SET entries=entries+1,bytes=bytes+$1",
        [bytes],
      );
    });
  }

  private async write(
    body: (client: pg.PoolClient) => Promise<void>,
  ): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query(
          "SELECT singleton FROM compute.job_cache_size FOR UPDATE",
        );
        await body(client);
        const { rows: [size] } = await client.query(
          "SELECT entries,bytes FROM compute.job_cache_size",
        );
        let entries = Number(size.entries), bytes = Number(size.bytes);
        while (entries > this.maxEntries || bytes > this.maxBytes) {
          const { rows: [removed] } = await client.query(
            `DELETE FROM compute.job_result WHERE key=(
               SELECT key FROM compute.job_result ORDER BY accessed,key LIMIT 1
             ) RETURNING bytes`,
          );
          if (!removed) {
            throw new Error(
              "WASM cache size disagrees with its retained results",
            );
          }
          entries--;
          bytes -= Number(removed.bytes);
        }
        await client.query(
          "UPDATE compute.job_cache_size SET entries=$1,bytes=$2",
          [entries, bytes],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.db.end();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
