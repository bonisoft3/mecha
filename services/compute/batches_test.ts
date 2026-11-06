import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import pg from "pg";
import { type BatchSpec, computationGraph, openBatches } from "./batches.ts";
import { pgTest, postgres } from "./pg-machine-test.ts";
import { publish } from "./publication.ts";

const options = { coalesceMs: 30, pollInterval: 20 };

Deno.test("computation graph preserves producer-first order and rejects duplicate names", () => {
  const specs = [
    { name: "chances", reads: ["team_rating"], to: ["team_chance"] },
    { name: "ratings", reads: ["game"], to: ["team_rating"] },
  ];
  const { parents, ordered } = computationGraph(specs);
  assertEquals([...ordered], ["ratings", "chances"]);
  assertEquals([...parents], [["chances", ["ratings"]], ["ratings", []]]);
  assertThrows(
    () => computationGraph([specs[0], specs[0]]),
    Error,
    "duplicate computation name",
  );
});

async function until(ready: () => Promise<boolean>) {
  for (let i = 0; i < 1000; i++) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("compute did not reach the expected state");
}
const spec = (overrides: Partial<BatchSpec>): BatchSpec => ({
  name: "ratings",
  reads: ["games"],
  to: ["ratings"],
  version: "v1",
  capture: () => Promise.resolve(1),
  calculate: (inputs) => Promise.resolve(inputs),
  publish: () => Promise.resolve(),
  ...overrides,
});

pgTest("a burst coalesces; edits during a claim become one successor", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  const began = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let input = 1;
  let captures = 0;
  const published: unknown[] = [];
  const batches = await openBatches(server.url, [spec({
    capture: () => {
      captures++;
      return Promise.resolve(input);
    },
    calculate: async (value) => {
      if (value === 1) {
        began.resolve();
        await release.promise;
      }
      return value;
    },
    publish: (_client, value) => {
      published.push(value);
      return Promise.resolve();
    },
  })], { ...options, coalesceMs: 3600000 });
  try {
    await batches.invalidate(["games"]);
    const firstDeadline = (await db.query("SELECT run_at::text FROM graphile_worker.jobs")).rows[0].run_at;
    await Promise.all(Array.from({ length: 11 }, () => batches.invalidate(["games"])));
    assertEquals((await db.query("SELECT run_at::text FROM graphile_worker.jobs")).rows[0].run_at, firstDeadline);
    // Release only after the entire burst commits, independently of database speed.
    await db.query("UPDATE graphile_worker._private_jobs SET run_at=now()");
    await began.promise;
    const { rows: [machine] } = await db.query(`SELECT i.id, i.state->>'phase' AS phase, i.state->>'claimed' AS claimed,
      c.relkind FROM hybrid_compute_batch.instance i CROSS JOIN pg_class c WHERE c.oid='compute.batch'::regclass`);
    assertEquals(machine.relkind, "v");
    assertEquals(machine.phase, "active");
    assertEquals(machine.claimed, "12");
    const receipts = (await db.query("SELECT count(*)::int AS n FROM hybrid_compute_batch.receipt")).rows[0].n;
    const client = await db.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await assertRejects(
        () => client.query('SELECT hybrid_compute_batch.deliver($1, \'{"kind":"complete","payload":{}}\'::jsonb)', [machine.id]),
        Error,
        "requires its recorded outcome",
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    assertEquals((await db.query("SELECT count(*)::int AS n FROM hybrid_compute_batch.receipt")).rows[0].n, receipts);
    assertEquals((await db.query("SELECT outcome FROM durex.work")).rows, [{ outcome: null }]);
    input = 2;
    await batches.invalidate(["games"]);
    input = 3;
    await Promise.all(Array.from({ length: 12 }, () => batches.invalidate(["games"])));
    assertEquals(published, []);
    release.resolve();
    await until(async () => (await db.query("SELECT completed FROM compute.batch")).rows[0].completed === "12");
    await db.query("UPDATE graphile_worker._private_jobs SET run_at=now()");
    await until(async () => (await db.query("SELECT requested = completed AS done FROM compute.batch")).rows[0].done);
    assertEquals(published, [1, 3]);
    assertEquals(captures, 2);
    const { rows: [state] } = await db.query("SELECT requested, completed, claimed, inputs FROM compute.batch");
    assertEquals(state, { requested: "25", completed: "25", claimed: null, inputs: null });
    await batches.invalidate(["unrelated"]);
    assertEquals((await db.query("SELECT requested FROM compute.batch")).rows[0].requested, "25");
  } finally {
    release.resolve();
    await batches.close();
    await db.end();
  }
});

