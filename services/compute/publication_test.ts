import { assertEquals, assertRejects } from "@std/assert";
import pg from "npm:pg@8.16.3";
import { pgTest, postgres } from "./pg-test.ts";
import { table as types } from "./portable-fixture.ts";
import { type Publication, publish, publishDelta } from "./publication.ts";

const CRUD = `CREATE ROLE anon NOLOGIN; CREATE ROLE service NOLOGIN;
  CREATE FUNCTION public.app_pre_request() RETURNS void LANGUAGE plpgsql AS $$BEGIN END$$;`;

async function fixture(sql: string) {
  const database = await postgres();
  const pool = new pg.Pool({ connectionString: database.url });
  const client = await pool.connect();
  await client.query(`${CRUD}\n${sql}`);
  const apply = (publisher: typeof publish) =>
  async (
    spec: Publication,
    out: unknown,
    claims: Record<string, unknown> = { role: "service" },
  ) => {
    await client.query("BEGIN");
    try {
      const summary = await publisher(client, spec, out, claims);
      await client.query("COMMIT");
      return summary;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  };
  return {
    client,
    apply: apply(publish),
    applyDelta: apply(publishDelta),
    async [Symbol.asyncDispose]() {
      client.release();
      await pool.end();
      await database[Symbol.asyncDispose]();
    },
  };
}

pgTest(
  "publication changes only distinct rows and records completion in its transaction",
  async () => {
    await using db = await fixture(`
    CREATE TABLE sink (id text PRIMARY KEY, value jsonb);
    CREATE TABLE history (count integer);
    CREATE TABLE updates (id text);
    CREATE FUNCTION audit_update() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN INSERT INTO updates VALUES (NEW.id); RETURN NEW; END$$;
    CREATE TRIGGER audit AFTER UPDATE ON sink FOR EACH ROW EXECUTE FUNCTION audit_update();
    CREATE FUNCTION complete() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public
      AS $$INSERT INTO history SELECT count(*) FROM sink$$;
    REVOKE ALL ON FUNCTION complete() FROM PUBLIC; GRANT EXECUTE ON FUNCTION complete() TO service;
    GRANT ALL ON sink, updates TO service;`);
    const spec = { name: "stats", to: ["sink"], onComplete: "complete" };
    const out = {
      sink: [{ id: "a", value: { x: 1, y: 2 } }, { id: "b", value: null }],
    };
    assertEquals(await db.apply(spec, out), {
      sink: { rows: 2, upserted: 2, deleted: 0 },
    });
    assertEquals(
      await db.apply(spec, {
        sink: [{ id: "a", value: { y: 2, x: 1 } }, out.sink[1]],
      }),
      {
        sink: { rows: 2, upserted: 0, deleted: 0 },
      },
    );
    // A later day's capture still needs history when the numerical rows are unchanged.
    assertEquals((await db.client.query("SELECT * FROM history")).rows, [{
      count: 2,
    }, { count: 2 }]);
    assertEquals((await db.client.query("SELECT * FROM updates")).rows, []);
    assertEquals(
      await db.apply(spec, { sink: [{ id: "a", value: { x: 2 } }] }),
      {
        sink: { rows: 1, upserted: 1, deleted: 1 },
      },
    );
    assertEquals((await db.client.query("SELECT * FROM updates")).rows, [{
      id: "a",
    }]);
    assertEquals(await db.apply(spec, { sink: [] }), {
      sink: { rows: 0, upserted: 0, deleted: 1 },
    });
    assertEquals(await db.apply(spec, { sink: [] }), {
      sink: { rows: 0, upserted: 0, deleted: 0 },
    });
    assertEquals(
      (await db.client.query("SELECT * FROM history ORDER BY count")).rows,
      [{ count: 0 }, { count: 0 }, { count: 1 }, { count: 2 }, { count: 2 }],
    );
  },
);

pgTest(
  "publication rolls back every sink and hook on failure, then can retry",
  async () => {
    await using db = await fixture(`
    CREATE TABLE a (id text PRIMARY KEY);
    CREATE TABLE b (id text PRIMARY KEY, value integer CHECK(value > 0));
    CREATE TABLE history (id text);
    INSERT INTO a VALUES ('old');
    CREATE FUNCTION complete() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN INSERT INTO history VALUES ('attempt'); RAISE EXCEPTION 'hook failed'; END$$;
    GRANT ALL ON a, b TO service;`);
    const spec = { name: "stats", to: ["a", "b"] };
    await assertRejects(
      () => db.apply(spec, { a: [{ id: "new" }], b: [{ id: "b", value: 0 }] }),
      Error,
      "b_value_check",
    );
    assertEquals((await db.client.query("SELECT * FROM a")).rows, [{
      id: "old",
    }]);
    const out = { a: [{ id: "new" }], b: [{ id: "b", value: 1 }] };
    await assertRejects(
      () => db.apply({ ...spec, onComplete: "complete" }, out),
      Error,
      "hook failed",
    );
    assertEquals((await db.client.query("SELECT * FROM a")).rows, [{
      id: "old",
    }]);
    assertEquals((await db.client.query("SELECT * FROM b")).rows, []);
    assertEquals((await db.client.query("SELECT * FROM history")).rows, []);
    assertEquals(await db.apply(spec, out), {
      a: { rows: 1, upserted: 1, deleted: 1 },
      b: { rows: 1, upserted: 1, deleted: 0 },
    });
  },
);

pgTest(
  "publication upserts all sinks before deleting old referenced rows",
  async () => {
    await using db = await fixture(`
    CREATE TABLE a (id text PRIMARY KEY);
    CREATE TABLE b (id text PRIMARY KEY, a_id text REFERENCES a(id));
    INSERT INTO a VALUES ('old'); INSERT INTO b VALUES ('b', 'old');
    GRANT ALL ON a, b TO service;`);
    await db.apply({ name: "stats", to: ["a", "b"] }, {
      a: [{ id: "new" }],
      b: [{ id: "b", a_id: "new" }],
    });
    assertEquals((await db.client.query("SELECT * FROM a")).rows, [{
      id: "new",
    }]);
    assertEquals((await db.client.query("SELECT * FROM b")).rows, [{
      id: "b",
      a_id: "new",
    }]);
  },
);

pgTest(
  "publication enforces RLS, claims and pre-request under the service role, then restores authority",
  async () => {
    await using db = await fixture(`
    CREATE TABLE sink (id text PRIMARY KEY, owner text);
    ALTER TABLE sink ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owned ON sink TO service USING (owner = current_setting('request.jwt.claims')::jsonb->>'sub');
    GRANT ALL ON sink TO service; GRANT SELECT ON sink TO anon;
    CREATE OR REPLACE FUNCTION public.app_pre_request() RETURNS void LANGUAGE plpgsql AS $$BEGIN
      IF current_user <> 'service' OR current_setting('request.jwt.claims')::jsonb->>'sub' <> 'me'
      THEN RAISE EXCEPTION 'bad request'; END IF;
    END$$;
    ALTER ROLE service SET statement_timeout = '1s'; GRANT service TO postgres;`);
    const spec = { name: "stats", to: ["sink"] };
    const claims = { role: "service", sub: "me" };
    await assertRejects(
      () => db.apply(spec, { sink: [{ id: "a", owner: "other" }] }, claims),
      Error,
      "row-level security",
    );
    await assertRejects(
      () => db.apply(spec, { sink: [] }, { role: "anon" }),
      Error,
      "bad request",
    );
    await db.client.query("BEGIN");
    await db.client.query(
      "SELECT set_config('request.jwt.claims', 'original', true)",
    );
    await publish(
      db.client,
      spec,
      { sink: [{ id: "a", owner: "me" }] },
      claims,
    );
    assertEquals(
      (await db.client.query(`SELECT current_user AS role,
    current_setting('request.jwt.claims') AS claims, current_setting('statement_timeout') AS timeout`))
        .rows,
      [{ role: "postgres", claims: "original", timeout: "0" }],
    );
    await db.client.query("COMMIT");
  },
);

pgTest(
  "publication refuses malformed output before changing any rows",
  async () => {
    await using db = await fixture(
      "CREATE TABLE sink (id text PRIMARY KEY, value integer); GRANT ALL ON sink TO service;",
    );
    const spec = { name: "stats", to: ["sink"] };
    for (
      const out of [
        { other: [] },
        { sink: [{ id: "a" }, { id: "a" }] },
        { sink: [{ id: 1 }] },
        { sink: [{ id: "a", value: Infinity }] },
        { sink: [{ id: "a", value: undefined }] },
        { sink: [{ id: "a" }, { id: "b", value: 1 }] },
        { sink: [{ id: "a", 'x"; DROP TABLE sink; --': 1 }] },
      ]
    ) await assertRejects(() => db.apply(spec, out));
    await assertRejects(() =>
      db.apply({ ...spec, onComplete: "complete(); DROP TABLE sink; --" }, {
        sink: [],
      })
    );
    await assertRejects(() =>
      db.apply({ ...spec, to: ["sink", "sink"] }, { sink: [] })
    );
    assertEquals((await db.client.query("SELECT * FROM sink")).rows, []);
  },
);

pgTest(
  "publication refuses incompatible role isolation and applies permitted role settings",
  async () => {
    await using db = await fixture(`
    CREATE TABLE sink (id text PRIMARY KEY);
    GRANT ALL ON sink TO service; GRANT service TO postgres;
    ALTER ROLE service SET default_transaction_isolation = 'serializable';`);
    const spec = { name: "stats", to: ["sink"] };
    await assertRejects(
      () => db.apply(spec, { sink: [{ id: "x" }] }),
      Error,
      "requires transaction isolation serializable",
    );
    await db.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await publish(db.client, spec, { sink: [{ id: "x" }] }, {
      role: "service",
    });
    await db.client.query("COMMIT");
    await db.client.query(
      `ALTER ROLE service RESET default_transaction_isolation;
    ALTER ROLE service SET statement_timeout = '50ms';
    CREATE FUNCTION slow() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(1); RETURN NEW; END$$;
    CREATE TRIGGER slow BEFORE INSERT ON sink FOR EACH ROW EXECUTE FUNCTION slow();`,
    );
    await assertRejects(
      () => db.apply(spec, { sink: [{ id: "y" }] }),
      Error,
      "statement timeout",
    );
    assertEquals((await db.client.query("SELECT * FROM sink")).rows, [{
      id: "x",
    }]);
  },
);

pgTest(
  "delta publication touches only supplied UUID keys and retains an indexed delete path",
  async () => {
    await using db = await fixture(`
    CREATE TABLE sink (id uuid PRIMARY KEY, value integer);
    INSERT INTO sink SELECT md5(i::text)::uuid, i FROM generate_series(1, 2000) i;
    CREATE TABLE history (count integer);
    CREATE FUNCTION complete() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public
      AS $$INSERT INTO history SELECT count(*) FROM sink$$;
    GRANT ALL ON sink TO service;
    ANALYZE sink;`);
    const ids = (await db.client.query(
      "SELECT id FROM sink WHERE value<=502 ORDER BY value",
    )).rows.map((row) => row.id);
    const spec = { name: "stats", to: ["sink"], onComplete: "complete" };
    const commands: { sql: string; values: unknown[] }[] = [];
    const client = new Proxy(db.client, {
      get(target, key) {
        if (key === "query") {
          return (...args: unknown[]) => {
            if (typeof args[0] === "string") {
              commands.push({ sql: args[0], values: args[1] as unknown[] });
            }
            return Reflect.apply(target.query, target, args);
          };
        }
        return Reflect.get(target, key);
      },
    });
    await db.client.query("BEGIN");
    assertEquals(
      await publishDelta(client, spec, {
        sink: { upserts: [{ id: ids[0], value: -1 }], deletes: ids.slice(1) },
      }, { role: "service" }),
      { sink: { rows: 1, upserted: 1, deleted: 501 } },
    );
    await db.client.query("COMMIT");
    assertEquals(
      (await db.client.query(
        "SELECT count(*)::integer AS n FROM sink WHERE value>502",
      )).rows,
      [{ n: 1498 }],
    );
    assertEquals(
      (await db.client.query("SELECT * FROM sink WHERE id=$1", [ids[0]])).rows,
      [{ id: ids[0], value: -1 }],
    );
    assertEquals((await db.client.query("SELECT * FROM history")).rows, [{
      count: 1499,
    }]);
    const deletes = commands.filter(({ sql }) => sql.startsWith("DELETE"));
    assertEquals(deletes.length, 2);
    await db.client.query("SET enable_seqscan=off");
    const plan = await db.client.query(
      "EXPLAIN (FORMAT JSON) " + deletes[0].sql,
      deletes[0].values,
    );
    const nodes = JSON.stringify(plan.rows);
    assertEquals(nodes.includes('"Index Name":"sink_pkey"'), true);
    assertEquals(nodes.includes('"Index Cond"'), true);
    assertEquals(
      await db.applyDelta(spec, { sink: { upserts: [], deletes: [] } }),
      {
        sink: { rows: 0, upserted: 0, deleted: 0 },
      },
    );
    assertEquals(
      (await db.client.query("SELECT count(*)::integer AS n FROM sink")).rows,
      [{ n: 1499 }],
    );
  },
);

pgTest(
  "delta publication rolls back sinks and completion hook together",
  async () => {
    await using db = await fixture(`
    CREATE TABLE a (id text PRIMARY KEY);
    CREATE TABLE b (id text PRIMARY KEY, value integer CHECK(value>0));
    CREATE TABLE history (id text);
    INSERT INTO a VALUES ('old'), ('untouched');
    CREATE FUNCTION complete() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN INSERT INTO history VALUES ('attempt'); RAISE EXCEPTION 'hook failed'; END$$;
    GRANT ALL ON a,b TO service;`);
    const spec = { name: "stats", to: ["a", "b"] };
    const out = {
      a: { upserts: [{ id: "new" }], deletes: ["old"] },
      b: { upserts: [{ id: "b", value: 0 }], deletes: [] },
    };
    await assertRejects(() => db.applyDelta(spec, out), Error, "b_value_check");
    out.b.upserts[0].value = 1;
    await assertRejects(
      () => db.applyDelta({ ...spec, onComplete: "complete" }, out),
      Error,
      "hook failed",
    );
    assertEquals((await db.client.query("SELECT * FROM a ORDER BY id")).rows, [{
      id: "old",
    }, { id: "untouched" }]);
    assertEquals((await db.client.query("SELECT * FROM b")).rows, []);
    assertEquals((await db.client.query("SELECT * FROM history")).rows, []);
    assertEquals(await db.applyDelta(spec, out), {
      a: { rows: 1, upserted: 1, deleted: 1 },
      b: { rows: 1, upserted: 1, deleted: 0 },
    });
    assertEquals(await db.applyDelta(spec, out), {
      a: { rows: 1, upserted: 0, deleted: 0 },
      b: { rows: 1, upserted: 0, deleted: 0 },
    });
    assertEquals((await db.client.query("SELECT * FROM a ORDER BY id")).rows, [{
      id: "new",
    }, { id: "untouched" }]);
  },
);

pgTest(
  "delta publication retains RLS, request settings and authority restoration",
  async () => {
    await using db = await fixture(`
    CREATE TABLE sink (id text PRIMARY KEY, owner text);
    INSERT INTO sink VALUES ('mine','me'), ('theirs','other');
    ALTER TABLE sink ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owned ON sink TO service USING (owner=current_setting('request.jwt.claims')::jsonb->>'sub');
    GRANT ALL ON sink TO service;
    GRANT service TO postgres;
    ALTER ROLE service SET statement_timeout='1s';
    ALTER ROLE service SET default_transaction_isolation='serializable';
    CREATE OR REPLACE FUNCTION public.app_pre_request() RETURNS void LANGUAGE plpgsql AS $$BEGIN
      IF current_user<>'service' OR current_setting('request.jwt.claims')::jsonb->>'sub'<>'me'
      THEN RAISE EXCEPTION 'bad request'; END IF;
    END$$;`);
    const spec = { name: "stats", to: ["sink"] };
    const claims = { role: "service", sub: "me" };
    await assertRejects(
      () =>
        db.applyDelta(
          spec,
          { sink: { upserts: [], deletes: ["mine"] } },
          claims,
        ),
      Error,
      "requires transaction isolation serializable",
    );
    await db.client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await db.client.query(
      "SELECT set_config('request.jwt.claims','original',true)",
    );
    assertEquals(
      await publishDelta(db.client, spec, {
        sink: { upserts: [], deletes: ["mine", "theirs"] },
      }, claims),
      {
        sink: { rows: 0, upserted: 0, deleted: 1 },
      },
    );
    assertEquals(
      (await db.client.query(`SELECT current_user AS role,
    current_setting('request.jwt.claims') AS claims,current_setting('statement_timeout') AS timeout`))
        .rows,
      [{ role: "postgres", claims: "original", timeout: "0" }],
    );
    await db.client.query("COMMIT");
    assertEquals((await db.client.query("SELECT * FROM sink")).rows, [{
      id: "theirs",
      owner: "other",
    }]);
  },
);

pgTest(
  "delta publication refuses duplicate, overlapping or malformed keys before writing",
  async () => {
    await using db = await fixture(
      "CREATE TABLE sink (id text PRIMARY KEY); GRANT ALL ON sink TO service;",
    );
    const spec = { name: "stats", to: ["sink"] };
    for (
      const out of [
        { other: { upserts: [], deletes: [] } },
        { sink: { upserts: [], deletes: ["a", "a"] } },
        { sink: { upserts: [{ id: "a" }], deletes: ["a"] } },
        { sink: { upserts: [{ id: "a" }, { id: "a" }], deletes: [] } },
        { sink: { upserts: [], deletes: [null] } },
        { sink: { upserts: [], deletes: [1] } },
        { sink: { upserts: [], deletes: [], unexpected: true } },
        { sink: { upserts: [] } },
        { sink: [] },
      ]
    ) await assertRejects(() => db.applyDelta(spec, out));
    assertEquals((await db.client.query("SELECT * FROM sink")).rows, []);
  },
);

pgTest(
  "delta publication rejects UUID aliases across operation and chunk boundaries",
  async () => {
    await using db = await fixture(
      "CREATE TABLE sink (id uuid PRIMARY KEY); GRANT ALL ON sink TO service;",
    );
    const spec = { name: "stats", to: ["sink"] };
    const id = "aabbccdd-0000-4000-8000-000000000001";
    await assertRejects(
      () =>
        db.applyDelta(spec, {
          sink: { upserts: [{ id }], deletes: [id.toUpperCase()] },
        }),
      Error,
      "repeated PostgreSQL keys",
    );
    const ids = Array.from(
      { length: 500 },
      (_, i) =>
        `aabbccdd-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`,
    );
    await assertRejects(
      () =>
        db.applyDelta(spec, {
          sink: { upserts: [], deletes: [...ids, ids[0].toUpperCase()] },
        }),
      Error,
      "repeated PostgreSQL keys",
    );
    assertEquals((await db.client.query("SELECT * FROM sink")).rows, []);
  },
);

pgTest(
  "delta publication preserves portable byte and int64 transport",
  async () => {
    await using db = await fixture(
      `CREATE TABLE sink (id uuid PRIMARY KEY, payload bytea, total bigint);
    GRANT ALL ON sink TO service;`,
    );
    const spec: Publication = {
      name: "stats",
      to: ["sink"],
      types,
      sinkTypes: {
        sink: [
          { name: "id", type: "uuid", required: true },
          { name: "payload", type: "bytes", required: true },
          { name: "total", type: "int64", required: true },
        ],
      },
    };
    const id = "aabbccdd-0000-4000-8000-000000000001";
    await db.applyDelta(spec, {
      sink: {
        upserts: [{ id, payload: "AP8=", total: "9223372036854775807" }],
        deletes: [],
      },
    });
    assertEquals(
      (await db.client.query(
        "SELECT id, encode(payload,'hex') AS payload, total::text FROM sink",
      )).rows,
      [{ id, payload: "00ff", total: "9223372036854775807" }],
    );
    await assertRejects(() =>
      db.applyDelta(spec, {
        sink: {
          upserts: [{ id, payload: "AP8=", total: 9223372036854775807 }],
          deletes: [],
        },
      })
    );
    assertEquals(
      await db.applyDelta(spec, { sink: { upserts: [], deletes: [id] } }),
      {
        sink: { rows: 0, upserted: 0, deleted: 1 },
      },
    );
  },
);

pgTest(
  "full publication retains typed UUID aliases and rejects duplicate identities across chunks",
  async () => {
    await using db = await fixture(
      "CREATE TABLE sink (id uuid PRIMARY KEY, value integer); GRANT ALL ON sink TO service;",
    );
    const spec = { name: "stats", to: ["sink"] };
    const id = "aabbccdd-0000-4000-8000-000000000001";
    const alternate = id.replaceAll("-", "").toUpperCase();
    await db.client.query("INSERT INTO sink VALUES ($1, 0)", [
      crypto.randomUUID(),
    ]);
    assertEquals(
      await db.apply(spec, { sink: [{ id: alternate, value: 7 }] }),
      {
        sink: { rows: 1, upserted: 1, deleted: 1 },
      },
    );
    assertEquals(await db.apply(spec, { sink: [{ id, value: 7 }] }), {
      sink: { rows: 1, upserted: 0, deleted: 0 },
    });
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: `aabbccdd-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`,
      value: i,
    }));
    for (
      const duplicated of [[rows[0], { id: alternate, value: 9 }], [...rows, {
        id: alternate,
        value: 9,
      }]]
    ) {
      await assertRejects(
        () => db.apply(spec, { sink: duplicated }),
        Error,
        "repeated PostgreSQL keys",
      );
      assertEquals((await db.client.query("SELECT * FROM sink")).rows, [{
        id,
        value: 7,
      }]);
    }
  },
);

