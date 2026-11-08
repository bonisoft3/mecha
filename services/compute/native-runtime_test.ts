import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import pg from "npm:pg@8.16.3";
import { type Batches, openBatches } from "./batches.ts";
import type { DeltaStep } from "./deltas.ts";
import { NativeRuntime } from "./native-runtime.ts";
import { type IncrementalProgram, sourceSchema } from "./native-sources.ts";
import { pgTest, postgres } from "./pg-machine-test.ts";

type Row = Record<string, unknown>;
const rowKey = (row: Row) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
const version = "a".repeat(64);
const program: IncrementalProgram = {
  sql:
    "CREATE TABLE source_item(id VARCHAR, bucket VARCHAR, amount INTEGER); CREATE MATERIALIZED VIEW result_totals AS SELECT bucket,SUM(amount) AS amount FROM source_item GROUP BY bucket;",
  inputs: {
    source_item: {
      query: "SELECT * FROM item",
      fields: [{ name: "id", type: "VARCHAR" }, {
        name: "bucket",
        type: "VARCHAR",
      }, { name: "amount", type: "INTEGER" }],
    },
  },
  outputs: {
    totals: {
      view: "result_totals",
      fields: [{ name: "bucket", type: "VARCHAR" }, {
        name: "amount",
        type: "BIGINT",
      }],
    },
  },
  incremental: {
    inputs: { source_item: { table: "item", projection: "id,bucket,amount" } },
    outputs: {
      totals: {
        partitionQuery: "SELECT bucket AS __partition,* FROM result_totals",
      },
    },
  },
};

Deno.test("native CDC rejects publication cycles independently of coordinator invalidation", () => {
  const runtime = (name: string, source: string, sink: string) =>
    new NativeRuntime(
      {} as pg.Pool,
      "http://unused.invalid",
      { name, to: [sink], calculate: () => Promise.resolve({}) },
      {
        ...program,
        incremental: {
          ...program.incremental,
          inputs: {
            source_item: { table: source, projection: "id,bucket,amount" },
          },
        },
      },
      version,
      "postgresql://unused.invalid/database",
      {},
    );
  const self = runtime("self", "item", "item");
  assertThrows(
    () => NativeRuntime.validateGraph([self]),
    Error,
    "computation cycle: self -> self",
  );
  const first = runtime("first", "second_sink", "first_sink");
  const second = runtime("second", "first_sink", "second_sink");
  assertThrows(
    () => NativeRuntime.validateGraph([first, second]),
    Error,
    "computation cycle: first -> second -> first",
  );
  const ratings = runtime("ratings", "game", "team_rating");
  const chances = runtime("chances", "team_rating", "team_chance");
  NativeRuntime.validateGraph([chances, ratings]);
  NativeRuntime.validateGraph([]);
  assertEquals([
    ratings.spec.reads,
    ratings.spec.to,
    chances.spec.reads,
    chances.spec.to,
  ], [[], [], [], []]);
});

