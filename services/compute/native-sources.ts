import type pg from "npm:pg@8.16.3";
import {
  type RisingWaveProgram,
  splitStatements,
  translateRisingWaveSql,
} from "./risingwave.ts";

export type IncrementalProgram = RisingWaveProgram & {
  incremental: {
    inputs: Record<string, { table: string; projection: string }>;
    outputs: Record<string, { partitionQuery: string }>;
    checks?: Record<string, string>;
  };
};

export type NativeCdcSourceConfig = {
  uri: string;
  slot: string;
  publication: string;
};

export function sqlIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`invalid native source identifier ${value}`);
  }
  return `"${value}"`;
}

export function sourceSchema(version: string): string {
  if (!/^[0-9a-f]{64}$/.test(version)) {
    throw new Error("invalid computation version");
  }
  return "duckstream_" + version.slice(0, 24);
}

const postgresType: Record<string, string> = {
  BOOLEAN: "boolean",
  SMALLINT: "smallint",
  INTEGER: "integer",
  BIGINT: "bigint",
  DOUBLE: "double precision",
  VARCHAR: "text",
  TIMESTAMP: "timestamp(6) without time zone",
};

const risingWaveType = (type: string): string =>
  type === "DOUBLE"
    ? "DOUBLE PRECISION"
    : type === "TIMESTAMP"
    ? "TIMESTAMP"
    : type;

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
    await client.query(
      `CREATE SCHEMA IF NOT EXISTS compute; REVOKE ALL ON SCHEMA compute FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS compute.native_sources(name text NOT NULL,source_schema text NOT NULL UNIQUE,PRIMARY KEY(name,source_schema))`,
    );
    await client.query(
      `INSERT INTO compute.native_sources(name,source_schema) VALUES($1,$2)
      ON CONFLICT(name,source_schema) DO NOTHING`,
      [owner, schema],
    );
  }
  const { rows: [existing] } = await client.query(
    "SELECT to_regnamespace($1) AS schema",
    [schema],
  );
  if (existing.schema) {
    await protectSources(client, schema);
    return;
  }
  if (
    !program.incremental ||
    Object.keys(program.inputs).sort().join() !==
      Object.keys(program.incremental.inputs).sort().join()
  ) {
    throw new Error("native ingestion requires every source projection");
  }
  const tables = [
    ...new Set(Object.values(program.incremental.inputs).map((s) => s.table)),
  ].sort();
  // Install triggers and their populated baseline under the same source write fence.
  await client.query(
    `LOCK TABLE ${
      tables.map((t) => `public.${sqlIdentifier(t)}`).join(",")
    } IN SHARE ROW EXCLUSIVE MODE`,
  );
  await client.query(
    `CREATE SCHEMA ${q}; REVOKE ALL ON SCHEMA ${q} FROM PUBLIC`,
  );
  for (const [name, input] of Object.entries(program.inputs)) {
    const source = program.incremental.inputs[name];
    const table = sqlIdentifier(name);
    const columns = input.fields.map((f) => sqlIdentifier(f.name)).join(",");
    const fields = input.fields.map((f) => {
      const type = postgresType[f.type];
      if (!type) throw new Error(`unsupported native source type ${f.type}`);
      return `${sqlIdentifier(f.name)} ${type}`;
    }).join(",");
    const changes = input.fields.map((f) =>
      `${sqlIdentifier(f.name)}=EXCLUDED.${sqlIdentifier(f.name)}`
    ).join(",");
    const previous = input.fields.map((f) => `held.${sqlIdentifier(f.name)}`)
      .join(",");
    const incoming = input.fields.map((f) =>
      `EXCLUDED.${sqlIdentifier(f.name)}`
    ).join(",");
    await client.query(
      `CREATE TABLE ${q}.${table} (__key text PRIMARY KEY,${fields})`,
    );
    await client.query(
      `INSERT INTO ${q}.${table} SELECT id::text,${source.projection} FROM public.${
        sqlIdentifier(source.table)
      }`,
    );
    await client.query(
      `CREATE FUNCTION ${q}.${table}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $native$
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
    REVOKE ALL ON FUNCTION ${q}.${table}() FROM PUBLIC`,
    );
    const trigger = schema + "_" + name.replace(/^source_/, "").slice(0, 20);
    await client.query(
      `CREATE TRIGGER ${
        sqlIdentifier(trigger)
      } AFTER INSERT OR UPDATE OR DELETE ON public.${
        sqlIdentifier(source.table)
      } FOR EACH ROW EXECUTE FUNCTION ${q}.${table}()`,
    );
    await client.query(
      `CREATE TRIGGER ${sqlIdentifier(trigger + "_trunc")} AFTER TRUNCATE ON public.${
        sqlIdentifier(source.table)
      } FOR EACH STATEMENT EXECUTE FUNCTION ${q}.${table}()`,
    );
  }
  await protectSources(client, schema);
}

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