pgTest(
  "upsert history ignores snapshot absence and native delta removals while other sinks replace",
  async () => {
    await using db = await fixture(`
    CREATE TABLE history(id text PRIMARY KEY,value integer);
    CREATE TABLE current(id text PRIMARY KEY,value integer);
    INSERT INTO history VALUES('old',1),('now',2);
    INSERT INTO current VALUES('old',1),('now',2);
    GRANT ALL ON history,current TO service;`);
    const spec: Publication = {
      name: "ratings",
      to: ["history", "current"],
      sinkWrites: { history: "upsert" },
    };
    assertEquals(
      await db.apply(spec, {
        history: [{ id: "now", value: 3 }],
        current: [{ id: "now", value: 3 }],
      }),
      {
        history: { rows: 1, upserted: 1, deleted: 0 },
        current: { rows: 1, upserted: 1, deleted: 1 },
      },
    );
    assertEquals(
      await db.applyDelta(spec, {
        history: { upserts: [{ id: "old", value: 4 }], deletes: ["now"] },
        current: { upserts: [], deletes: ["now"] },
      }),
      {
        history: { rows: 1, upserted: 1, deleted: 0 },
        current: { rows: 0, upserted: 0, deleted: 1 },
      },
    );
    await db.apply(spec, { history: [], current: [] });
    assertEquals(
      (await db.client.query("SELECT * FROM history ORDER BY id")).rows,
      [{ id: "now", value: 3 }, { id: "old", value: 4 }],
    );
    assertEquals((await db.client.query("SELECT * FROM current")).rows, []);
    await assertRejects(
      () =>
        db.apply({ ...spec, sinkWrites: { undeclared: "upsert" } }, {
          history: [],
          current: [],
        }),
      Error,
      "invalid sink write mode",
    );
  },
);