async function until(ready: () => Promise<boolean>) {
  for (let n = 0; n < 1000; n++) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("native runtime did not settle");
}
const ids = {
  a: "abcdefab-1234-5678-9000-000000000001",
  b: "abcdefab-1234-5678-9000-000000000002",
};
async function fixture(uuid = false) {
  const server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  try {
    await db.query(`CREATE ROLE service NOLOGIN;
    CREATE OR REPLACE FUNCTION public.app_pre_request() RETURNS void LANGUAGE plpgsql AS $$BEGIN END$$;
    CREATE TABLE item(id text PRIMARY KEY,bucket text NOT NULL,amount int NOT NULL);
    INSERT INTO item VALUES ('a1','a',2),('a2','a',3),('b1','b',7);
    CREATE TABLE sink(id ${
      uuid ? "uuid" : "text"
    } PRIMARY KEY,amount bigint NOT NULL);
    INSERT INTO sink VALUES ('${
      uuid ? "abcdefab-1234-5678-9000-000000000003" : "obsolete"
    }',99);
    GRANT ALL ON sink TO service;`);
  } catch (error) {
    await db.end();
    await server[Symbol.asyncDispose]();
    throw error;
  }
  let batches: Batches | undefined;
  let runtime: NativeRuntime;
  let baseline: Row[] = [];
  let acknowledged = new Set<string>();
  const baselines: Row[][] = [];
  const calculated: string[] = [];
  let failCalculation = false;
  let failAck = false;
  let overlap = false;
  let noise = false;
  let activeVersion = version;
  const totals = async () =>
    (await db.query(
      `SELECT bucket AS __partition,bucket,SUM(amount)::int AS amount FROM ${
        sourceSchema(activeVersion)
      }.source_item GROUP BY bucket ORDER BY bucket`,
    )).rows as Row[];
  const difference = async (): Promise<DeltaStep> => {
    const current = await totals();
    const old = new Map(baseline.map((row) => [rowKey(row), row]));
    const next = new Map(current.map((row) => [rowKey(row), row]));
    return {
      totals: [
        ...[...old].filter(([key]) => !next.has(key)).map(([, row]) => ({
          row,
          weight: -1,
        })),
        ...[...next].filter(([key]) => !old.has(key)).map(([, row]) => ({
          row,
          weight: 1,
        })),
      ],
    };
  };
  async function start(
    nextVersion = version,
    write: "replace" | "upsert" = "replace",
  ) {
    activeVersion = nextVersion;
    runtime = new NativeRuntime(
      db,
      "http://unused.invalid",
      {
        name: "totals",
        to: ["sink"],
        sinkWrites: { sink: write },
        calculate: (value) => {
          const { totals } = value as { totals: Row[] };
          calculated.push(totals.map((row) => String(row.bucket)).join(","));
          if (failCalculation) {
            throw new Error(
              "calculation interrupted after durable capture",
            );
          }
          return Promise.resolve({
            sink: totals.map((row) => ({
              id: uuid
                ? (overlap
                  ? ids.a.replaceAll("-", "").toUpperCase()
                  : ids[row.bucket as keyof typeof ids])
                : overlap
                ? "a"
                : row.bucket,
              amount: row.amount,
            })),
          });
        },
      },
      program,
      activeVersion,
      server.url,
      { role: "service" },
    );
    runtime.engine.check = () => Promise.resolve();
    runtime.engine.initialize = (_db, initial, ids) => {
      baseline = structuredClone(initial.totals);
      baselines.push(structuredClone(baseline));
      acknowledged = new Set(ids);
      return Promise.resolve();
    };
    runtime.engine.pending = async () => (await difference()).totals.length > 0;
    runtime.engine.capture = async () => {
      const delta = await difference();
      if (noise && baseline.length) {
        delta.totals = [...delta.totals, { row: baseline[0], weight: -1 }, {
          row: baseline[0],
          weight: 1,
        }];
      }
      return delta;
    };
    runtime.engine.acknowledge = (id, delta) => {
      if (!acknowledged.has(id)) {
        const rows = new Map(baseline.map((row) => [rowKey(row), row]));
        for (const { row, weight } of delta.totals) {
          if (weight < 0) rows.delete(rowKey(row));
          else rows.set(rowKey(row), row);
        }
        baseline = [...rows.values()];
        acknowledged.add(id);
      }
      if (failAck) return Promise.reject(new Error("ambiguous acknowledgment"));
      return Promise.resolve();
    };
    batches = await openBatches(server.url, [runtime.spec], {
      coalesceMs: 0,
      pollInterval: 20,
    });
    await runtime.initialize();
  }
  async function poll() {
    if (await runtime.pending()) await batches!.invalidateNames(["totals"]);
    await until(async () =>
      (await db.query("SELECT requested=completed AS done FROM compute.batch"))
        .rows[0].done
    );
  }
  return {
    db,
    calculated,
    baselines,
    start,
    poll,
    runtime: () => runtime,
    fail: (value: boolean) => failCalculation = value,
    failAck: (value: boolean) => failAck = value,
    overlap: (value: boolean) => overlap = value,
    noise: (value: boolean) => noise = value,
    invalidate: () => batches!.invalidateNames(["totals"]),
    async failed() {
      await until(async () =>
        (await db.query(
          "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE attempts>0 AND locked_at IS NULL",
        )).rows[0].n === 1
      );
    },
    async stop() {
      await batches!.close();
      batches = undefined;
    },
    async [Symbol.asyncDispose]() {
      if (batches) await batches.close();
      await db.end();
      await server[Symbol.asyncDispose]();
    },
  };
}

