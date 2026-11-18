import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import pg from "npm:pg@8.16.3";
import { pgTest, postgres } from "./pg-test.ts";
import {
  pipelineSchemaName,
  reconcileNativeResources,
  retirePipeline,
} from "./native-cleanup.ts";
import type { RisingWaveSqlSession } from "./risingwave.ts";

pgTest("native retirement retries exact owned resources and preserves active and unrelated resources", async () => {
  await using database = await postgres();
  const db = new pg.Pool({ connectionString: database.url });
  let fail = true;
  const calls: string[] = [];
  const connect = () => {
    const session: RisingWaveSqlSession = {
      query<R extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
      ): Promise<{ rows: R[] }> {
        calls.push(sql);
        if (fail && sql.startsWith("DROP SCHEMA")) {
          return Promise.reject(new Error("503"));
        }
        return Promise.resolve({ rows: [] });
      },
      end() {
        return Promise.resolve();
      },
    };
    return Promise.resolve(session);
  };
  const endpoint = "http://127.0.0.1:4566";
  const schema = "duckstream_" + "a".repeat(24);
  const orphan = "duckstream_" + "b".repeat(24);
  try {
    await db.query(`CREATE SCHEMA compute;
      CREATE TABLE compute.native_epoch(name text PRIMARY KEY,publications text[] NOT NULL,slots text[] NOT NULL,source_schema text,pipeline_url text);
      CREATE TABLE compute.native_sources(name text,source_schema text);
      CREATE TABLE public.source(id int);
      CREATE TABLE compute.stream_owner(name text); INSERT INTO compute.stream_owner VALUES('removed'),('kept');
      CREATE FUNCTION compute.repair_sink() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
      CREATE TRIGGER retired_repair AFTER INSERT ON public.source FOR EACH ROW EXECUTE FUNCTION compute.repair_sink('removed');
      CREATE TRIGGER kept_repair AFTER INSERT ON public.source FOR EACH ROW EXECUTE FUNCTION compute.repair_sink('kept');
      CREATE SCHEMA ${schema}; CREATE SCHEMA ${orphan}; CREATE SCHEMA unrelated;
      CREATE FUNCTION ${schema}.changed() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
      CREATE TRIGGER owned AFTER INSERT ON public.source FOR EACH ROW EXECUTE FUNCTION ${schema}.changed();
      CREATE PUBLICATION owned_pub FOR TABLE public.source;
      CREATE PUBLICATION unrelated_pub FOR TABLE public.source;`);
    await db.query(
      "SELECT pg_create_logical_replication_slot('owned_slot','pgoutput')",
    );
    await db.query(
      "SELECT pg_create_logical_replication_slot('unrelated_slot','pgoutput')",
    );
    await db.query(
      `INSERT INTO compute.native_epoch VALUES
      ('removed',ARRAY['owned_pub'],ARRAY['owned_slot'],$1,$2),
      ('renamed','{}','{}',NULL,$3),('kept','{}','{}',NULL,$4)`,
      [
        schema,
        `${endpoint}/pipelines/removed`,
        `${endpoint}/pipelines/renamed`,
        `${endpoint}/pipelines/kept`,
      ],
    );
    await db.query(
      "INSERT INTO compute.native_sources VALUES('removed',$1),('orphan',$2)",
      [schema, orphan],
    );
    await assertRejects(
      () => reconcileNativeResources(db, ["kept", "new-name"], undefined, connect),
      Error,
      "503",
    );
    assertEquals(
      (await db.query("SELECT count(*)::int AS n FROM compute.native_epoch"))
        .rows[0].n,
      3,
    );
    assertEquals(
      (await db.query(
        "SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name='owned_slot'",
      )).rows[0].n,
      1,
    );
    fail = false;
    await reconcileNativeResources(db, ["kept", "new-name"], undefined, connect);
    await reconcileNativeResources(db, ["kept", "new-name"], undefined, connect);
    assertEquals(
      (await db.query("SELECT name FROM compute.native_epoch")).rows,
      [{ name: "kept" }],
    );
    assertEquals(
      (await db.query("SELECT * FROM compute.native_sources")).rows,
      [],
    );
    assertEquals(
      (await db.query("SELECT slot_name FROM pg_replication_slots")).rows,
      [{ slot_name: "unrelated_slot" }],
    );
    assertEquals(
      (await db.query("SELECT pubname FROM pg_publication")).rows,
      [{ pubname: "unrelated_pub" }],
    );
    assertEquals(
      (await db.query(
        "SELECT to_regnamespace($1) AS retired,to_regnamespace($2) AS orphan,to_regnamespace('unrelated')::text AS unrelated",
        [schema, orphan],
      )).rows,
      [{ retired: null, orphan: null, unrelated: "unrelated" }],
    );
    await db.query("INSERT INTO public.source VALUES(1)");
    assertEquals(
      (await db.query("SELECT name FROM compute.stream_owner")).rows,
      [{ name: "kept" }],
    );
    assertEquals(
      (await db.query(
        "SELECT tgname FROM pg_trigger WHERE tgrelid='public.source'::regclass AND NOT tgisinternal",
      )).rows,
      [{ tgname: "kept_repair" }],
    );
    assertEquals(calls.some((call) => call.includes("rw_kept")), false);
    await reconcileNativeResources(db, [], undefined, connect);
    assertEquals(
      (await db.query("SELECT * FROM compute.native_epoch")).rows,
      [],
    );
  } finally {
    await db.end();
  }
});