// Materialize shared or aggregating intermediate views so RisingWave computes
// multi-consumer subgraphs once and finalizes aggregates before downstream
// joins instead of cascading O(N^2) backfill retractions.
function promoteIntermediateViews(sql: string): string {
  if (!sql.includes(";")) return sql;
  const stmts = splitStatements(sql);
  const parsed = stmts.map((stmt) => {
    const lead = /^(?:(?:\s*--[^\n]*\n)|\s)*/.exec(stmt)?.[0] ?? "";
    const rest = stmt.slice(lead.length);
    const m = /^CREATE\s+VIEW(\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s+([\s\S]*))$/i
      .exec(rest);
    return m ? { lead, suffix: m[1], name: m[2], body: m[3] } : null;
  });
  return stmts.map((stmt, idx) => {
    const view = parsed[idx];
    if (!view) return `${stmt};`;
    const downstream = stmts.slice(idx + 1).join(";\n");
    const refs = [
      ...downstream.matchAll(new RegExp(`\\b${view.name}\\b`, "gi")),
    ].length;
    const hasSetDedup = /\b(UNION\s+(?!ALL\b)|SELECT\s+DISTINCT)\b/i.test(
      view.body,
    );
    const hasPlainAgg = !/\bJOIN\b/i.test(view.body) &&
      /\b(GROUP\s+BY|HAVING|SUM\s*\(|COUNT\s*\(|MIN\s*\(|MAX\s*\()/i.test(
        view.body,
      );
    const hasValues = /\bVALUES\s*\(/i.test(view.body);
    if ((refs >= 2 || hasSetDedup || hasPlainAgg) && !hasValues) {
      return `${view.lead}CREATE MATERIALIZED VIEW${view.suffix};`;
    }
    return `${stmt};`;
  }).join("\n");
}

export function nativeSql(
  program: IncrementalProgram,
  schema?: string,
  publications?: Record<string, string>,
  cdcConfig?: NativeCdcSourceConfig,
): string {
  if ((schema === undefined) !== (publications === undefined)) {
    throw new Error("incomplete native connector configuration");
  }
  if (schema !== undefined) sqlIdentifier(schema);
  let sql = promoteIntermediateViews(translateRisingWaveSql(program.sql));
  let sharedSourceDdl = "";
  if (schema !== undefined && publications !== undefined) {
    const firstPub = Object.values(publications)[0];
    if (firstPub !== undefined) sqlIdentifier(firstPub);
    if (cdcConfig) {
      sqlIdentifier(cdcConfig.slot);
      sqlIdentifier(cdcConfig.publication);
      const parsed = new URL(cdcConfig.uri);
      const host = parsed.hostname || "127.0.0.1";
      const port = parsed.port || "5432";
      const user = decodeURIComponent(parsed.username || "postgres");
      const pass = decodeURIComponent(parsed.password || "");
      const db = parsed.pathname.replace(/^\//, "") || "postgres";
      sharedSourceDdl = `CREATE SOURCE pg_shared_source WITH (
  connector = 'postgres-cdc',
  hostname = ${sqlString(host)},
  port = ${sqlString(port)},
  username = ${sqlString(user)},
  password = ${sqlString(pass)},
  database.name = ${sqlString(db)},
  schema.name = ${sqlString(schema)},
  slot.name = ${sqlString(cdcConfig.slot)},
  publication.name = ${sqlString(cdcConfig.publication)},
  publication.create.enable = 'false',
  transactional = 'true'
);\n`;
    } else if (firstPub !== undefined) {
      sharedSourceDdl = `CREATE SOURCE pg_shared_source WITH (
  connector = 'postgres-cdc',
  schema.name = ${sqlString(schema)},
  publication.name = ${sqlString(firstPub)},
  publication.create.enable = 'false',
  transactional = 'true'
);\n`;
    }
  }
  for (const [name, input] of Object.entries(program.inputs)) {
    sqlIdentifier(name);
    const publication = publications?.[name];
    if (publications !== undefined && publication === undefined) {
      throw new Error(`missing native publication ${name}`);
    }
    if (publication !== undefined) sqlIdentifier(publication);
    const fields = input.fields.map((f) =>
      `${sqlIdentifier(f.name)} ${risingWaveType(f.type)}`
    ).join(",");
    // Keep snapshot_read_full_table open across barriers; snapshot.interval = 1
    // cancels every LIMIT batch after one 256-row chunk via consume_snapshot_stream_once.
    const sourceClause = schema === undefined
      ? ""
      : ` WITH (snapshot.interval = 100000, snapshot.batch_size = 10000) FROM pg_shared_source TABLE '${schema}.${name}'`;
    const declaration = new RegExp(`CREATE TABLE ${name}\\s*\\([^;]*\\);`, "g");
    if ([...sql.matchAll(declaration)].length !== 1) {
      throw new Error(`missing unique source declaration ${name}`);
    }
    sql = sql.replace(
      declaration,
      `CREATE TABLE cdc_${name} (__key VARCHAR PRIMARY KEY,${fields})${sourceClause};\nCREATE VIEW ${name} AS SELECT ${
        input.fields.map((f) => sqlIdentifier(f.name)).join(",")
      } FROM cdc_${name};`,
    );
  }
  sql = sharedSourceDdl + sql;
  for (const [name, output] of Object.entries(program.outputs)) {
    sqlIdentifier(name);
    const partition = program.incremental.outputs[name];
    if (!partition) throw new Error(`missing native partition ${name}`);
    if (
      output.fields.some((f) =>
        f.name === "__rw_mult" || f.name === "__rw_delta_weight"
      )
    ) {
      throw new Error(`reserved native delta column on ${name}`);
    }
    const fields = output.fields.map((f) =>
      `${sqlIdentifier(f.name)} ${risingWaveType(f.type)}`
    ).join(",");
    const columns = ["__partition", ...output.fields.map((f) => f.name)].map(
      sqlIdentifier,
    ).join(",");
    sql += `\nCREATE TABLE captured_${name} (__key VARCHAR PRIMARY KEY,__rw_mult BIGINT NOT NULL,__partition VARCHAR,${fields});
      CREATE VIEW stream_${name} AS SELECT ${columns} FROM (${
      translateRisingWaveSql(partition.partitionQuery)
    }) UNION ALL SELECT ${columns} FROM captured_${name} WHERE false;
      CREATE MATERIALIZED VIEW pending_${name} AS SELECT ${columns},CAST(SUM(__rw_delta_weight) AS BIGINT) AS __rw_mult FROM (SELECT ${columns},CAST(1 AS BIGINT) AS __rw_delta_weight FROM stream_${name} UNION ALL SELECT ${columns},-__rw_mult AS __rw_delta_weight FROM captured_${name}) __rw_bag GROUP BY ${columns} HAVING SUM(__rw_delta_weight) <> 0;`;
  }
  for (const [name, query] of Object.entries(program.incremental.checks ?? {})) {
    sqlIdentifier(name);
    sql += `\nCREATE MATERIALIZED VIEW invalid_${name} AS ${
      translateRisingWaveSql(query)
    };`;
  }
  return sql;
}

const GLOBAL_PARTITION_QUERY =
  /^\s*SELECT\s+(?:''|CAST\(\s*''\s+AS\s+VARCHAR(?:\(\d+\))?\s*\))\s+AS\s+"?__partition"?\s*,/i;

export function isGlobalIncrementalProgram(
  program: Partial<IncrementalProgram> | null | undefined,
): boolean {
  const outputs = Object.values(program?.incremental?.outputs ?? {});
  return outputs.length > 0 &&
    outputs.every((out) => GLOBAL_PARTITION_QUERY.test(out.partitionQuery));
}