pgTest(
  "native partitions bootstrap, update, delete and restart without unrelated recomputation",
  async () => {
    await using f = await fixture();
    await f.start();
    await f.poll();
    assertEquals(f.calculated, ["a", "b"]);
    assertEquals(
      (await f.db.query("SELECT id,amount::int FROM sink ORDER BY id")).rows,
      [{ id: "a", amount: 5 }, { id: "b", amount: 7 }],
    );
    const b =
      (await f.db.query("SELECT xmin::text AS tx FROM sink WHERE id='b'"))
        .rows[0].tx;
    await f.db.query("UPDATE item SET amount=4 WHERE id='a1'");
    await f.poll();
    assertEquals(f.calculated, ["a", "b", "a"]);
    assertEquals(
      (await f.db.query("SELECT xmin::text AS tx FROM sink WHERE id='b'"))
        .rows[0].tx,
      b,
    );
    await f.db.query("DELETE FROM item WHERE bucket='a'");
    await f.poll();
    assertEquals(f.calculated, ["a", "b", "a", ""]);
    assertEquals((await f.db.query("SELECT id,amount::int FROM sink")).rows, [{
      id: "b",
      amount: 7,
    }]);
    assertEquals(
      (await f.db.query("SELECT id,partition FROM compute.stream_owner")).rows,
      [{ id: "b", partition: "b" }],
    );
    await f.stop();
    await f.start();
    assertEquals(f.baselines.at(-1), [{
      __partition: "b",
      bucket: "b",
      amount: 7,
    }]);
    await f.poll();
    assertEquals(f.calculated, ["a", "b", "a", ""]);
  },
);

pgTest(
  "native upsert to replacement retracts unowned history across a captured upgrade restart",
  async () => {
    await using f = await fixture();
    await f.start(version, "upsert");
    await f.poll();
    await f.db.query("DELETE FROM item WHERE bucket='a'");
    await f.poll();
    assertEquals(
      (await f.db.query("SELECT id FROM sink ORDER BY id")).rows,
      [{ id: "a" }, { id: "b" }, { id: "obsolete" }],
    );
    await f.stop();
    const upgraded = "b".repeat(64);
    f.fail(true);
    await f.start(upgraded);
    await f.invalidate();
    await f.failed();
    await f.stop();
    f.fail(false);
    await f.db.query("UPDATE graphile_worker._private_jobs SET run_at=now()");
    await f.start(upgraded);
    await f.poll();
    assertEquals(
      (await f.db.query("SELECT id,amount::int FROM sink ORDER BY id")).rows,
      [{ id: "b", amount: 7 }],
    );
    const calculations = f.calculated.length;
    await f.stop();
    await f.start(upgraded);
    await f.poll();
    assertEquals(f.calculated.length, calculations);
    assertEquals(
      (await f.db.query("SELECT id FROM sink ORDER BY id")).rows,
      [{ id: "b" }],
    );
  },
);