pgTest("redelivery after publication cannot republish a removed computation", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  let publications = 0;
  let batches = await openBatches(server.url, [spec({
    publish: () => {
      publications++;
      return Promise.resolve();
    },
  })], options);
  try {
    await batches.invalidate();
    await until(async () => (await db.query("SELECT requested = completed AS done FROM compute.batch")).rows[0].done);
    await batches.close();
    await db.query(`SELECT graphile_worker.add_job('compute_batch', '{"key":"compute:ratings:1"}'::json, job_key => 'internal:compute:ratings:1')`);
    await db.query("UPDATE graphile_worker._private_jobs SET attempts = max_attempts, locked_by = 'committed-before-ack', locked_at = now()");
    await db.query("INSERT INTO durex.pool VALUES ('committed-before-ack', 'compute')");
    batches = await openBatches(server.url, [], options);
    await until(async () => (await db.query("SELECT count(*)::int AS n FROM graphile_worker.jobs")).rows[0].n === 0);
    assertEquals(publications, 1);
  } finally {
    await batches.close();
    await db.end();
  }
});

pgTest("publication rollback retains the frozen claim through retry and restart", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  await db.query("CREATE TABLE output (value int NOT NULL)");
  let input = 1;
  let captures = 0;
  let fail = true;
  const calculated: unknown[] = [];
  const definition = spec({
    capture: () => {
      captures++;
      return Promise.resolve(input);
    },
    calculate: (value) => {
      calculated.push(value);
      return Promise.resolve(value);
    },
    publish: async (client, value) => {
      await client.query("INSERT INTO output VALUES ($1)", [value]);
      if (fail) throw new Error("publication refused after writing");
    },
  });
  let batches = await openBatches(server.url, [definition], options);
  try {
    await assertRejects(() => openBatches(server.url, [definition], options), Error, "singleton lock");
    await batches.invalidate();
    await until(async () => (await db.query("SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE attempts = 1 AND locked_at IS NULL")).rows[0].n === 1);
    assertEquals((await db.query("SELECT * FROM output")).rows, []);
    assertEquals((await db.query("SELECT completed, claimed, inputs FROM compute.batch")).rows[0], { completed: "0", claimed: "1", inputs: 1 });
    assertEquals((await db.query("SELECT outcome FROM durex.work")).rows, [{ outcome: null }]);
    assertEquals((await db.query("SELECT count(*)::int AS n FROM hybrid_compute_batch.receipt WHERE request->'event'->>'kind'='complete'")).rows[0].n, 0);
    await batches.close();
    input = 99;
    await assertRejects(() => openBatches(server.url, [{ ...definition, version: "v2" }], options), Error, "incompatible program");
    fail = false;
    // The restarted process can free only the pool IDs its predecessor recorded.
    await db.query("INSERT INTO durex.pool VALUES ('dead-compute', 'compute')");
    await db.query("UPDATE graphile_worker._private_jobs SET locked_by = 'dead-compute', locked_at = now(), run_at = now()");
    await db.query("SELECT graphile_worker.add_job('external_effect', '{}'::json, job_key => 'airlock:test')");
    await db.query("UPDATE graphile_worker._private_jobs SET locked_by = 'live-airlock', locked_at = now() WHERE key = 'airlock:test'");
    batches = await openBatches(server.url, [definition], options);
    await batches.invalidate();
    await until(async () => (await db.query("SELECT requested = completed AS done FROM compute.batch")).rows[0].done);
    assertEquals((await db.query("SELECT value FROM output ORDER BY value")).rows, [{ value: 1 }, { value: 99 }]);
    assertEquals(calculated, [1, 1, 99]);
    assertEquals(captures, 2);
    const { rows: committed } = await db.query(`SELECT o.value, o.xmin::text AS output_tx, l.xmin::text AS outcome_tx, r.xmin::text AS receipt_tx
      FROM output o JOIN durex.work l ON l.key='compute:ratings:' || CASE WHEN o.value=1 THEN '1' ELSE '2' END
      JOIN hybrid_compute_batch.receipt r ON r.instance_id=l.instance AND r.request->'event'->>'kind'='complete'
        AND r.xmin=l.xmin ORDER BY o.value`);
    assertEquals(committed.map((row) => row.value), [1, 99]);
    for (const row of committed) {
      assertEquals(row.output_tx, row.outcome_tx);
      assertEquals(row.receipt_tx, row.outcome_tx);
    }
    assertEquals((await db.query("SELECT locked_by FROM graphile_worker._private_jobs WHERE key = 'airlock:test'")).rows[0].locked_by, "live-airlock");
  } finally {
    await batches.close();
    await db.end();
  }
});

