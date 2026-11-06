import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import pg from "pg";
import { pgTest, postgres } from "./pg-test.ts";
import {
  type IncrementalProgram,
  installSources,
  nativeSql,
  sourceSchema,
} from "./native-sources.ts";

const version = "a".repeat(64);
const schema = sourceSchema(version);
const program: IncrementalProgram = {
  sql:
    `CREATE TABLE source_item(id VARCHAR, amount BIGINT, label VARCHAR, moment TIMESTAMP(6));
    CREATE MATERIALIZED VIEW result_item AS SELECT * FROM source_item;`,
  inputs: {
    source_item: {
      query: "SELECT id, amount, label, moment FROM item",
      fields: [
        { name: "id", type: "VARCHAR" },
        { name: "amount", type: "BIGINT" },
        { name: "label", type: "VARCHAR" },
        { name: "moment", type: "TIMESTAMP" },
      ],
    },
  },
  outputs: {
    item: {
      view: "result_item",
      fields: [
        { name: "id", type: "VARCHAR" },
        { name: "amount", type: "BIGINT" },
        { name: "label", type: "VARCHAR" },
        { name: "moment", type: "TIMESTAMP" },
      ],
    },
  },
  incremental: {
    inputs: {
      source_item: {
        table: "item",
        projection:
          "id::text AS id, amount*2 AS amount, upper(label) AS label, moment",
      },
    },
    outputs: {
      item: {
        partitionQuery: "SELECT 'global' AS __partition, * FROM result_item",
      },
    },
    checks: { negative: "SELECT id FROM source_item WHERE amount<0" },
  },
};