pgTest(
  "native retained capture survives restart and then processes newer source state",
  async () => {
    await using f = await fixture();
    await f.start();
    await f.poll();
    f.fail(true);
    await f.db.query("UPDATE item SET amount=4 WHERE id='a1'");
    await f.invalidate();
    await f.failed();
    assertEquals(
      (await f.db.query("SELECT amount::int FROM sink WHERE id='a'")).rows,
      [{ amount: 5 }],
    );
    await f.stop();
    f.fail(false);
    await f.db.query(
      "UPDATE item SET amount=8 WHERE id='a1'; UPDATE graphile_worker._private_jobs SET run_at=now()",
    );
    await f.start();
    assertEquals(
      f.baselines.at(-1)!.find((row) => row.bucket === "a")!.amount,
      7,
    );
    await until(async () =>
      (await f.db.query(
        "SELECT requested=completed AS done FROM compute.batch",
      )).rows[0].done
    );
    assertEquals(
      (await f.db.query("SELECT amount::int FROM sink WHERE id='a'")).rows,
      [{ amount: 7 }],
    );
    await f.poll();
    assertEquals(
      (await f.db.query("SELECT amount::int FROM sink WHERE id='a'")).rows,
      [{ amount: 11 }],
    );
    assertEquals(f.calculated, ["a", "b", "a", "a", "a"]);
  },
);

pgTest(
  "native partition ownership rejects cross-partition replacement atomically",
  async () => {
    await using f = await fixture();
    await f.start();
    await f.poll();
    const before = (await f.db.query(
      "SELECT key,outputs FROM compute.stream_partition ORDER BY key",
    )).rows;
    f.overlap(true);
    await f.db.query("UPDATE item SET amount=9 WHERE id='b1'");
    await f.invalidate();
    await f.failed();
    assertEquals(
      (await f.db.query("SELECT id,amount::int FROM sink ORDER BY id")).rows,
      [{ id: "a", amount: 5 }, { id: "b", amount: 7 }],
    );
    assertEquals(
      (await f.db.query(
        "SELECT key,outputs FROM compute.stream_partition ORDER BY key",
      )).rows,
      before,
    );
    assertEquals(
      (await f.db.query(
        "SELECT id,partition FROM compute.stream_owner ORDER BY id",
      )).rows,
      [{ id: "a", partition: "a" }, { id: "b", partition: "b" }],
    );
    assertEquals(
      (await f.db.query("SELECT completed,claimed FROM compute.batch")).rows,
      [{ completed: "1", claimed: "2" }],
    );
  },
);

pgTest(
  "a consolidated no-op delta cannot recalculate a native partition",
  async () => {
    await using f = await fixture();
    await f.start();
    await f.poll();
    f.noise(true);
    await f.invalidate();
    await f.poll();
    assertEquals(f.calculated, ["a", "b"]);
  },
);

pgTest(
  "native ownership canonicalizes UUID aliases across sequential partition publications",
  async () => {
    await using f = await fixture(true);
    await f.start();
    await f.poll();
    f.overlap(true);
    await f.db.query("UPDATE item SET amount=9 WHERE id='b1'");
    await f.invalidate();
    await f.failed();
    assertEquals(
      (await f.db.query("SELECT id::text,amount::int FROM sink ORDER BY id"))
        .rows,
      [{ id: ids.a, amount: 5 }, { id: ids.b, amount: 7 }],
    );
    assertEquals(
      (await f.db.query(
        "SELECT id,partition FROM compute.stream_owner ORDER BY id",
      )).rows,
      [{ id: ids.a, partition: "a" }, { id: ids.b, partition: "b" }],
    );
  },
);

pgTest(
  "ambiguous native acknowledgment fails polling and resumes the durable claim after reconstruction",
  async () => {
    await using f = await fixture();
    await f.start();
    f.failAck(true);
    await f.invalidate();
    await f.failed();
    await assertRejects(
      () => f.runtime().pending(),
      Error,
      "ambiguous acknowledgment",
    );
    assertEquals(f.calculated, []);
    assertEquals(
      (await f.db.query(
        "SELECT count(*)::int AS n FROM compute.stream_partition",
      )).rows,
      [{ n: 2 }],
    );
    assertEquals(
      (await f.db.query("SELECT completed,claimed FROM compute.batch")).rows,
      [{ completed: "0", claimed: "1" }],
    );
    await f.stop();
    f.failAck(false);
    await f.db.query("UPDATE graphile_worker._private_jobs SET run_at=now()");
    await f.start();
    await until(async () =>
      (await f.db.query(
        "SELECT requested=completed AS done FROM compute.batch",
      )).rows[0].done
    );
    assertEquals(f.calculated, ["a", "b"]);
    assertEquals(
      (await f.db.query("SELECT id,amount::int FROM sink ORDER BY id")).rows,
      [{ id: "a", amount: 5 }, { id: "b", amount: 7 }],
    );
  },
);