pgTest("dependent computations wait for a producer publication and converge after edits stop", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  const began = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let input = 1;
  let rating = 0;
  let active = 0;
  const observed: unknown[] = [];
  const batches = await openBatches(server.url, [
    spec({
      name: "chances",
      reads: ["ratings"],
      to: ["chances"],
      capture: () => Promise.resolve(rating),
      calculate: (value) => {
        assertEquals(active, 0);
        observed.push(value);
        return Promise.resolve(value);
      },
    }),
    spec({
      capture: () => Promise.resolve(input),
      calculate: async (value) => {
        active++;
        assertEquals(active, 1);
        if (value === 1) {
          began.resolve();
          await release.promise;
        }
        active--;
        return value;
      },
      publish: (_client, value) => {
        rating = value as number;
        return Promise.resolve();
      },
    }),
  ], options);
  try {
    await batches.invalidate(["games"]);
    await began.promise;
    input = 2;
    await batches.invalidate(["games"]);
    assertEquals(observed, []);
    release.resolve();
    await until(async () => (await db.query("SELECT bool_and(requested = completed) AS done FROM compute.batch")).rows[0].done);
    assertEquals(observed, [2]);
  } finally {
    release.resolve();
    await batches.close();
    await db.end();
  }
});

pgTest("continuous producer invalidations cannot starve consumers or lose the final publication", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  let input = 1;
  let rating = 0;
  let writing = true;
  let firstCaptureWasDirty = false;
  const observed: number[] = [];
  const batches = await openBatches(server.url, [
    spec({
      capture: () => Promise.resolve(input),
      calculate: async (value) => {
        if (writing) {
          input++;
          await batches.invalidate(["games"]);
        }
        return value;
      },
      publish: (_client, value) => {
        rating = value as number;
        return Promise.resolve();
      },
    }),
    spec({
      name: "chances",
      reads: ["ratings"],
      to: ["chances"],
      capture: async () => {
        if (writing) {
          firstCaptureWasDirty = (await db.query("SELECT requested > completed AS dirty FROM compute.batch WHERE name = 'ratings'")).rows[0].dirty;
          writing = false;
        }
        return rating;
      },
      publish: (_client, value) => {
        observed.push(value as number);
        return Promise.resolve();
      },
    }),
  ], { ...options, coalesceMs: 0 });
  try {
    await batches.invalidate(["games"]);
    await until(async () => (await db.query("SELECT bool_and(requested = completed) AS done FROM compute.batch")).rows[0].done);
    assert(firstCaptureWasDirty);
    assert(observed.length >= 2);
    assert(observed[0] > 0);
    assertEquals(observed.at(-1), input);
    assertEquals(rating, input);
  } finally {
    writing = false;
    await batches.close();
    await db.end();
  }
});

pgTest("serialization retries do not consume the computation attempt budget", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  await db.query("CREATE SEQUENCE capture_attempt");
  let calculations = 0;
  const batches = await openBatches(server.url, [spec({
    capture: async (client) => {
      const { rows: [row] } = await client.query("SELECT nextval('capture_attempt')::int AS attempt");
      if (row.attempt === 1) {
        await client.query("DO $$ BEGIN RAISE EXCEPTION 'serialization conflict' USING ERRCODE = '40001'; END $$");
      }
      return row.attempt;
    },
    calculate: (value) => {
      calculations++;
      return Promise.resolve(value);
    },
    publish: (_client, value) => {
      assertEquals(value, 2);
      return Promise.resolve();
    },
  })], { ...options, maxAttempts: 1 });
  try {
    await batches.invalidate();
    await until(async () => (await db.query("SELECT completed FROM compute.batch")).rows[0].completed === "1");
    assertEquals(calculations, 1);
  } finally {
    await batches.close();
    await db.end();
  }
});

pgTest("exhausted retries fail the service and remain visible at restart", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  const definition = spec({ calculate: () => Promise.reject(new Error("invalid numerical input")) });
  const batches = await openBatches(server.url, [definition], { ...options, maxAttempts: 1 });
  const rejected = assertRejects(() => batches.promise, Error, "retries exhausted");
  try {
    await Promise.all([batches.invalidate(), rejected]);
    await batches.close();
    assertEquals((await db.query("SELECT completed, claimed FROM compute.batch")).rows[0], { completed: "0", claimed: "1" });
    await assertRejects(() => openBatches(server.url, [definition], options), Error, "retries exhausted");
    assert((await db.query("SELECT last_error FROM graphile_worker.jobs")).rows[0].last_error.includes("invalid numerical input"));
  } finally {
    await batches.close();
    await db.end();
  }
});