async function fixture() {
  const database = await postgres();
  const pool = new pg.Pool({ connectionString: database.url });
  const client = await pool.connect();
  await client.query(`CREATE ROLE editor NOLOGIN;
    CREATE TABLE public.item(id text PRIMARY KEY, amount bigint, label text, moment timestamp(6), ignored text);
    INSERT INTO item VALUES ('a', 7, 'first', '2026-10-23 10:11:12.123456', 'original'), ('b', 9, NULL, NULL, NULL);
    GRANT SELECT,INSERT,UPDATE,DELETE ON public.item TO editor;`);
  return {
    client,
    pool,
    async install() {
      await client.query("BEGIN");
      try {
        await installSources(client, program, version);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
    async rows() {
      return (await client.query(
        `SELECT __key,id,amount::text,label,moment::text FROM ${schema}.source_item ORDER BY __key`,
      )).rows;
    },
    async [Symbol.asyncDispose]() {
      client.release();
      await pool.end();
      await database[Symbol.asyncDispose]();
    },
  };
}

pgTest(
  "source ownership survives installation before engine registration and rejects another owner",
  async () => {
    await using db = await fixture();
    await db.client.query("BEGIN");
    await installSources(db.client, program, version, "statistics");
    await db.client.query("COMMIT");
    assertEquals(
      (await db.client.query("SELECT * FROM compute.native_sources")).rows,
      [
        { name: "statistics", source_schema: schema },
      ],
    );
    assertEquals(
      (await db.client.query(
        "SELECT to_regclass('compute.native_epoch') AS registry",
      )).rows,
      [{ registry: null }],
    );
    await db.client.query("BEGIN");
    await installSources(db.client, program, version, "statistics");
    await db.client.query("COMMIT");
    assertEquals(
      (await db.client.query(
        "SELECT count(*)::integer AS n FROM compute.native_sources",
      )).rows,
      [{ n: 1 }],
    );
    await db.client.query("BEGIN");
    await assertRejects(
      () => installSources(db.client, program, version, "other_statistics"),
      pg.DatabaseError,
      "duplicate key value",
    );
    await db.client.query("ROLLBACK");
    assertEquals(
      (await db.client.query("SELECT * FROM compute.native_sources")).rows,
      [
        { name: "statistics", source_schema: schema },
      ],
    );

    const replacement = "b".repeat(64);
    await db.client.query("BEGIN");
    await installSources(db.client, program, replacement, "statistics");
    await db.client.query("ROLLBACK");
    assertEquals(
      (await db.client.query("SELECT * FROM compute.native_sources")).rows,
      [
        { name: "statistics", source_schema: schema },
      ],
    );
    assertEquals(
      (await db.client.query("SELECT to_regnamespace($1) AS schema", [
        sourceSchema(replacement),
      ])).rows,
      [{ schema: null }],
    );
    assertEquals(
      (await db.client.query(
        "SELECT count(*)::integer AS n FROM pg_trigger WHERE tgrelid='public.item'::regclass AND NOT tgisinternal",
      )).rows,
      [{ n: 2 }],
    );
  },
);

pgTest(
  "ownership is recorded even when adopting an already installed source schema",
  async () => {
    await using db = await fixture();
    await db.install();
    await db.client.query("BEGIN");
    await installSources(db.client, program, version, "statistics");
    await db.client.query("ROLLBACK");
    assertEquals(
      (await db.client.query("SELECT to_regnamespace('compute') AS schema"))
        .rows,
      [{ schema: null }],
    );
    await db.client.query("BEGIN");
    await installSources(db.client, program, version, "statistics");
    await db.client.query("COMMIT");
    assertEquals(
      (await db.client.query("SELECT * FROM compute.native_sources")).rows,
      [
        { name: "statistics", source_schema: schema },
      ],
    );
    assertEquals((await db.rows()).length, 2);
  },
);

pgTest(
  "native sources bootstrap populated rows and maintain only changed projections in the source transaction",
  async () => {
    await using db = await fixture();
    await db.install();
    assertEquals(await db.rows(), [
      {
        __key: "a",
        id: "a",
        amount: "14",
        label: "FIRST",
        moment: "2026-10-23 10:11:12.123456",
      },
      { __key: "b", id: "b", amount: "18", label: null, moment: null },
    ]);
    await db.client.query(
      `CREATE TABLE public.mirror_writes(kind text, key text);
    CREATE FUNCTION public.audit_mirror() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      INSERT INTO public.mirror_writes VALUES (TG_OP,COALESCE(NEW.__key,OLD.__key)); RETURN NULL;
    END$$;
    CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON ${schema}.source_item
      FOR EACH ROW EXECUTE FUNCTION public.audit_mirror();`,
    );
    await db.client.query("BEGIN; SET LOCAL ROLE editor");
    await db.client.query(
      "UPDATE item SET label='FIRST', ignored='changed' WHERE id='a'",
    );
    await db.client.query("UPDATE item SET amount=8 WHERE id='a'");
    await db.client.query(
      "INSERT INTO item VALUES ('c', 5, 'third', NULL, NULL)",
    );
    await db.client.query("UPDATE item SET id='d' WHERE id='c'");
    await db.client.query("DELETE FROM item WHERE id='b'");
    await db.client.query("COMMIT");
    assertEquals(await db.rows(), [
      {
        __key: "a",
        id: "a",
        amount: "16",
        label: "FIRST",
        moment: "2026-10-23 10:11:12.123456",
      },
      { __key: "d", id: "d", amount: "10", label: "THIRD", moment: null },
    ]);
    assertEquals((await db.client.query("SELECT * FROM mirror_writes")).rows, [
      { kind: "UPDATE", key: "a" },
      { kind: "INSERT", key: "c" },
      { kind: "DELETE", key: "c" },
      { kind: "INSERT", key: "d" },
      { kind: "DELETE", key: "b" },
    ]);
    await db.client.query("BEGIN; SET LOCAL ROLE editor");
    await db.client.query(
      "UPDATE item SET amount=90 WHERE id='a'; DELETE FROM item WHERE id='d'; INSERT INTO item VALUES ('e',1,NULL,NULL,NULL)",
    );
    await db.client.query("ROLLBACK");
    assertEquals(
      (await db.client.query(
        "SELECT count(*)::integer AS n FROM mirror_writes",
      )).rows,
      [{ n: 5 }],
    );
    assertEquals(await db.rows(), [
      {
        __key: "a",
        id: "a",
        amount: "16",
        label: "FIRST",
        moment: "2026-10-23 10:11:12.123456",
      },
      { __key: "d", id: "d", amount: "10", label: "THIRD", moment: null },
    ]);
    await db.install();
    assertEquals(
      (await db.client.query(
        "SELECT count(*)::integer AS n FROM mirror_writes",
      )).rows,
      [{ n: 5 }],
    );
  },
);

pgTest(
  "new and adopted native mirrors reject inherited grants while source triggers retain authority",
  async () => {
    await using db = await fixture();
    await db.client.query(`CREATE ROLE observer NOLOGIN;
      ALTER TABLE public.item ENABLE ROW LEVEL SECURITY;
      CREATE POLICY editor ON public.item TO editor USING(true) WITH CHECK(true);
      GRANT SELECT ON public.item TO observer;
      ALTER DEFAULT PRIVILEGES GRANT USAGE ON SCHEMAS TO observer;
      ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO observer;
      ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO observer`);
    for (const adopted of [false, true]) {
      if (adopted) {
        await db.client.query(`GRANT USAGE ON SCHEMA ${schema} TO observer;
          GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO observer;
          GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO observer;
          ALTER TABLE ${schema}.source_item DISABLE ROW LEVEL SECURITY`);
      }
      await db.install();
      assertEquals((await db.client.query(`SELECT
        has_schema_privilege('observer',$1,'USAGE') AS schema,
        has_table_privilege('observer',$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS table,
        has_function_privilege('observer',$3,'EXECUTE') AS function,
        (SELECT relrowsecurity FROM pg_class WHERE oid=$2::regclass) AS rls`,
      [schema, `${schema}.source_item`, `${schema}.source_item()`])).rows,
      [{ schema: false, table: false, function: false, rls: true }]);
      await db.client.query('SET ROLE observer');
      try {
        assertEquals((await db.client.query('SELECT * FROM public.item')).rows, []);
        await assertRejects(() => db.client.query(`SELECT * FROM ${schema}.source_item`), pg.DatabaseError, 'permission denied');
      } finally {
        await db.client.query('RESET ROLE');
      }
      await db.client.query(`BEGIN; GRANT USAGE ON SCHEMA ${schema} TO observer; SET LOCAL ROLE observer`);
      try {
        for (const sql of [
          `SELECT * FROM ${schema}.source_item`,
          `UPDATE ${schema}.source_item SET amount=999`,
          `DELETE FROM ${schema}.source_item`,
          `TRUNCATE ${schema}.source_item`,
          `SELECT ${schema}.source_item()`,
        ]) {
          await db.client.query('SAVEPOINT denied');
          await assertRejects(() => db.client.query(sql), pg.DatabaseError, 'permission denied');
          await db.client.query('ROLLBACK TO SAVEPOINT denied');
        }
      } finally {
        await db.client.query('ROLLBACK');
      }
      await db.client.query(`BEGIN; SET LOCAL ROLE editor;
        UPDATE public.item SET amount=amount+1 WHERE id='a'; COMMIT`);
      assertEquals((await db.client.query(`SELECT amount::integer AS amount FROM ${schema}.source_item WHERE __key='a'`)).rows,
        [{ amount: adopted ? 18 : 16 }]);
    }
  },
);

pgTest(
  "source truncate commits CDC row retractions atomically and rollback preserves the mirror",
  async () => {
    await using db = await fixture();
    await db.install();
    const baseline = await db.rows();
    await db.client.query("GRANT TRUNCATE ON public.item TO editor");
    await db.client.query(
      "SELECT pg_create_logical_replication_slot('mirror_test', 'test_decoding')",
    );
    await db.client.query(
      "BEGIN; SET LOCAL ROLE editor; TRUNCATE item; RESET ROLE",
    );
    assertEquals(await db.rows(), []);
    await db.client.query("ROLLBACK");
    assertEquals(await db.rows(), baseline);
    assertEquals(
      (await db.client.query("SELECT count(*)::integer AS n FROM item")).rows,
      [{ n: 2 }],
    );
    const rolledBack = await db.client.query(
      "SELECT data FROM pg_logical_slot_get_changes('mirror_test', NULL, NULL)",
    );
    assertEquals(
      rolledBack.rows.filter((row) =>
        row.data.includes(`${schema}.source_item`)
      ),
      [],
    );

    await db.client.query(
      "BEGIN; SET LOCAL ROLE editor; TRUNCATE item; COMMIT",
    );
    assertEquals(await db.rows(), []);
    assertEquals(
      (await db.client.query("SELECT count(*)::integer AS n FROM item")).rows,
      [{ n: 0 }],
    );
    const committed = await db.client.query(
      "SELECT data FROM pg_logical_slot_get_changes('mirror_test', NULL, NULL)",
    );
    assertEquals(
      committed.rows.map((row) =>
        row.data.replace(/^(BEGIN|COMMIT) \d+$/, "$1")
      ),
      [
        "BEGIN",
        "table public.item: TRUNCATE: (no-flags)",
        `table ${schema}.source_item: DELETE: __key[text]:'a'`,
        `table ${schema}.source_item: DELETE: __key[text]:'b'`,
        "COMMIT",
      ],
    );
    const retractions = committed.rows.map((row) => row.data).filter((data) =>
      data.includes(`${schema}.source_item`)
    );
    assertEquals(retractions.sort(), [
      `table ${schema}.source_item: DELETE: __key[text]:'a'`,
      `table ${schema}.source_item: DELETE: __key[text]:'b'`,
    ]);
    await db.client.query(
      "BEGIN; SET LOCAL ROLE editor; INSERT INTO item VALUES ('c',3,NULL,NULL,NULL); COMMIT",
    );
    assertEquals(await db.rows(), [{
      __key: "c",
      id: "c",
      amount: "6",
      label: null,
      moment: null,
    }]);
  },
);

pgTest(
  "native source installation fences concurrent source writes until baseline and triggers commit",
  async () => {
    await using db = await fixture();
    const writer = await db.pool.connect();
    try {
      await db.client.query("BEGIN");
      await installSources(db.client, program, version);
      const { rows: [{ pid }] } = await writer.query(
        "SELECT pg_backend_pid() AS pid",
      );
      const update = writer.query("UPDATE item SET amount=100 WHERE id='a'");
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const { rows: [state] } = await db.client.query(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
          [pid],
        );
        if (state.wait_event_type === "Lock") {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assertEquals(blocked, true);
      assertEquals((await db.rows())[0].amount, "14");
      await db.client.query("COMMIT");
      await update;
      assertEquals((await db.rows())[0].amount, "200");
    } finally {
      await db.client.query("ROLLBACK");
      writer.release();
    }
  },
);

pgTest(
  "native mirror tables and trigger functions remain private while source writes work",
  async () => {
    await using db = await fixture();
    await db.install();
    const { rows: [permissions] } = await db.client.query(
      `SELECT
    has_schema_privilege('editor',$1,'USAGE') AS schema,
    has_table_privilege('editor',$2,'SELECT,INSERT,UPDATE,DELETE') AS table,
    has_function_privilege('editor',$3,'EXECUTE') AS function`,
      [schema, `${schema}.source_item`, `${schema}.source_item()`],
    );
    assertEquals(permissions, { schema: false, table: false, function: false });
    await db.client.query("BEGIN; SET LOCAL ROLE editor");
    await assertRejects(
      () => db.client.query(`SELECT * FROM ${schema}.source_item`),
      Error,
      "permission denied",
    );
    await db.client.query("ROLLBACK");
    await db.client.query(
      "BEGIN; SET LOCAL ROLE editor; UPDATE item SET amount=10 WHERE id='a'; COMMIT",
    );
    assertEquals((await db.rows())[0].amount, "20");
  },
);

Deno.test("native SQL wires CDC and bag-difference feedback without widening timestamp precision", () => {
  const sql = nativeSql(
    program,
    schema,
    { source_item: "source_publication" },
  );
  assertEquals(sql.includes("CREATE TABLE source_item("), false);
  assertEquals(
    sql.includes(
      'CREATE TABLE cdc_source_item (__key VARCHAR NOT NULL PRIMARY KEY,"id" VARCHAR,"amount" BIGINT,"label" VARCHAR,"moment" TIMESTAMP(6))',
    ),
    true,
  );
  const connector = /WITH \('connectors'='(.*)'\);/.exec(sql)![1].replaceAll(
    "''",
    "'",
  );
  assertEquals(JSON.parse(connector), [{
    name: "cdc",
    transport: {
      name: "postgres_cdc_input",
      config: {
        uri: "${env:FELDERA_DATABASE_URL}",
        publication: "source_publication",
        source_table: `${schema}.source_item`,
      },
    },
  }]);
  assertEquals(
    sql.includes(
      'CREATE LOCAL VIEW source_item AS SELECT "id","amount","label","moment" FROM cdc_source_item;',
    ),
    true,
  );
  assertEquals(
    sql.includes(
      'CREATE TABLE captured_item (__partition VARCHAR NOT NULL,"id" VARCHAR,"amount" BIGINT,"label" VARCHAR,"moment" TIMESTAMP(6));',
    ),
    true,
  );
  assertEquals(
    sql.includes(
      'FROM stream_item EXCEPT ALL SELECT "__partition","id","amount","label","moment" FROM captured_item',
    ),
    true,
  );
  assertEquals(
    sql.includes(
      'FROM captured_item EXCEPT ALL SELECT "__partition","id","amount","label","moment" FROM stream_item',
    ),
    true,
  );
  assertEquals(
    sql.includes(
      "CREATE MATERIALIZED VIEW invalid_negative AS SELECT id FROM source_item WHERE amount<0",
    ),
    true,
  );
  assertThrows(() =>
    nativeSql(
      {
        ...program,
        sql: program.sql + "\nCREATE TABLE source_item(id VARCHAR);",
      },
      schema,
      { source_item: "source_publication" },
    )
  );
  assertThrows(() =>
    nativeSql(
      program,
      "bad;schema",
      { source_item: "source_publication" },
    )
  );
  assertThrows(() =>
    nativeSql(
      program,
      schema,
      { source_item: "bad;publication" },
    )
  );
});

pgTest(
  "native source point updates do not scan unrelated source history",
  async () => {
    await using db = await fixture();
    await db.client.query(`INSERT INTO item(id,amount,label)
    SELECT 'history-'||i::text,i,'retained' FROM generate_series(1,10000) i;
    ANALYZE item;`);
    await db.install();
    const writer = await db.pool.connect();
    try {
      await writer.query("SET track_counts=on");
      await writer.query("UPDATE item SET amount=amount+1 WHERE id='a'");
      await writer.query("SELECT pg_stat_force_next_flush()");
      const deadline = Date.now() + 5000;
      let reads;
      do {
        await db.client.query("SELECT pg_stat_clear_snapshot()");
        reads = (await db.client.query(
          `SELECT seq_tup_read,idx_tup_fetch FROM pg_stat_user_tables
        WHERE relid='public.item'::regclass`,
        )).rows[0];
        if (BigInt(reads.idx_tup_fetch) > 0n) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      assertEquals(reads, { seq_tup_read: "0", idx_tup_fetch: "1" });
      assertEquals(
        (await db.client.query(
          `SELECT amount::text FROM ${schema}.source_item WHERE __key='a'`,
        )).rows,
        [{ amount: "16" }],
      );
    } finally {
      writer.release();
    }
  },
);