pgTest("legacy native retirement fails closed without endpoint and ignores unregistered prefixes", async () => {
  await using database = await postgres();
  const db = new pg.Pool({ connectionString: database.url });
  try {
    await reconcileNativeResources(db, []);
    await db.query(`CREATE SCHEMA compute;
      CREATE TABLE compute.native_epoch(name text PRIMARY KEY,publications text[] NOT NULL,slots text[] NOT NULL);
      INSERT INTO compute.native_epoch VALUES('legacy','{}','{}');
      CREATE SCHEMA duckstream_cccccccccccccccccccccccc;`);
    await assertRejects(
      () => reconcileNativeResources(db, []),
      Error,
      "RISINGWAVE_URL required",
    );
    assertEquals(
      (await db.query("SELECT count(*)::int AS n FROM compute.native_epoch"))
        .rows[0].n,
      1,
    );
    await db.query("DELETE FROM compute.native_epoch");
    await reconcileNativeResources(db, []);
    assertEquals(
      (await db.query(
        "SELECT to_regnamespace('duckstream_cccccccccccccccccccccccc') IS NOT NULL AS exists",
      )).rows[0].exists,
      true,
    );
  } finally {
    await db.end();
  }
});

Deno.test("retirePipeline preserves endpoint credentials and database and keeps hyphen/underscore schemas distinct", async () => {
  assertNotEquals(pipelineSchemaName("foo-bar"), pipelineSchemaName("foo_bar"));
  assertNotEquals(pipelineSchemaName("foo_hbar"), pipelineSchemaName("foo-bar"));
  const seen: { endpoint: string; sql: string[] }[] = [];
  await retirePipeline(
    "postgresql://rw_user:rw_pass@risingwave.internal:4566/custom_db/pipelines/foo-bar",
    (endpoint) => {
      const entry = { endpoint, sql: [] as string[] };
      seen.push(entry);
      return Promise.resolve({
        query: <R>(sql: string) => {
          entry.sql.push(sql);
          return Promise.resolve({ rows: [] as R[] });
        },
        end: () => Promise.resolve(),
      });
    },
  );
  assertEquals(seen, [{
    endpoint: "postgresql://rw_user:rw_pass@risingwave.internal:4566/custom_db",
    sql: ['DROP SCHEMA IF EXISTS "rw_foo_hbar" CASCADE'],
  }]);
});

pgTest("reconcileNativeResources retires pre-RisingWave /v0/pipelines epochs without dialing removed HTTP endpoints", async () => {
  await using database = await postgres();
  const db = new pg.Pool({ connectionString: database.url });
  const schema = "duckstream_" + "d".repeat(24);
  let dialed = false;
  const connect = () => {
    dialed = true;
    return Promise.reject(new Error("unexpected RisingWave connection"));
  };
  try {
    await db.query(`CREATE SCHEMA compute;
      CREATE TABLE compute.native_epoch(name text PRIMARY KEY,publications text[] NOT NULL,slots text[] NOT NULL,source_schema text,pipeline_url text);
      CREATE TABLE public.source(id int);
      CREATE SCHEMA ${schema};
      CREATE PUBLICATION legacy_pub FOR TABLE public.source;`);
    await db.query(
      "SELECT pg_create_logical_replication_slot('legacy_slot','pgoutput')",
    );
    await db.query(
      "INSERT INTO compute.native_epoch VALUES('legacy-pipe',ARRAY['legacy_pub'],ARRAY['legacy_slot'],$1,'http://feldera:8080/v0/pipelines/legacy-pipe')",
      [schema],
    );
    await reconcileNativeResources(db, [], undefined, connect);
    assertEquals(dialed, false);
    assertEquals((await db.query("SELECT * FROM compute.native_epoch")).rows, []);
    assertEquals((await db.query("SELECT * FROM pg_replication_slots WHERE slot_name='legacy_slot'")).rows, []);
    assertEquals((await db.query("SELECT * FROM pg_publication WHERE pubname='legacy_pub'")).rows, []);
    assertEquals((await db.query("SELECT to_regnamespace($1) AS ns", [schema])).rows, [{ ns: null }]);
  } finally {
    await db.end();
  }
});