pgTest("source deletion supersedes a frozen FK failure only after a newer invalidation", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  await db.query(`
    CREATE TABLE source_rows (id int PRIMARY KEY);
    CREATE TABLE projected (id int REFERENCES source_rows);
    INSERT INTO source_rows VALUES (1), (9);
    INSERT INTO projected VALUES (9);
  `);
  const began = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let captures = 0;
  const batches = await openBatches(server.url, [spec({
    reads: ["source_rows"],
    to: ["projected"],
    capture: async () => {
      captures++;
      if (captures === 2) assertEquals((await db.query("SELECT id FROM projected")).rows, [{ id: 9 }]);
      return (await db.query("SELECT id FROM source_rows ORDER BY id")).rows;
    },
    calculate: async (value) => {
      if (captures === 1) {
        began.resolve();
        await release.promise;
      }
      return value;
    },
    publish: async (client, value) => {
      await client.query("DELETE FROM projected");
      for (const row of value as { id: number }[]) await client.query("INSERT INTO projected VALUES ($1)", [row.id]);
    },
  })], options);
  try {
    await batches.invalidate(["source_rows"]);
    await began.promise;
    await db.query("DELETE FROM source_rows WHERE id = 1");
    release.resolve();
    await until(async () => (await db.query("SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE attempts = 1 AND locked_at IS NULL")).rows[0].n === 1);
    assertEquals((await db.query("SELECT completed, claimed, last_superseded FROM compute.batch")).rows[0], {
      completed: "0",
      claimed: "1",
      last_superseded: null,
    });
    assertEquals(captures, 1);
    await batches.invalidate(["source_rows"]);
    await db.query("UPDATE graphile_worker._private_jobs SET run_at = now()");
    await until(async () => (await db.query("SELECT requested = completed AS done FROM compute.batch")).rows[0].done);
    assertEquals(captures, 2);
    assertEquals((await db.query("SELECT id FROM projected")).rows, [{ id: 9 }]);
    const { rows: [state] } = await db.query("SELECT requested, completed, last_superseded FROM compute.batch");
    assertEquals(state.requested, "2");
    assertEquals(state.completed, "2");
    assertEquals(state.last_superseded.revision, "1");
    assertEquals(state.last_superseded.reason, "foreign_key_violation");
    assertEquals(state.last_superseded.constraint, "projected_id_fkey");
  } finally {
    release.resolve();
    await batches.close();
    await db.end();
  }
});

pgTest("publication stays serializable across role isolation changes and commits sinks with the machine receipt", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  await db.query(`
    CREATE ROLE service NOLOGIN;
    GRANT service TO postgres;
    CREATE OR REPLACE FUNCTION public.app_pre_request() RETURNS void LANGUAGE plpgsql AS $$BEGIN END$$;
    CREATE TABLE sink (id text PRIMARY KEY, value int NOT NULL);
    CREATE TABLE receipt (value int, isolation text, tx text);
    GRANT ALL ON sink TO service;
    CREATE FUNCTION complete() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      INSERT INTO receipt SELECT value, current_setting('transaction_isolation'), pg_current_xact_id()::text FROM sink
    $$;
  `);
  const claims = { role: "service" };
  const target = { name: "ratings", to: ["sink"], onComplete: "complete" };
  let input = 0;
  const batches = await openBatches(server.url, [spec({
    to: target.to,
    capture: () => Promise.resolve(input),
    publish: async (client, value) => {
      await publish(client, target, { sink: [{ id: "a", value }] }, claims);
    },
  })], options);
  try {
    for (const level of ["read committed", "repeatable read", "serializable"]) {
      await db.query(`ALTER ROLE service SET default_transaction_isolation = '${level}'`);
      input++;
      await batches.invalidate(["games"]);
      await until(async () => (await db.query("SELECT requested = completed AS done FROM compute.batch")).rows[0].done);
      const { rows: [receipt] } = await db.query("SELECT * FROM receipt WHERE value = $1", [input]);
      const { rows: [sink] } = await db.query("SELECT value, xmin::text AS tx FROM sink");
      const { rows: [batch] } = await db.query("SELECT state->>'completed' AS completed, xmin::text AS tx FROM hybrid_compute_batch.instance");
      const { rows: [work] } = await db.query("SELECT xmin::text AS tx FROM durex.work WHERE key=$1", [`compute:ratings:${input}`]);
      assertEquals(receipt.isolation, "serializable");
      assertEquals(sink, { value: input, tx: receipt.tx });
      assertEquals(batch, { completed: String(input), tx: receipt.tx });
      assertEquals(work.tx, receipt.tx);
    }
    assertEquals((await db.query("SELECT count(*)::int AS n FROM receipt")).rows[0].n, 3);
  } finally {
    await batches.close();
    await db.end();
  }
});

