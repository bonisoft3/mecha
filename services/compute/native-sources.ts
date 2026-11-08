import type pg from "npm:pg@8.16.3";
import type { FelderaProgram } from "./feldera.ts";

export type IncrementalProgram = FelderaProgram & {
  incremental: {
    inputs: Record<string, { table: string; projection: string }>;
    outputs: Record<string, { partitionQuery: string }>;
    checks?: Record<string, string>;
  };
};

export function sqlIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`invalid native source identifier ${value}`);
  }
  return `"${value}"`;
}

export function sourceSchema(version: string): string {
  if (!/^[0-9a-f]{64}$/.test(version)) throw new Error("invalid computation version");
  return "duckstream_" + version.slice(0, 24);
}

const postgresType: Record<string, string> = {
  BOOLEAN: "boolean", SMALLINT: "smallint", INTEGER: "integer",
  BIGINT: "bigint", DOUBLE: "double precision", VARCHAR: "text",
  TIMESTAMP: "timestamp(6) without time zone",
};

async function protectSources(client: pg.PoolClient, schema: string) {
  await client.query(`DO $private$
    DECLARE grant_ record; table_ record;
    BEGIN
      FOR table_ IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='${schema}' AND c.relkind IN ('r','p')
      LOOP
        EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY','${schema}',table_.relname);
      END LOOP;
      FOR grant_ IN
        SELECT DISTINCT 'SCHEMA' AS kind, quote_ident(n.nspname) AS name, a.grantee
          FROM pg_namespace n, aclexplode(n.nspacl) a
          WHERE n.nspname='${schema}' AND a.grantee<>n.nspowner
        UNION
        SELECT DISTINCT 'TABLE', format('%I.%I',n.nspname,c.relname), a.grantee
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace, aclexplode(c.relacl) a
          WHERE n.nspname='${schema}' AND a.grantee<>c.relowner
        UNION
        SELECT DISTINCT 'FUNCTION',p.oid::regprocedure::text,a.grantee
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
            aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE n.nspname='${schema}' AND a.grantee<>p.proowner
      LOOP
        EXECUTE format('REVOKE ALL ON %s %s FROM %s',grant_.kind,grant_.name,
          CASE WHEN grant_.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(grant_.grantee)) END);
      END LOOP;
    END;
  $private$`);
}

/** Normalized current rows, maintained in the source transaction; never a work queue. */
export async function installSources(
  client: pg.PoolClient,
  program: IncrementalProgram,
  version: string,
  owner?: string,
) {
  const schema = sourceSchema(version);
  const q = sqlIdentifier(schema);
  if (owner !== undefined) {
    await client.query(`CREATE SCHEMA IF NOT EXISTS compute; REVOKE ALL ON SCHEMA compute FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS compute.native_sources(name text NOT NULL,source_schema text NOT NULL UNIQUE,PRIMARY KEY(name,source_schema))`);
    await client.query(`INSERT INTO compute.native_sources(name,source_schema) VALUES($1,$2)
      ON CONFLICT(name,source_schema) DO NOTHING`, [owner,schema]);
  }
  const { rows: [existing] } = await client.query(
    "SELECT to_regnamespace($1) AS schema", [schema],
  );
  if (existing.schema) {
    await protectSources(client, schema);
    return;
  }
  if (!program.incremental || Object.keys(program.inputs).sort().join() !==
    Object.keys(program.incremental.inputs).sort().join()) {
    throw new Error("native ingestion requires every source projection");
  }
  const tables = [...new Set(Object.values(program.incremental.inputs).map((s) => s.table))].sort();
  // Install triggers and their populated baseline under the same source write fence.
  await client.query(`LOCK TABLE ${tables.map((t) => `public.${sqlIdentifier(t)}`).join(",")} IN SHARE ROW EXCLUSIVE MODE`);
  await client.query(`CREATE SCHEMA ${q}; REVOKE ALL ON SCHEMA ${q} FROM PUBLIC`);
  for (const [name, input] of Object.entries(program.inputs)) {
    const source = program.incremental.inputs[name];
    const table = sqlIdentifier(name);
    const columns = input.fields.map((f) => sqlIdentifier(f.name)).join(",");
    const fields = input.fields.map((f) => {
      const type = postgresType[f.type];
      if (!type) throw new Error(`unsupported native source type ${f.type}`);
      return `${sqlIdentifier(f.name)} ${type}`;
    }).join(",");
    const changes = input.fields.map((f) => `${sqlIdentifier(f.name)}=EXCLUDED.${sqlIdentifier(f.name)}`).join(",");
    const previous = input.fields.map((f) => `held.${sqlIdentifier(f.name)}`).join(",");
    const incoming = input.fields.map((f) => `EXCLUDED.${sqlIdentifier(f.name)}`).join(",");
    await client.query(`CREATE TABLE ${q}.${table} (__key text PRIMARY KEY,${fields})`);
    await client.query(`INSERT INTO ${q}.${table} SELECT id::text,${source.projection} FROM public.${sqlIdentifier(source.table)}`);
    await client.query(`CREATE FUNCTION ${q}.${table}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $native$
      BEGIN
        IF TG_OP='TRUNCATE' THEN
          DELETE FROM ${q}.${table};
          RETURN NULL;
        END IF;
        IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.id IS DISTINCT FROM NEW.id) THEN
          DELETE FROM ${q}.${table} WHERE __key=OLD.id::text;
        END IF;
        IF TG_OP<>'DELETE' THEN
          INSERT INTO ${q}.${table} AS held (__key,${columns})
          SELECT NEW.id::text,${source.projection} FROM (SELECT NEW.*) src
          ON CONFLICT(__key) DO UPDATE SET ${changes}
          WHERE ROW(${previous}) IS DISTINCT FROM ROW(${incoming});
        END IF;
        RETURN NULL;
      END;
    $native$;
    REVOKE ALL ON FUNCTION ${q}.${table}() FROM PUBLIC`);
    const trigger = schema + "_" + name.replace(/^source_/, "").slice(0, 20);
    await client.query(`CREATE TRIGGER ${sqlIdentifier(trigger)} AFTER INSERT OR UPDATE OR DELETE ON public.${sqlIdentifier(source.table)} FOR EACH ROW EXECUTE FUNCTION ${q}.${table}()`);
    await client.query(`CREATE TRIGGER ${sqlIdentifier(trigger + "_trunc")} AFTER TRUNCATE ON public.${sqlIdentifier(source.table)} FOR EACH STATEMENT EXECUTE FUNCTION ${q}.${table}()`);
  }
  await protectSources(client, schema);
}

