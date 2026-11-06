import { assertEquals, assertRejects } from "@std/assert";
import pg from "pg";
import { duckdb, readerOf } from "./main.ts";
import { publish } from "./publication.ts";
import { fields, row, table } from "./portable-fixture.ts";

const POSTGRES = "postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function docker(args: string[]) {
  const result = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) throw new Error(`docker ${args[0]}: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout).trim();
}

Deno.test("all fifteen portable types roundtrip PostgreSQL domains through native DuckDB and typed publication", async () => {
  const container = `mecha-portable-${crypto.randomUUID()}`;
  await docker([
    "run",
    "--rm",
    "-d",
    "--name",
    container,
    "-p",
    "127.0.0.1::5432",
    "-e",
    "POSTGRES_PASSWORD=portable",
    POSTGRES,
  ]);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await new Deno.Command("docker", {
        args: ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (result.success) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("disposable PostgreSQL did not become ready");
    const port = (await docker(["port", container, "5432/tcp"])).split(":").at(-1);
    const url = `postgresql://postgres:portable@127.0.0.1:${port}/postgres`;
    const pool = new pg.Pool({ connectionString: url });
    const client = await pool.connect();
    const db = await duckdb();
    const con = await db.connect();
    try {
      const domains = new Set(["int64", "bytes", "timestamp", "time", "duration", "decimal"]);
      await client.query(`
        ${
        fields.filter(({ type }) => domains.has(type)).map(({ type }) =>
          `CREATE DOMAIN portable_${type} AS ${table.types[type].pg};`
        ).join("\n")
      }
        CREATE FUNCTION public.app_pre_request() RETURNS void LANGUAGE plpgsql AS $$BEGIN END$$;
        CREATE TABLE source (${
        fields.map(({ name, type }) =>
          `"${name}" ${domains.has(type) ? `portable_${type}` : table.types[type].pg}${
            name === "id" ? " PRIMARY KEY" : ""
          }`
        ).join(", ")
      });
        CREATE TABLE sink (LIKE source INCLUDING ALL);
        INSERT INTO source VALUES (
          'São Paulo 🌎', true, -2147483648, 9223372036854775807, 1.5,
          decode('00ff8041', 'hex'), '${row.id}', '2026-09-21 08:00:00.123456-03',
          '0001-01-01', '23:59:59.123456', 'America/Sao_Paulo',
          '3 days 01:02:03.123456', ${row.decimal_value},
          ${quote(JSON.stringify(row.json_value))}, ${quote(JSON.stringify(row.geojson_value))}
        );
        INSERT INTO source (id) VALUES ('8c1f3a56-7e0b-4e3d-9c62-6a6fcb7b4a5f');
      `);
      await con.run(`LOAD postgres; ATTACH ${quote(url)} AS pg (TYPE postgres, READ_ONLY)`);
      await con.run("CREATE TABLE source AS SELECT * FROM pg.public.source");
      await con.run("DETACH pg");
      // The postgres extension carries domains as text; SQL declares their native types.
      const sql = `SELECT * REPLACE (
        CAST(int64_value AS BIGINT) AS int64_value,
        from_hex(substr(bytes_value, 3)) AS bytes_value,
        CAST(timestamp_value AS TIMESTAMPTZ) AS timestamp_value,
        CAST(time_value AS TIME) AS time_value,
        CAST(duration_value AS INTERVAL) AS duration_value,
        CAST(decimal_value AS DECIMAL(38,6)) AS decimal_value
      ) FROM source ORDER BY id`;
      const reader = readerOf(con);
      const captured = await reader.query(sql, { fields, types: table });
      assertEquals(captured, [
        row,
        Object.fromEntries(
          fields.map(({ name }) => [name, name === "id" ? "8c1f3a56-7e0b-4e3d-9c62-6a6fcb7b4a5f" : null]),
        ),
      ]);
      const retained = structuredClone(captured);
      const spec = { name: "portable", to: ["sink"], types: table, sinkTypes: { sink: fields } };
      await client.query("BEGIN");
      await publish(client, spec, { sink: captured }, { role: "postgres" });
      await client.query("COMMIT");
      assertEquals(captured, retained);
      const comparison = fields.map(({ name, type }) => {
        const cast = type === "json" || type === "geojson" ? "::jsonb" : "";
        return `(source."${name}"${cast} IS NOT DISTINCT FROM sink."${name}"${cast})`;
      }).join(" AND ");
      const { rows } = await client.query(`
        SELECT count(*)::int AS total,
          bool_and(${comparison}) AS exact
        FROM source FULL JOIN sink USING (id)
      `);
      assertEquals(rows, [{ total: 2, exact: true }]);
      await client.query("BEGIN");
      await assertRejects(
        () => publish(client, { ...spec, sinkTypes: {} }, { sink: [] }, { role: "postgres" }),
        Error,
        "omit",
      );
      await client.query("ROLLBACK");
      assertEquals((await client.query("SELECT count(*)::int AS total FROM sink")).rows, [{ total: 2 }]);
    } finally {
      con.closeSync();
      db.closeSync();
      client.release();
      await pool.end();
    }
  } finally {
    await docker(["rm", "-f", container]);
  }
});