pgTest("a serialization conflict retries atomic publication without recapturing or recalculating", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  await db.query(`
    CREATE TABLE source (id int PRIMARY KEY, value int NOT NULL);
    INSERT INTO source VALUES (1, 0);
    CREATE TABLE sink (value int, tx text);
  `);
  let captures = 0;
  let calculations = 0;
  let publications = 0;
  const batches = await openBatches(server.url, [spec({
    capture: () => { captures++; return Promise.resolve(7); },
    calculate: (value) => { calculations++; return Promise.resolve(value); },
    publish: async (client, value) => {
      publications++;
      await client.query("INSERT INTO sink VALUES ($1, pg_current_xact_id()::text)", [value]);
      await client.query("SELECT * FROM source WHERE id=1");
      if (publications === 1) await db.query("UPDATE source SET value=1 WHERE id=1");
      await client.query("UPDATE source SET value=value+1 WHERE id=1");
    },
  })], options);
  try {
    await batches.invalidate();
    await until(async () => (await db.query("SELECT requested = completed AS done FROM compute.batch")).rows[0].done);
    assertEquals([captures, calculations, publications], [1, 1, 2]);
    const { rows: sink } = await db.query("SELECT * FROM sink");
    assertEquals(sink.length, 1);
    assertEquals(sink[0].value, 7);
    assertEquals((await db.query("SELECT value FROM source")).rows, [{ value: 2 }]);
    assertEquals((await db.query("SELECT xmin::text AS tx FROM hybrid_compute_batch.instance")).rows[0].tx, sink[0].tx);
    assertEquals((await db.query("SELECT xmin::text AS tx FROM durex.work")).rows[0].tx, sink[0].tx);
  } finally {
    await batches.close();
    await db.end();
  }
});

pgTest("an idle previous coordinator migrates into the Cortex instance without resetting revisions", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  await db.query(`
    CREATE SCHEMA compute;
    CREATE TABLE compute.batch (name text PRIMARY KEY, version text, requested bigint, completed bigint);
    INSERT INTO compute.batch VALUES ('ratings', 'v1', 7, 7);
    CREATE TABLE compute.pool (id text PRIMARY KEY);
  `);
  const batches = await openBatches(server.url, [spec({})], options);
  try {
    assertEquals((await db.query("SELECT requested, completed FROM compute.batch")).rows, [{ requested: "7", completed: "7" }]);
    assertEquals((await db.query("SELECT state->>'phase' AS phase FROM hybrid_compute_batch.instance")).rows, [{ phase: "idle" }]);
    assertEquals((await db.query("SELECT to_regclass('compute.pool') AS pool, to_regclass('compute.previous_batch') AS previous")).rows, [{
      pool: null,
      previous: null,
    }]);
    await batches.invalidate();
    await until(async () => (await db.query("SELECT completed FROM compute.batch")).rows[0].completed === "8");
    assertEquals((await db.query("SELECT key, outcome->>'kind' AS outcome FROM durex.work")).rows, [{
      key: "compute:ratings:8",
      outcome: "done",
    }]);
  } finally {
    await batches.close();
    await db.end();
  }
});

pgTest("an active previous coordinator refuses migration without changing its work", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  try {
    await db.query(`
      CREATE SCHEMA compute;
      CREATE TABLE compute.batch (name text PRIMARY KEY, version text, requested bigint, completed bigint, inputs jsonb);
      INSERT INTO compute.batch VALUES ('ratings', 'v1', 8, 7, '{"frozen":true}');
      CREATE TABLE compute.pool (id text PRIMARY KEY);
    `);
    await assertRejects(() => openBatches(server.url, [spec({})], options), Error, "drain the previous compute coordinator");
    assertEquals((await db.query("SELECT requested, completed, inputs FROM compute.batch")).rows, [{
      requested: "8",
      completed: "7",
      inputs: { frozen: true },
    }]);
    assertEquals((await db.query("SELECT to_regnamespace('hybrid_compute_batch') AS machine, to_regclass('compute.previous_batch') AS previous")).rows, [{
      machine: null,
      previous: null,
    }]);
  } finally {
    await db.end();
  }
});