export function nativeSql(program: IncrementalProgram, schema: string, publications: Record<string, string>): string {
  sqlIdentifier(schema);
  let sql = program.sql;
  for (const [name, input] of Object.entries(program.inputs)) {
    sqlIdentifier(name);
    const publication = publications[name];
    sqlIdentifier(publication);
    const fields = input.fields.map((f) => `${sqlIdentifier(f.name)} ${f.type === "TIMESTAMP" ? "TIMESTAMP(6)" : f.type}`).join(",");
    const connector = JSON.stringify([{
      name: "cdc", transport: { name: "postgres_cdc_input", config: {
        uri: "${env:FELDERA_DATABASE_URL}", publication, source_table: `${schema}.${name}`,
      } },
    }]).replaceAll("'", "''");
    const declaration = new RegExp(`CREATE TABLE ${name}\\s*\\([^;]*\\);`, "g");
    if ([...sql.matchAll(declaration)].length !== 1) throw new Error(`missing unique source declaration ${name}`);
    sql = sql.replace(declaration, `CREATE TABLE cdc_${name} (__key VARCHAR NOT NULL PRIMARY KEY,${fields}) WITH ('connectors'='${connector}');\nCREATE LOCAL VIEW ${name} AS SELECT ${input.fields.map((f) => sqlIdentifier(f.name)).join(",")} FROM cdc_${name};`);
  }
  for (const [name, output] of Object.entries(program.outputs)) {
    sqlIdentifier(name);
    const partition = program.incremental.outputs[name];
    if (!partition) throw new Error(`missing native partition ${name}`);
    const fields = output.fields.map((f) => `${sqlIdentifier(f.name)} ${f.type === "TIMESTAMP" ? "TIMESTAMP(6)" : f.type}`).join(",");
    const columns = ["__partition", ...output.fields.map((f) => f.name)].map(sqlIdentifier).join(",");
    sql += `\nCREATE MATERIALIZED VIEW stream_${name} AS ${partition.partitionQuery};
      CREATE TABLE captured_${name} (__partition VARCHAR NOT NULL,${fields});
      CREATE MATERIALIZED VIEW pending_add_${name} AS SELECT ${columns} FROM stream_${name} EXCEPT ALL SELECT ${columns} FROM captured_${name};
      CREATE MATERIALIZED VIEW pending_remove_${name} AS SELECT ${columns} FROM captured_${name} EXCEPT ALL SELECT ${columns} FROM stream_${name};`;
  }
  for (const [name, query] of Object.entries(program.incremental.checks ?? {})) {
    sqlIdentifier(name);
    sql += `\nCREATE MATERIALIZED VIEW invalid_${name} AS ${query};`;
  }
  return sql;
}
