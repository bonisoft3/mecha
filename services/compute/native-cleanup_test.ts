import { assertEquals, assertRejects } from "@std/assert";
import pg from "pg";
import { pgTest, postgres } from "./pg-test.ts";
import { reconcileNativeResources } from "./native-cleanup.ts";

pgTest("native retirement retries exact owned resources and preserves active and unrelated resources", async () => {
  await using database = await postgres();
  const db = new pg.Pool({ connectionString: database.url });
  let fail = true;
  const calls: string[] = [];
  const pipelines = new Set(["removed", "renamed"]);
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, (request) => {
    const url = new URL(request.url), name = url.pathname.split("/")[3];
    calls.push(`${request.method} ${url.pathname}`);
    if (!pipelines.has(name)) return new Response(null, { status: 404 });
    if (request.method === "DELETE") {
      if (fail) return new Response(null, { status: 503 });
      pipelines.delete(name);
    }
    return Response.json({ deployment_status: "Stopped" });
  });
  const endpoint = `http://127.0.0.1:${server.addr.port}`;
  const schema = "duckstream_" + "a".repeat(24), orphan = "duckstream_" + "b".repeat(24);
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
    await db.query("SELECT pg_create_logical_replication_slot('owned_slot','pgoutput')");
    await db.query("SELECT pg_create_logical_replication_slot('unrelated_slot','pgoutput')");
    await db.query(`INSERT INTO compute.native_epoch VALUES
      ('removed',ARRAY['owned_pub'],ARRAY['owned_slot'],$1,$2),
      ('renamed','{}','{}',NULL,$3),('kept','{}','{}',NULL,$4)`,
      [schema, `${endpoint}/v0/pipelines/removed`, `${endpoint}/v0/pipelines/renamed`, `${endpoint}/v0/pipelines/kept`]);
    await db.query("INSERT INTO compute.native_sources VALUES('removed',$1),('orphan',$2)", [schema, orphan]);
    await assertRejects(() => reconcileNativeResources(db, ["kept", "new-name"]), Error, "503");
    assertEquals((await db.query("SELECT count(*)::int AS n FROM compute.native_epoch")).rows[0].n, 3);
    assertEquals((await db.query("SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name='owned_slot'")).rows[0].n, 1);
    fail = false;
    await reconcileNativeResources(db, ["kept", "new-name"]);
    await reconcileNativeResources(db, ["kept", "new-name"]);
    assertEquals((await db.query("SELECT name FROM compute.native_epoch")).rows, [{ name: "kept" }]);
    assertEquals((await db.query("SELECT * FROM compute.native_sources")).rows, []);
    assertEquals((await db.query("SELECT slot_name FROM pg_replication_slots")).rows, [{ slot_name: "unrelated_slot" }]);
    assertEquals((await db.query("SELECT pubname FROM pg_publication")).rows, [{ pubname: "unrelated_pub" }]);
    assertEquals((await db.query("SELECT to_regnamespace($1) AS retired,to_regnamespace($2) AS orphan,to_regnamespace('unrelated')::text AS unrelated", [schema, orphan])).rows, [{ retired: null, orphan: null, unrelated: "unrelated" }]);
    await db.query("INSERT INTO public.source VALUES(1)");
    assertEquals((await db.query("SELECT name FROM compute.stream_owner")).rows, [{ name: "kept" }]);
    assertEquals((await db.query("SELECT tgname FROM pg_trigger WHERE tgrelid='public.source'::regclass AND NOT tgisinternal")).rows, [{ tgname: "kept_repair" }]);
    assertEquals(calls.some((call) => call.includes("kept")), false);
    await reconcileNativeResources(db, []);
    assertEquals((await db.query("SELECT * FROM compute.native_epoch")).rows, []);
  } finally { await db.end(); await server.shutdown(); }
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
    await assertRejects(() => reconcileNativeResources(db, []), Error, "FELDERA_URL required");
    assertEquals((await db.query("SELECT count(*)::int AS n FROM compute.native_epoch")).rows[0].n, 1);
    await db.query("DELETE FROM compute.native_epoch");
    await reconcileNativeResources(db, []);
    assertEquals((await db.query("SELECT to_regnamespace('duckstream_cccccccccccccccccccccccc') IS NOT NULL AS exists")).rows[0].exists, true);
  } finally { await db.end(); }
});