pgTest("permissive default grants cannot expose captured inputs or authorize machine transitions", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  await db.query(`
    CREATE ROLE observer NOLOGIN;
    ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO observer;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO observer;
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO observer;
  `);
  const began = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const batches = await openBatches(server.url, [spec({
    capture: () => Promise.resolve({ secret: "private input" }),
    calculate: async (value) => {
      began.resolve();
      await release.promise;
      return value;
    },
  })], options);
  try {
    await batches.invalidate();
    await began.promise;
    assertEquals((await db.query("SELECT inputs FROM compute.capture")).rows, [{ inputs: { secret: "private input" } }]);
    for (const schema of ["compute", "hybrid_compute_batch", "durex"]) {
      assertEquals((await db.query("SELECT has_schema_privilege('observer', $1, 'USAGE') AS allowed", [schema])).rows[0].allowed, false);
    }
    for (
      const table of [
        "compute.capture",
        "compute.batch",
        "compute.machine_version",
        "hybrid_compute_batch.instance",
        "hybrid_compute_batch.receipt",
        "durex.work",
      ]
    ) {
      assertEquals((await db.query("SELECT has_table_privilege('observer', $1, 'SELECT,UPDATE') AS allowed", [table])).rows[0].allowed, false);
    }
    for (
      const fn of [
        "compute.invalidate(text[])",
        "hybrid_compute_batch.deliver(uuid,jsonb,bigint)",
        "hybrid_compute_batch.step(jsonb)",
        "durex.settle_work(text,text,jsonb)",
      ]
    ) {
      assertEquals((await db.query("SELECT has_function_privilege('observer', $1, 'EXECUTE') AS allowed", [fn])).rows[0].allowed, false);
    }
    const observer = await db.connect();
    try {
      await observer.query("SET ROLE observer");
      for (
        const query of [
          "SELECT inputs FROM compute.capture",
          "SELECT inputs FROM compute.batch",
          "SELECT input FROM durex.work",
          "UPDATE compute.capture SET inputs='{}'::jsonb",
          "UPDATE hybrid_compute_batch.instance SET state='{}'::jsonb",
          "SELECT compute.invalidate(NULL)",
          'SELECT hybrid_compute_batch.deliver(\'00000000-0000-0000-0000-000000000000\', \'{"kind":"complete","payload":{}}\'::jsonb)',
        ]
      ) await assertRejects(() => observer.query(query), Error, "permission denied");
    } finally {
      try {
        await observer.query("RESET ROLE");
      } finally {
        observer.release();
      }
    }
    assertEquals((await db.query("SELECT completed, claimed FROM compute.batch")).rows, [{ completed: "0", claimed: "1" }]);
    release.resolve();
    await until(async () => (await db.query("SELECT requested = completed AS done FROM compute.batch")).rows[0].done);
  } finally {
    release.resolve();
    await batches.close();
    await db.end();
  }
});

pgTest(
  "capture changes commit with the claim and post-commit delivery retries retained inputs",
  async () => {
    await using server = await postgres();
    const db = new pg.Pool({ connectionString: server.url });
    let captures = 0;
    let deliveries = 0;
    let calculations = 0;
    const definition = spec({
      initialize: async (client) => {
        await client.query(
          "CREATE TABLE IF NOT EXISTS baseline (value int, tx text)",
        );
      },
      capture: async (client) => {
        captures++;
        await client.query(
          "INSERT INTO baseline VALUES ($1,pg_current_xact_id()::text)",
          [captures],
        );
        if (captures === 1) {
          throw new Error("capture fails after baseline write");
        }
        return { value: captures };
      },
      captured: async (value) => {
        deliveries++;
        const { rows: [claim] } = await db.query(
          "SELECT c.inputs,c.xmin::text AS tx FROM compute.capture c JOIN compute.definition d USING(instance_id) WHERE d.name='ratings'",
        );
        assertEquals(claim.inputs, value);
        assertEquals((await db.query("SELECT * FROM baseline")).rows, [{
          value: 2,
          tx: claim.tx,
        }]);
        if (deliveries === 1) {
          throw new Error("acknowledgment failed after claim commit");
        }
      },
      calculate: (value) => {
        calculations++;
        return Promise.resolve(value);
      },
    });
    let batches = await openBatches(server.url, [
      definition,
      spec({ name: "other", to: ["other"] }),
    ], options);
    try {
      await assertRejects(
        () => batches.invalidateNames(["unknown"]),
        Error,
        "unknown computation",
      );
      await batches.invalidateNames(["ratings"]);
      await until(async () =>
        (await db.query(
          "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE attempts=1 AND locked_at IS NULL",
        )).rows[0].n === 1
      );
      assertEquals((await db.query("SELECT * FROM baseline")).rows, []);
      assertEquals(
        (await db.query(
          "SELECT claimed,inputs FROM compute.batch WHERE name='ratings'",
        )).rows,
        [{ claimed: null, inputs: null }],
      );
      await db.query("UPDATE graphile_worker._private_jobs SET run_at=now()");
      await until(async () =>
        (await db.query(
          "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE attempts=2 AND locked_at IS NULL",
        )).rows[0].n === 1
      );
      assertEquals([captures, deliveries, calculations], [2, 1, 0]);
      await batches.close();
      await db.query("UPDATE graphile_worker._private_jobs SET run_at=now()");
      batches = await openBatches(server.url, [
        definition,
        spec({ name: "other", to: ["other"] }),
      ], options);
      await until(async () =>
        (await db.query(
          "SELECT requested=completed AS done FROM compute.batch WHERE name='ratings'",
        )).rows[0].done
      );
      assertEquals([captures, deliveries, calculations], [2, 2, 1]);
      assertEquals(
        (await db.query(
          "SELECT requested FROM compute.batch WHERE name='other'",
        )).rows,
        [{ requested: "0" }],
      );
    } finally {
      await batches.close();
      await db.end();
    }
  },
);