pgTest(
  "foreign-key supersession retains every unpublished partition despite unrelated successor deltas",
  async () => {
    await using f = await fixture();
    await f.start();
    await f.poll();
    await f.db.query(
      `CREATE TABLE bucket(id text PRIMARY KEY); INSERT INTO bucket VALUES ('a'),('b');
    ALTER TABLE sink ADD FOREIGN KEY(id) REFERENCES bucket(id) ON DELETE CASCADE`,
    );
    const began = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calculate = f.runtime().spec.calculate;
    f.runtime().spec.calculate = async (value) => {
      began.resolve();
      await release.promise;
      return await calculate(value);
    };
    try {
      await f.db.query(
        "UPDATE item SET amount=4 WHERE id='a1'; UPDATE item SET amount=9 WHERE id='b1'",
      );
      await f.invalidate();
      await began.promise;
      await f.db.query(
        "DELETE FROM item WHERE bucket='a'; DELETE FROM bucket WHERE id='a'",
      );
      await f.invalidate();
      release.resolve();
      await until(async () =>
        (await f.db.query(
          "SELECT requested=completed AS done FROM compute.batch",
        )).rows[0].done
      );
      assertEquals(f.calculated, ["a", "b", "a", "b", "", "b"]);
      assertEquals((await f.db.query("SELECT id,amount::int FROM sink")).rows, [
        { id: "b", amount: 9 },
      ]);
      assertEquals(
        (await f.db.query("SELECT id,partition FROM compute.stream_owner"))
          .rows,
        [{ id: "b", partition: "b" }],
      );
      assertEquals(
        (await f.db.query(
          "SELECT last_superseded->>'reason' AS reason FROM compute.batch",
        )).rows,
        [{ reason: "foreign_key_violation" }],
      );
    } finally {
      release.resolve();
    }
  },
);

pgTest(
  "cascade deletion and identical source reinsertion repair sinks without relational deltas",
  async () => {
    await using f = await fixture();
    await f.start();
    await f.poll();
    await assertRejects(
      () => f.db.query("UPDATE sink SET id='orphan' WHERE id='a'"),
      Error,
      "derived sink identities are immutable",
    );
    await f.db.query("INSERT INTO sink VALUES ('manual',999)");
    assertEquals(await f.runtime().pending(), false);
    await f.db.query("DELETE FROM sink WHERE id='manual'");
    assertEquals(await f.runtime().pending(), false);
    await f.db.query(
      `CREATE TABLE bucket(id text PRIMARY KEY); INSERT INTO bucket VALUES ('a'),('b');
    ALTER TABLE item ADD FOREIGN KEY(bucket) REFERENCES bucket(id) ON DELETE CASCADE;
    ALTER TABLE sink ADD FOREIGN KEY(id) REFERENCES bucket(id) ON DELETE CASCADE`,
    );
    const before =
      (await f.db.query("SELECT xmin::text AS tx FROM sink WHERE id='b'"))
        .rows[0].tx;
    const replace = () =>
      f.db.query(`BEGIN;
    DELETE FROM bucket WHERE id='a'; INSERT INTO bucket VALUES ('a');
    INSERT INTO item VALUES ('a1','a',2),('a2','a',3); COMMIT`);
    await replace();
    assertEquals(await f.runtime().engine.pending(), false);
    assertEquals(await f.runtime().pending(), true);
    assertEquals((await f.db.query("SELECT id FROM sink")).rows, [{ id: "b" }]);
    await f.poll();
    assertEquals(f.calculated, ["a", "b", "a"]);
    assertEquals(
      (await f.db.query("SELECT id,amount::int FROM sink ORDER BY id")).rows,
      [{ id: "a", amount: 5 }, { id: "b", amount: 7 }],
    );
    assertEquals(
      (await f.db.query("SELECT xmin::text AS tx FROM sink WHERE id='b'"))
        .rows[0].tx,
      before,
    );
    assertEquals(await f.runtime().pending(), false);
    await replace();
    await f.stop();
    await f.start();
    await f.poll();
    assertEquals(f.calculated, ["a", "b", "a", "a"]);
    assertEquals(
      (await f.db.query("SELECT id,amount::int FROM sink ORDER BY id")).rows,
      [{ id: "a", amount: 5 }, { id: "b", amount: 7 }],
    );
    assertEquals(await f.runtime().pending(), false);
  },
);