pgTest(
  "a failed initializer rolls back every spec and coordinator definition",
  async () => {
    await using server = await postgres();
    const db = new pg.Pool({ connectionString: server.url });
    try {
      await assertRejects(
        () =>
          openBatches(server.url, [
            spec({
              initialize: async (client) => {
                await client.query(
                  "CREATE TABLE first_initialization (id int)",
                );
              },
            }),
            spec({
              name: "other",
              to: ["other"],
              initialize: async (client) => {
                await client.query(
                  "CREATE TABLE second_initialization (id int)",
                );
                throw new Error("initialization failed");
              },
            }),
          ], options),
        Error,
        "initialization failed",
      );
      assertEquals(
        (await db.query(
          "SELECT to_regclass('first_initialization') AS first,to_regclass('second_initialization') AS second,to_regclass('compute.definition') AS definition",
        )).rows,
        [{ first: null, second: null, definition: null }],
      );
    } finally {
      await db.end();
    }
  },
);

pgTest(
  "native claims retain acknowledged inputs after foreign-key failures despite a newer invalidation",
  async () => {
    await using server = await postgres();
    const db = new pg.Pool({ connectionString: server.url });
    await db.query(
      "CREATE TABLE source (id int PRIMARY KEY); CREATE TABLE sink (id int REFERENCES source)",
    );
    const began = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const batches = await openBatches(server.url, [spec({
      supersedeOnForeignKey: false,
      calculate: async (value) => {
        began.resolve();
        await release.promise;
        return value;
      },
      publish: async (client) => {
        await client.query("INSERT INTO sink VALUES (1)");
      },
    })], options);
    try {
      await batches.invalidateNames(["ratings"]);
      await began.promise;
      await batches.invalidateNames(["ratings"]);
      release.resolve();
      await until(async () =>
        (await db.query(
          "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE attempts=1 AND locked_at IS NULL",
        )).rows[0].n === 1
      );
      assertEquals(
        (await db.query(
          "SELECT requested,completed,claimed,inputs,last_superseded FROM compute.batch",
        )).rows,
        [{
          requested: "2",
          completed: "0",
          claimed: "1",
          inputs: 1,
          last_superseded: null,
        }],
      );
      assertEquals((await db.query("SELECT outcome FROM durex.work")).rows, [{
        outcome: null,
      }]);
    } finally {
      release.resolve();
      await batches.close();
      await db.end();
    }
  },
);

pgTest("first calculation and durable retry observe the same JSON key order", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  const captured = { zz: { second: 2, a: 1 }, a: [{ longer: true, b: false }] };
  const calculated: string[] = [];
  let fail = true;
  const definition = spec({
    capture: () => Promise.resolve(captured),
    calculate: (value) => {
      const output = JSON.stringify(value);
      calculated.push(output);
      return Promise.resolve(output);
    },
    publish: () => {
      if (fail) throw new Error("retry publication with durable JSON inputs");
      return Promise.resolve();
    },
  });
  let batches = await openBatches(server.url, [definition], options);
  try {
    await batches.invalidate();
    await until(async () => (await db.query("SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE attempts=1 AND locked_at IS NULL")).rows[0].n === 1);
    const stored = (await db.query("SELECT inputs FROM compute.batch")).rows[0].inputs;
    assertEquals(calculated, [JSON.stringify(stored)]);
    await batches.close();
    fail = false;
    await db.query("UPDATE graphile_worker._private_jobs SET run_at=now()");
    batches = await openBatches(server.url, [definition], options);
    await until(async () => (await db.query("SELECT requested=completed AS done FROM compute.batch")).rows[0].done);
    assertEquals(calculated, [JSON.stringify(stored), JSON.stringify(stored)]);
  } finally {
    await batches.close();
    await db.end();
  }
});

pgTest("bootstrap initializes under source fences then schedules retained invalidations serializably", async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  const published: unknown[] = [];
  const definition = spec({
    initialize: async (client) => {
      assertEquals((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation, "read committed");
    },
    capture: async (client) => {
      assertEquals((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation, "serializable");
      return 7;
    },
    publish: (_client, value) => { published.push(value); return Promise.resolve(); },
  });
  let batches: Awaited<ReturnType<typeof openBatches>> | undefined;
  try {
    batches = await openBatches(server.url, [definition], options);
    await batches.close();
    batches = undefined;
    await db.query("BEGIN ISOLATION LEVEL SERIALIZABLE; SELECT compute.mark(ARRAY['ratings']); COMMIT");
    assertEquals((await db.query("SELECT requested,completed,wake FROM compute.batch")).rows, [{ requested: "1", completed: "0", wake: null }]);
    batches = await openBatches(server.url, [definition], options);
    await until(async () => (await db.query("SELECT requested = completed AS done FROM compute.batch")).rows[0].done);
    assertEquals(published, [7]);
  } finally {
    await batches?.close();
    await db.end();
  }
});

for (const legacy of [
  { guard: "read committed", hash: "dd7b02748a65c9c6fe5e56e4220b85e317e2fe56347eac3c725a2ea775079b53" },
  { guard: "serializable", hash: "57057ef2d61cf7f7615f134b81822ae725a9b688ccd3bb7c6978ce3b568844e3" },
]) pgTest(`the known ${legacy.guard} compiler upgrade preserves retained work`, async () => {
  await using server = await postgres();
  const db = new pg.Pool({ connectionString: server.url });
  const isolation = (await Deno.readTextFile(new URL("./testdata/read-committed-machine.sql", import.meta.url))).trimEnd();
  const source = await Deno.readTextFile(new URL("./batch-machine.sql", import.meta.url));
  const previous = await Deno.readTextFile(new URL("./testdata/hybrid-batch-machine.sql", import.meta.url));
  const legacySql = legacy.guard === "read committed"
    ? previous.replace(/^-- Durable publication[\s\S]*?^\$serial\$;/m, isolation)
    : previous;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacySql)));
  const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  assertEquals(fingerprint, legacy.hash);
  const snapshot = async (client: pg.Pool | pg.PoolClient) => (await client.query(`SELECT jsonb_build_object(
    'instances', (SELECT jsonb_agg(i ORDER BY id) FROM hybrid_compute_batch.instance i),
    'receipts', (SELECT jsonb_agg(r ORDER BY instance_id,command_id) FROM hybrid_compute_batch.receipt r),
    'captures', (SELECT jsonb_agg(c ORDER BY instance_id) FROM compute.capture c),
    'work', (SELECT jsonb_agg(w ORDER BY key) FROM durex.work w)) AS value`)).rows[0].value;
  let batches: Awaited<ReturnType<typeof openBatches>> | undefined;
  try {
    batches = await openBatches(server.url, [spec({})], options);
    await batches.close();
    batches = undefined;
    await db.query(`BEGIN ISOLATION LEVEL SERIALIZABLE;
      SELECT compute.invalidate(NULL);
      SELECT hybrid_compute_batch.deliver(instance_id, '{"kind":"claim","payload":{}}') FROM compute.definition;
      UPDATE compute.capture SET inputs='7'::jsonb;
      COMMIT`);
    const retained = await snapshot(db);
    await db.query(legacySql);
    for (const unsupported of ["unknown", "106ca9c5e2bec94b81b9bf68773730a4245cf34259747718361f4d8af749f380"]) {
      await db.query("UPDATE compute.machine_version SET fingerprint=$1", [unsupported]);
      await assertRejects(() => openBatches(server.url, [spec({})], options), Error, "requires an explicit schema upgrade");
      assertEquals(await snapshot(db), retained);
    }
    await db.query("UPDATE compute.machine_version SET fingerprint=$1", [fingerprint]);
    await assertRejects(() => openBatches(server.url, [spec({
      initialize: () => Promise.reject(new Error("initializer failed after repair")),
    })], options), Error, "initializer failed after repair");
    assertEquals((await db.query("SELECT fingerprint FROM compute.machine_version")).rows[0].fingerprint, fingerprint);
    assert((await db.query("SELECT prosrc FROM pg_proc WHERE oid='hybrid_compute_batch.serial()'::regprocedure")).rows[0].prosrc.includes(`<> '${legacy.guard}'`));
    assert((await db.query("SELECT prosrc FROM pg_proc WHERE oid='hybrid_compute_batch.engine(jsonb)'::regprocedure")).rows[0].prosrc.includes("hybrid fuel exhausted"));
    assertEquals(await snapshot(db), retained);
    const published: unknown[] = [];
    batches = await openBatches(server.url, [spec({
      initialize: async (client) => { assertEquals(await snapshot(client), retained); },
      capture: () => Promise.reject(new Error("repair must retain the frozen input")),
      publish: (_client, value) => { published.push(value); return Promise.resolve(); },
    })], options);
    await until(async () => (await db.query("SELECT requested = completed AS done FROM compute.batch")).rows[0].done);
    assertEquals(published, [7]);
    assert((await db.query("SELECT prosrc FROM pg_proc WHERE oid='hybrid_compute_batch.engine(jsonb)'::regprocedure")).rows[0].prosrc.includes("mecha fuel exhausted"));
    assertEquals((await db.query("SELECT fingerprint FROM compute.machine_version")).rows[0].fingerprint,
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))), (byte) => byte.toString(16).padStart(2, "0")).join(""));
    await batches.close();
    batches = undefined;
    batches = await openBatches(server.url, [spec({ capture: () => Promise.reject(new Error("repair must not republish")) })], options);
    assertEquals((await db.query("SELECT outcome->>'kind' AS kind FROM durex.work")).rows, [{ kind: "done" }]);
  } finally {
    await batches?.close();
    await db.end();
  }
});