pgTest(
  "source and sink edits during calculation retain repairs outside the active partition",
  async () => {
    await using f = await fixture();
    await f.start();
    await f.poll();
    const began = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calculate = f.runtime().spec.calculate;
    f.runtime().spec.calculate = async (value) => {
      began.resolve();
      await release.promise;
      return await calculate(value);
    };
    try {
      await f.db.query("UPDATE item SET amount=9 WHERE id='b1'");
      await f.invalidate();
      await began.promise;
      await f.db.query(
        "DELETE FROM sink WHERE id='a'; UPDATE sink SET amount=999 WHERE id='b'; UPDATE item SET amount=11 WHERE id='b1'",
      );
      release.resolve();
      await until(async () =>
        (await f.db.query(
          "SELECT requested=completed AS done FROM compute.batch",
        )).rows[0].done
      );
      assertEquals((await f.db.query("SELECT id,amount::int FROM sink")).rows, [
        { id: "b", amount: 9 },
      ]);
      assertEquals(
        (await f.db.query(
          "SELECT key FROM compute.stream_partition WHERE dirty",
        )).rows,
        [{ key: "a" }],
      );
      await f.poll();
      assertEquals(f.calculated, ["a", "b", "b", "a", "b"]);
      assertEquals(
        (await f.db.query("SELECT id,amount::int FROM sink ORDER BY id")).rows,
        [{ id: "a", amount: 5 }, { id: "b", amount: 11 }],
      );
      assertEquals(await f.runtime().pending(), false);
    } finally {
      release.resolve();
    }
  },
);

pgTest(
  "openBatches native bootstrap includes source commits while installation waits for its fence",
  async () => {
    await using f = await fixture();
    const writer = await f.db.connect();
    await writer.query("BEGIN");
    await writer.query(
      "UPDATE item SET amount=11 WHERE id='a1'; DELETE FROM item WHERE id='a2'; INSERT INTO item VALUES ('c1','c',13)",
    );
    const starting = f.start();
    try {
      await until(async () =>
        (await f.db.query(
          `SELECT EXISTS(SELECT FROM pg_locks WHERE relation='public.item'::regclass
          AND mode='ShareRowExclusiveLock' AND NOT granted) AS blocked`,
        )).rows[0].blocked
      );
      // Bootstrap has already read the coordinator before reaching the source fence.
      await writer.query("COMMIT");
      await starting;
      assertEquals(
        (await f.db.query(
          `SELECT id,bucket,amount FROM ${
            sourceSchema(version)
          }.source_item ORDER BY id`,
        )).rows,
        [
          { id: "a1", bucket: "a", amount: 11 },
          { id: "b1", bucket: "b", amount: 7 },
          { id: "c1", bucket: "c", amount: 13 },
        ],
      );
      await f.poll();
      assertEquals(
        (await f.db.query("SELECT id,amount::int FROM sink ORDER BY id")).rows,
        [
          { id: "a", amount: 11 },
          { id: "b", amount: 7 },
          { id: "c", amount: 13 },
        ],
      );
      await f.db.query("UPDATE item SET amount=17 WHERE id='c1'");
      await f.poll();
      assertEquals(
        (await f.db.query("SELECT amount::int FROM sink WHERE id='c'")).rows,
        [{ amount: 17 }],
      );
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await starting;
    }
  },
);
