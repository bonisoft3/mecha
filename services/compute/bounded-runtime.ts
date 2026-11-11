import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  type DuckDBConnection,
  DuckDBInstance,
} from "npm:@duckdb/node-api@1.5.6-r.1";
import {
  EXTENSIONS,
  readerOf,
  type Row,
  seedOf,
  type Spec,
  stem,
} from "./main.ts";
import { type Runner, strictJson } from "./workers.ts";
import { validateSchemas } from "./portable.ts";
import { type StagedQueries } from "./query-stages.ts";
import { StepCage } from "./step-cage.ts";
import {
  encodeWasmQueryInput,
  scratchStatement,
  validateQueryAst,
  WASM_QUERY_INPUT_BYTES,
  type WasmQueryInput,
} from "../../packages/compute-snapshot/src/bounded.ts";

export interface BoundedCapture {
  id: string;
  version: string;
  name: string;
  digest?: string;
}
export interface BoundedOutput extends BoundedCapture {
  capture: BoundedCapture;
}
export interface BoundedOptions {
  spec: Spec;
  version: string;
  source?: string;
  computation?: { calculate(value: unknown): Promise<unknown> };
  databaseUrl: string;
  directory: string;
  runner: Pick<Runner, "run">;
  reads: string[];
  queries: Record<string, string>;
  queryStages?: StagedQueries;
}
const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const utf8 = new TextEncoder();
const bytes = (value: string) => utf8.encode(value).length;
const parse = (value: unknown): Row => {
  const row = JSON.parse(String(value));
  strictJson(row);
  return row;
};
const replicaLocks = new Map<string, Promise<void>>();

async function withReplicaLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = replicaLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const done = next.then(() => undefined, () => undefined);
  replicaLocks.set(key, done);
  try {
    return await next;
  } finally {
    if (replicaLocks.get(key) === done) replicaLocks.delete(key);
  }
}

async function database(path: string, readonly = false) {
  const db = await DuckDBInstance.create(path, {
    memory_limit: "512MiB",
    threads: "1",
    extension_directory: EXTENSIONS,
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
    ...(readonly ? { access_mode: "READ_ONLY" } : { temp_directory: `${path}.tmp` }),
  });
  const con = await db.connect();
  await con.run("SET TimeZone='UTC'");
  await con.run("SET preserve_insertion_order=false");
  let closed = false;
  return {
    db,
    con,
    close() {
      if (closed) return;
      closed = true;
      con.closeSync();
      db.closeSync();
    },
  };
}

async function validateQuery(con: DuckDBConnection, sql: string) {
  const result = await con.runAndReadAll(
    "SELECT json_serialize_sql(CAST(? AS VARCHAR)) AS ast",
    [sql],
  );
  validateQueryAst(JSON.parse(String(result.getRowObjects()[0].ast)));
}

/** Retained captures outlive processes; calculations own separate disposable databases. */
export class BoundedRuntime {
  private constructor(
    private readonly options: BoundedOptions,
    private readonly seed: number,
  ) {}
  static async create(options: BoundedOptions): Promise<BoundedRuntime> {
    if (
      !options.version || !options.spec.name || (!options.source && !options.computation) ||
      [...options.reads, ...Object.keys(options.queries), ...options.spec.to]
        .some((name) => !identifier.test(name))
    ) {
      throw new Error("invalid bounded computation declarations");
    }
    validateSchemas(
      options.spec.types,
      options.spec.queryTypes,
      Object.keys(options.queries),
    );
    validateSchemas(
      options.spec.types,
      options.spec.sinkTypes,
      options.spec.to,
      true,
    );
    await Deno.mkdir(options.directory, { recursive: true });
    return new BoundedRuntime({
      ...options,
      directory: resolve(options.directory),
    }, await seedOf(options.spec.name));
  }
  private manifest(): BoundedCapture {
    return {
      id: crypto.randomUUID(),
      version: this.options.version,
      name: this.options.spec.name,
    };
  }
  private path(value: BoundedCapture, kind: "capture" | "output") {
    if (
      !value || !uuid.test(value.id) ||
      value.version !== this.options.version ||
      value.name !== this.options.spec.name
    ) {
      throw new Error("invalid bounded manifest");
    }
    return join(this.options.directory, `${kind}-${value.id}.duckdb`);
  }
  private replicaPath() {
    return join(this.options.directory, "replica.duckdb");
  }
  private syncReplica(): Promise<boolean> {
    return BoundedRuntime.syncReplica(
      this.options.directory,
      this.options.databaseUrl,
      this.options.reads,
    );
  }
  async hasCapture(value: BoundedCapture): Promise<boolean> {
    try {
      const info = await Deno.stat(this.path(value, "capture"));
      return info.isFile && info.size > 0;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }
  static async syncReplica(
    directory: string,
    databaseUrl: string,
    reads: readonly string[],
    maxFenceAttempts = 500,
  ): Promise<boolean> {
    if (!databaseUrl || !reads.length) return false;
    return await withReplicaLock(directory, async () => {
      const path = join(directory, "replica.duckdb");
      const replica = await database(path);
      const { con } = replica;
      let usedReplica = false;
      try {
        await con.run("LOAD postgres");
        await con.run(
          `ATTACH ${
            literal(databaseUrl)
          } AS pg (TYPE postgres, READ_ONLY, ISOLATION_LEVEL 'REPEATABLE READ')`,
        );
        const [{ has_source: hasSource, has_duckpipe: hasDuckpipe }] =
          await readerOf(con).query(
            `SELECT
              count(*) FILTER (WHERE schema_name='compute' AND table_name='source')::INTEGER AS has_source,
              count(*) FILTER (WHERE schema_name='duckpipe' AND table_name='table_mappings')::INTEGER AS has_duckpipe
             FROM duckdb_tables() WHERE database_name='pg'`,
          );
        if (!Number(hasSource)) {
          await con.run("DETACH pg");
          return false;
        }
        usedReplica = true;
        const list = reads.map(literal).join(",");
        await con.run("CREATE SCHEMA IF NOT EXISTS duckstream_replica");
        await con.run(
          `CREATE TABLE IF NOT EXISTS duckstream_replica.watermarks (
            table_name VARCHAR PRIMARY KEY,
            revision BIGINT NOT NULL,
            lsn VARCHAR NOT NULL,
            wal_seq BIGINT NOT NULL,
            wal_count BIGINT NOT NULL,
            schema_sig VARCHAR NOT NULL,
            seeded_count BIGINT NOT NULL DEFAULT 0,
            incremental_count BIGINT NOT NULL DEFAULT 0
          )`,
        );
        if (Number(hasDuckpipe)) {
          for (let attempt = 0; attempt < maxFenceAttempts; attempt++) {
            await con.run("BEGIN");
            const lagging = await readerOf(con).query(
              `SELECT * FROM postgres_query('pg', ${
                literal(`
                SELECT s.name, m.state
                FROM compute.source s
                JOIN duckpipe.table_mappings m ON m.source_schema='public' AND m.source_table=s.name
                WHERE s.name IN (${list})
                  AND (m.state <> 'STREAMING' OR m.applied_lsn IS NULL OR m.applied_lsn < s.lsn)
              `)
              })`,
            );
            if (!lagging.length) break;
            await con.run("ROLLBACK");
            if (attempt === 0) {
              await con.run(
                "CALL postgres_execute('pg', 'DO $$ BEGIN IF to_regprocedure(''duckpipe.start_worker()'') IS NOT NULL THEN PERFORM duckpipe.start_worker(); END IF; END $$')",
              );
            }
            if (attempt === maxFenceAttempts - 1) {
              throw new Error("duckpipe replica did not reach target LSN fence");
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        } else {
          await con.run("BEGIN");
        }
        const sourceRows = await readerOf(con).query(
          `SELECT name, revision::BIGINT AS revision, lsn::VARCHAR AS lsn, wal_seq::BIGINT AS wal_seq
           FROM pg.compute.source WHERE name IN (${list})`,
        );
        const sources = new Map(
          sourceRows.map((row) => [
            String(row.name),
            {
              revision: Number(row.revision),
              lsn: String(row.lsn),
              walSeq: Number(row.wal_seq),
            },
          ]),
        );
        const wmRows = await readerOf(con).query(
          `SELECT table_name, revision, lsn, wal_seq, wal_count, schema_sig, seeded_count, incremental_count
           FROM duckstream_replica.watermarks WHERE table_name IN (${list})`,
        );
        const watermarks = new Map(
          wmRows.map((row) => [
            String(row.table_name),
            {
              revision: Number(row.revision),
              lsn: String(row.lsn),
              walSeq: Number(row.wal_seq),
              walCount: Number(row.wal_count),
              schemaSig: String(row.schema_sig),
              seededCount: Number(row.seeded_count),
              incrementalCount: Number(row.incremental_count),
            },
          ]),
        );
        const metaRows = await readerOf(con).query(
          `SELECT * FROM postgres_query('pg', ${
            literal(`
            SELECT c.relname AS table_name,
              coalesce(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum), '') AS schema_sig,
              coalesce(
                (SELECT string_agg(pa.attname, ',' ORDER BY pa.attnum)
                 FROM pg_index i JOIN pg_attribute pa ON pa.attrelid = c.oid AND pa.attnum = ANY(i.indkey)
                 WHERE i.indrelid = c.oid AND i.indisprimary),
                ''
              ) AS pk_cols,
              coalesce(string_agg(a.attname, ',' ORDER BY a.attnum), '') AS col_names
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            WHERE n.nspname = 'public' AND c.relname IN (${list})
            GROUP BY c.oid, c.relname
          `)
          })`,
        );
        const catalogMeta = new Map(
          metaRows.map((row) => [
            String(row.table_name),
            {
              schemaSig: String(row.schema_sig),
              pkCols: String(row.pk_cols),
              colNames: String(row.col_names),
            },
          ]),
        );
        const duckpipeMapped = new Set<string>();
        if (Number(hasDuckpipe)) {
          const mappedRows = await readerOf(con).query(
            `SELECT source_table::VARCHAR AS name FROM pg.duckpipe.table_mappings
             WHERE source_schema = 'public' AND source_table IN (${list})`,
          );
          for (const row of mappedRows) duckpipeMapped.add(String(row.name));
        }
        for (const name of reads) {
          const source = sources.get(name);
          const meta = catalogMeta.get(name);
          const wm = watermarks.get(name);
          if (!source || !meta || !meta.colNames) {
            await con.run(
              `CREATE OR REPLACE TABLE main.${quote(name)} AS SELECT * FROM pg.public.${quote(name)}`,
            );
            continue;
          }
          if (duckpipeMapped.has(name)) {
            if (
              wm && wm.schemaSig === meta.schemaSig &&
              wm.revision === source.revision && wm.lsn === source.lsn
            ) {
              continue;
            }
            const cols = meta.colNames.split(",").map(quote).join(", ");
            await con.run(
              `CREATE OR REPLACE TABLE main.${quote(name)} AS SELECT ${cols} FROM pg.public.${
                quote(`${name}_ducklake`)
              }`,
            );
            await con.run(
              "INSERT OR REPLACE INTO duckstream_replica.watermarks VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              [
                name,
                source.revision,
                source.lsn,
                source.walSeq,
                0,
                meta.schemaSig,
                (wm?.seededCount ?? 0) + (wm ? 0 : 1),
                (wm?.incrementalCount ?? 0) + (wm ? 1 : 0),
              ],
            );
            continue;
          }
          if (wm && wm.schemaSig === meta.schemaSig && source.walSeq >= wm.walSeq) {
            const [{ n: hasAnchor }] = wm.walSeq > 0
              ? await readerOf(con).query(
                `SELECT count(*)::BIGINT AS n FROM pg.compute.wal
                 WHERE table_name = ${literal(name)} AND seq = ${wm.walSeq}`,
              )
              : [{ n: 1n }];
            if (
              wm.revision === source.revision &&
              wm.walSeq === source.walSeq &&
              wm.lsn === source.lsn &&
              Number(hasAnchor) === wm.walCount
            ) {
              continue;
            }
            if (source.walSeq > wm.walSeq && Number(hasAnchor) === wm.walCount) {
              const walEntries = await readerOf(con).query(
                `SELECT seq::BIGINT AS seq, op::VARCHAR AS op
                 FROM pg.compute.wal
                 WHERE table_name = ${literal(name)}
                   AND seq > ${wm.walSeq}
                   AND seq <= ${source.walSeq}
                 ORDER BY seq`,
              );
              if (walEntries.length > 0 && walEntries.length <= 4096) {
                let deltaEntries = walEntries;
                const lastTruncate = walEntries.findLastIndex((e) =>
                  String(e.op) === "T"
                );
                if (lastTruncate >= 0) {
                  await con.run(`DELETE FROM main.${quote(name)}`);
                  deltaEntries = walEntries.slice(lastTruncate + 1);
                }
                if (deltaEntries.length > 0) {
                  const seqs = deltaEntries.map((e) => Number(e.seq));
                  const cols = meta.colNames.split(",").map(quote);
                  const pks = meta.pkCols
                    ? meta.pkCols.split(",").map(quote)
                    : [];
                  await con.run(
                    `CREATE OR REPLACE TEMP TABLE __duckstream_wal_batch AS
                     SELECT * FROM postgres_query('pg', ${
                      literal(`
                       SELECT w.seq AS __duckstream_wal_seq, w.op::text AS __duckstream_wal_op,
                         (jsonb_populate_record(NULL::public.${quote(name)}, w.row_data)).*
                       FROM compute.wal w
                       WHERE w.seq = ANY(ARRAY[${seqs.join(",")}]::bigint[])
                       ORDER BY w.seq
                     `)
                    })`,
                  );
                  if (pks.length > 0) {
                    await con.run(
                      `DELETE FROM main.${quote(name)} AS t
                       USING __duckstream_wal_batch AS w
                       WHERE ${
                        pks.map((pk) => `t.${pk} IS NOT DISTINCT FROM w.${pk}`)
                          .join(" AND ")
                      }`,
                    );
                    await con.run(
                      `INSERT INTO main.${quote(name)} (${cols.join(", ")})
                       SELECT ${cols.join(", ")}
                       FROM (
                         SELECT *, row_number() OVER (
                           PARTITION BY ${pks.join(", ")}
                           ORDER BY __duckstream_wal_seq DESC
                         ) AS __duckstream_rn
                         FROM __duckstream_wal_batch
                       )
                       WHERE __duckstream_rn = 1 AND __duckstream_wal_op = 'I'`,
                    );
                  } else {
                    for (const entry of deltaEntries) {
                      const seq = Number(entry.seq);
                      if (String(entry.op) === "D") {
                        await con.run(
                          `DELETE FROM main.${quote(name)}
                           WHERE rowid = (
                             SELECT t.rowid FROM main.${quote(name)} t, __duckstream_wal_batch w
                             WHERE w.__duckstream_wal_seq = ${seq}
                               AND ${
                            cols.map((c) => `t.${c} IS NOT DISTINCT FROM w.${c}`)
                              .join(" AND ")
                          }
                             LIMIT 1
                           )`,
                        );
                      } else if (String(entry.op) === "I") {
                        await con.run(
                          `INSERT INTO main.${quote(name)} (${cols.join(", ")})
                           SELECT ${cols.join(", ")}
                           FROM __duckstream_wal_batch
                           WHERE __duckstream_wal_seq = ${seq}`,
                        );
                      }
                    }
                  }
                  await con.run("DROP TABLE __duckstream_wal_batch");
                }
                await con.run(
                  "INSERT OR REPLACE INTO duckstream_replica.watermarks VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                  [
                    name,
                    source.revision,
                    source.lsn,
                    source.walSeq,
                    1,
                    meta.schemaSig,
                    wm.seededCount,
                    wm.incrementalCount + 1,
                  ],
                );
                continue;
              }
            }
          }
          await con.run(
            `CREATE OR REPLACE TABLE main.${quote(name)} AS SELECT * FROM pg.public.${quote(name)}`,
          );
          const [{ n: hasSourceAnchor }] = source.walSeq > 0
            ? await readerOf(con).query(
              `SELECT count(*)::BIGINT AS n FROM pg.compute.wal
               WHERE table_name = ${literal(name)} AND seq = ${source.walSeq}`,
            )
            : [{ n: 1n }];
          await con.run(
            "INSERT OR REPLACE INTO duckstream_replica.watermarks VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
              name,
              source.revision,
              source.lsn,
              source.walSeq,
              Number(hasSourceAnchor),
              meta.schemaSig,
              (wm?.seededCount ?? 0) + 1,
              wm?.incrementalCount ?? 0,
            ],
          );
        }
        await con.run("COMMIT");
        await con.run("DETACH pg");
        await con.run("CHECKPOINT");
        return true;
      } finally {
        replica.close();
        await removeOwned(`${path}.tmp`);
        if (!usedReplica) {
          for (const suffix of ["", ".wal"]) await removeOwned(`${path}${suffix}`);
        }
      }
    });
  }
  async capture(): Promise<BoundedCapture> {
    const manifest = this.manifest();
    const digest = createHash("sha256");
    digest.update(`${this.options.version}\0`);
    const syncedReplica = this.options.reads.length
      ? await this.syncReplica()
      : false;
    const held = await database(this.path(manifest, "capture"));
    const { con } = held;
    try {
      await con.run("CREATE SCHEMA duckstream_private");
      if (this.options.reads.length) {
        if (syncedReplica) {
          await con.run(
            `ATTACH ${literal(this.replicaPath())} AS __duckstream_replica (READ_ONLY)`,
          );
          for (const name of this.options.reads) {
            await con.run(
              `CREATE TABLE ${quote(name)} AS SELECT * FROM __duckstream_replica.main.${
                quote(name)
              }`,
            );
          }
          await con.run("DETACH __duckstream_replica");
        } else {
          await con.run("LOAD postgres");
          await con.run(
            `ATTACH ${
              literal(this.options.databaseUrl)
            } AS pg (TYPE postgres, READ_ONLY, ISOLATION_LEVEL 'REPEATABLE READ')`,
          );
          await con.run("BEGIN");
          for (const name of this.options.reads) {
            await con.run(
              `CREATE TABLE ${quote(name)} AS SELECT * FROM pg.public.${
                quote(name)
              }`,
            );
          }
          await con.run("COMMIT");
          await con.run("DETACH pg");
        }
      }
      for (const [name, original] of Object.entries(this.options.queries)) {
        digest.update(`${name}\0`);
        const rowHashes: string[] = [];
        const plan = this.options.queryStages?.[name];
        for (const stage of plan?.stages ?? []) {
          await con.run(`CREATE TABLE ${quote(stage.name)} AS ${stage.sql}`);
        }
        const sql = plan?.sql ?? original;
        const target = `duckstream_private.${quote(`result_${name}`)}`;
        const fields = this.options.spec.queryTypes?.[name];
        const prepared = await con.prepare(sql);
        let position = "__duckstream_position";
        try {
          const columns = new Set(
            Array.from(
              { length: prepared.columnCount },
              (_, index) => prepared.columnName(index),
            ),
          );
          while (columns.has(position)) position += "_";
        } finally {
          prepared.destroySync();
        }
        const ordinal = quote(position);
        await con.run(
          `CREATE TABLE duckstream_private.raw_input AS SELECT row_number() OVER ()::BIGINT AS ${ordinal},r.* FROM (${sql}) r`,
        );
        await con.run(`CREATE TABLE ${target}(sequence BIGINT,value VARCHAR)`);
        const oversized = await readerOf(con).query(
          "SELECT 1 AS oversized FROM duckstream_private.raw_input r WHERE octet_length(encode(to_json(r)::VARCHAR))>1048576 LIMIT 1",
        );
        if (oversized.length) throw new Error("capture row exceeds byte limit");
        let offset = 0;
        await con.run("BEGIN");
        for (;;) {
          const [page] = await readerOf(con).query(
            `SELECT count(*)::INTEGER AS n FROM (
              SELECT ${ordinal},sum(octet_length(encode(to_json(r)::VARCHAR))) OVER (ORDER BY ${ordinal}) AS size
              FROM (SELECT * FROM duckstream_private.raw_input LIMIT 4096 OFFSET ${offset}) r
            ) WHERE size<=524288 OR ${ordinal}=${offset + 1}`,
          );
          const rows = await readerOf(con).query(
            `SELECT * EXCLUDE (${ordinal}) FROM duckstream_private.raw_input LIMIT ${
              Number(page.n)
            } OFFSET ${offset}`,
            fields ? { fields, types: this.options.spec.types! } : undefined,
          );
          if (!rows.length) break;
          const encodedRows = rows.map((row) => strictJson(row));
          for (const encoded of encodedRows) {
            rowHashes.push(createHash("sha256").update(encoded).digest("hex"));
          }
          const json = `[${encodedRows.join(",")}]`;
          if (bytes(json) > 2 * 1024 * 1024) {
            throw new Error("capture page exceeds byte limit");
          }
          await con.run(
            `INSERT INTO ${target} SELECT CAST(? AS BIGINT)+CAST(key AS BIGINT)+1,value::VARCHAR FROM json_each(CAST(? AS JSON))`,
            [offset, json],
          );
          offset += rows.length;
        }
        await con.run("COMMIT");
        rowHashes.sort();
        for (const rowHash of rowHashes) {
          digest.update(rowHash);
          digest.update("\n");
        }
        digest.update("\0");
        await con.run("DROP TABLE duckstream_private.raw_input");
        for (const stage of plan?.stages ?? []) {
          await con.run(`DROP TABLE ${quote(stage.name)}`);
        }
      }
      await con.run("CHECKPOINT");
    } catch (error) {
      held.close();
      for (const suffix of ["", ".wal", ".tmp"]) {
        await removeOwned(this.path(manifest, "capture") + suffix);
      }
      throw error;
    } finally {
      held.close();
      await removeOwned(this.path(manifest, "capture") + ".tmp");
    }
    await Deno.chmod(this.path(manifest, "capture"), 0o400);
    Object.defineProperty(manifest, "digest", {
      value: digest.digest("hex"),
      enumerable: false,
    });
    return manifest;
  }
  private async query(con: DuckDBConnection, sql: string): Promise<Row[]> {
    await validateQuery(con, sql);
    const rows = await readerOf(con).query(
      `WITH execution_page AS MATERIALIZED (SELECT * FROM (${sql}) r LIMIT 4097)
       SELECT * FROM execution_page WHERE (
         SELECT CASE WHEN count(*)>4096 OR
           coalesce(sum(octet_length(encode(to_json(r)::VARCHAR))),0)+count(*)+2>1048576
         THEN error('execution query exceeds page limit') ELSE true END
         FROM execution_page r
       )`,
    );
    if (bytes(strictJson(rows)) > 1024 * 1024) {
      throw new Error("execution query exceeds page limit");
    }
    return rows;
  }
  async calculate(capture: BoundedCapture): Promise<BoundedOutput> {
    const input = this.path(capture, "capture");
    await Deno.stat(input);
    const output = { ...this.manifest(), capture };
    const held = await database(this.path(output, "output"));
    const { con } = held;
    const cage = this.options.source
      ? new StepCage({
        file: this.options.spec.steps ?? this.options.spec.file,
        source: this.options.source,
        endowments: this.options.spec.endowments ?? [],
      })
      : null;
    const owned = new Set<string>();
    const fields = new Map<string, string>();
    const allowed = new Set(this.options.spec.wasm.map(stem));
    let completed = false;
    let jobs = 0;
    const wasm = async (name: string, input: string) => {
      if (!allowed.has(name)) {
        throw new Error(`undeclared WASM module: ${name}`);
      }
      if (++jobs > 1) {
        throw new Error("a bounded step runs at most one WASM job");
      }
      if (bytes(input) > WASM_QUERY_INPUT_BYTES) {
        throw new Error("WASM input exceeds byte limit");
      }
      return (await this.options.runner.run([{ wasm: name, input }]))[0];
    };
    try {
      await con.run(`ATTACH ${literal(input)} AS captured (READ_ONLY)`);
      await con.run("SET enable_external_access=false");
      await con.run("CREATE SCHEMA duckstream_private");
      for (const name of Object.keys(this.options.queries)) {
        await con.run(
          `CREATE VIEW duckstream_private.${
            quote(`result_${name}`)
          } AS SELECT * FROM captured.duckstream_private.${
            quote(`result_${name}`)
          }`,
        );
      }
      await con.run("CREATE SEQUENCE duckstream_private.output_seq");
      await con.run(
        "CREATE TABLE duckstream_private.outputs(seq BIGINT DEFAULT nextval('duckstream_private.output_seq'),sink VARCHAR,id VARCHAR,value VARCHAR)",
      );
      let checkpoint: unknown = null;
      let steps = 0;
      for (;;) {
        jobs = 0;
        const step = cage
          ? await cage.advance({
            seed: this.seed,
            query: (sql: string) => this.query(con, sql),
            wasm: (name: string, value: unknown) => wasm(name, strictJson(value)),
            wasmFromQuery: async (
              name: string,
              value: unknown,
              query: WasmQueryInput,
            ) => {
              const encoded = await encodeWasmQueryInput(
                value,
                query,
                async (after) => {
                  const rows = await this.query(
                    con,
                    `SELECT unnest(p.item) FROM (
                      SELECT struct_pack(*COLUMNS(*)) AS item,
                        sum(octet_length(encode(to_json(struct_pack(*COLUMNS(*)))::VARCHAR))+1)
                        OVER (ORDER BY r.${quote(query.orderBy)} ROWS UNBOUNDED PRECEDING) AS total
                      FROM (SELECT * FROM (${query.sql}) r WHERE ${
                      quote(query.orderBy)
                    } > ${after} ORDER BY ${quote(query.orderBy)} LIMIT 4096) r
                    ) p WHERE CASE WHEN p.total>1048574 AND
                      p.total=octet_length(encode(to_json(p.item)::VARCHAR))+1
                      THEN error('execution query row exceeds page limit')
                      ELSE p.total<=1048574 END ORDER BY p.item.${quote(query.orderBy)}`,
                  );
                  let next = after;
                  const values = rows.map((row) => {
                    const position = row[query.orderBy];
                    if (
                      !Number.isSafeInteger(position) || Number(position) <= next
                    ) throw new Error("invalid WASM query order");
                    next = Number(position);
                    const result = { ...row };
                    delete result[query.orderBy];
                    return result;
                  });
                  return { after, next, done: rows.length === 0, rows: values };
                },
              );
              return wasm(name, new TextDecoder().decode(encoded));
            },
          }, checkpoint)
          : await (async () => {
            const inputs: Record<string, Row[]> = {};
            for (const name of Object.keys(this.options.queries)) {
              const result = await con.runAndReadAll(
                `SELECT value FROM duckstream_private.${quote(`result_${name}`)} ORDER BY sequence`,
              );
              inputs[name] = result.getRowObjects().map((row) => parse(row.value));
            }
            const writes = await this.options.computation!.calculate(inputs);
            if (!writes || typeof writes !== "object" || Array.isArray(writes)) {
              throw new Error("invalid execution step");
            }
            return {
              done: true,
              checkpoint: null,
              writes: writes as Record<string, Row[]>,
            } as {
              done: boolean;
              checkpoint: unknown;
              writes: Record<string, Row[]>;
              statements?: string[];
            };
          })();
        if (bytes(strictJson(step)) > 8 * 1024 * 1024) {
          throw new Error("execution step exceeds byte limit");
        }
        if (
          !step || typeof step.done !== "boolean" || !step.writes ||
          Array.isArray(step.writes)
        ) throw new Error("invalid execution step");
        await con.run("BEGIN");
        const statements = (step.statements ?? []).map(scratchStatement);
        const prepared: Awaited<ReturnType<DuckDBConnection["prepare"]>>[] = [];
        try {
          for (const statement of statements) {
            if (
              statement.operation !== "CREATE TABLE" &&
              !owned.has(statement.name)
            ) throw new Error("execution statement does not own scratch table");
            if (statement.select) await validateQuery(con, statement.select);
            prepared.push(await con.prepare(statement.sql));
          }
          for (const statement of prepared) await statement.run();
        } finally {
          for (const statement of prepared) statement.destroySync();
        }
        for (const statement of statements) {
          if (statement.operation === "CREATE TABLE") owned.add(statement.name);
          if (statement.operation === "DROP TABLE") {
            owned.delete(statement.name);
          }
        }
        for (const [sink, rows] of Object.entries(step.writes)) {
          if (!this.options.spec.to.includes(sink) || !Array.isArray(rows)) {
            throw new Error("undeclared execution sink or invalid rows");
          }
          const ids = new Set<string>();
          const values: [string, string][] = [];
          for (const row of rows) {
            if (
              !row || typeof row !== "object" || Array.isArray(row) ||
              typeof row.id !== "string" || ids.has(row.id)
            ) throw new Error("invalid execution output row");
            ids.add(row.id);
            const columns = JSON.stringify(Object.keys(row).sort());
            if (fields.has(sink) && fields.get(sink) !== columns) {
              throw new Error("execution output columns differ");
            }
            fields.set(sink, columns);
            const json = strictJson(row);
            if (bytes(json) + 2 > 256 * 1024) {
              throw new Error("execution output row exceeds byte limit");
            }
            values.push([row.id, json]);
          }
          if (values.length) {
            await con.run(
              "INSERT INTO duckstream_private.outputs(sink,id,value) SELECT ?,json_extract_string(value,'$[0]'),json_extract_string(value,'$[1]') FROM json_each(CAST(? AS JSON))",
              [sink, strictJson(values)],
            );
          }
        }
        await con.run("COMMIT");
        if (
          statements.some((s) => s.operation === "CREATE TABLE") ||
          ++steps % 64 === 0
        ) {
          await con.run("CHECKPOINT");
        }
        checkpoint = step.checkpoint;
        if (step.done) break;
      }
      for (const name of Object.keys(this.options.queries)) {
        await con.run(
          `DROP VIEW IF EXISTS duckstream_private.${quote(`result_${name}`)}`,
        );
      }
      await con.run("DETACH captured");
      for (const name of owned) {
        await con.run(`DROP TABLE IF EXISTS ${quote(name)}`);
      }
      await con.run("CHECKPOINT");
      await con.run(
        "CREATE TABLE duckstream_private.publication(sink VARCHAR,ordinal BIGINT,value VARCHAR)",
      );
      for (const sink of this.options.spec.to) {
        await con.run(
          "DELETE FROM duckstream_private.outputs WHERE sink=? AND seq NOT IN (SELECT max(seq) FROM duckstream_private.outputs WHERE sink=? GROUP BY id)",
          [sink, sink],
        );
        await con.run(
          "INSERT INTO duckstream_private.publication SELECT ?,row_number() OVER () AS ordinal,value FROM (SELECT value FROM duckstream_private.outputs WHERE sink=? ORDER BY id)",
          [sink, sink],
        );
        await con.run("DELETE FROM duckstream_private.outputs WHERE sink=?", [
          sink,
        ]);
        await con.run("CHECKPOINT");
      }
      await con.run("DROP TABLE duckstream_private.outputs");
      await con.run("DROP SEQUENCE duckstream_private.output_seq");
      await con.run("CHECKPOINT");
      completed = true;
      return output;
    } finally {
      cage?.close();
      held.close();
      const path = this.path(output, "output");
      await removeOwned(`${path}.tmp`);
      if (!completed) {
        for (const file of [path, `${path}.wal`]) {
          await removeOwned(file);
        }
      }
    }
  }
  async discard(output: BoundedOutput): Promise<void> {
    this.path(output.capture, "capture");
    const path = this.path(output, "output");
    for (const file of [path, `${path}.wal`, `${path}.tmp`]) {
      await removeOwned(file);
    }
  }
  async release(capture: BoundedCapture, output: BoundedOutput): Promise<void> {
    const input = this.path(capture, "capture");
    if (output.capture.id !== capture.id) {
      throw new Error("bounded output belongs to a different capture");
    }
    await this.discard(output);
    for (const file of [input, `${input}.wal`, `${input}.tmp`]) {
      await removeOwned(file);
    }
  }
  async *pages(output: BoundedOutput, sink: string): AsyncGenerator<Row[]> {
    this.path(output.capture, "capture");
    if (!this.options.spec.to.includes(sink)) {
      throw new Error("undeclared output sink");
    }
    const path = this.path(output, "output");
    await Deno.stat(path);
    const held = await database(path, true);
    try {
      let after = 0;
      for (;;) {
        const result = await held.con.runAndReadAll(
          "SELECT ordinal,value FROM duckstream_private.publication WHERE sink=? AND ordinal>? AND ordinal<=? ORDER BY ordinal",
          [sink, after, after + 4096],
        );
        const rows = result.getRowObjects();
        if (!rows.length) break;
        const page: Row[] = [];
        let size = 2;
        for (const row of rows) {
          const value = String(row.value);
          if (bytes(value) + 2 > 256 * 1024) {
            throw new Error("execution output row exceeds byte limit");
          }
          if (
            page.length &&
            (page.length >= 128 || size + bytes(value) + 1 > 256 * 1024)
          ) {
            yield page.splice(0);
            size = 2;
          }
          page.push(parse(value));
          size += bytes(value) + 1;
          after = Number(row.ordinal);
        }
        if (page.length) yield page;
      }
    } finally {
      held.close();
    }
  }
}

async function removeOwned(path: string): Promise<void> {
  try {
    const info = await Deno.lstat(path);
    if (info.isSymlink) {
      throw new Error("bounded storage must not contain symlinks");
    }
    await Deno.remove(path, { recursive: info.isDirectory });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** Run under the coordinator singleton before workers can create new captures. */
export async function collectBoundedFiles(
  directory: string,
  retained: readonly BoundedCapture[],
): Promise<void> {
  const root = resolve(directory);
  const keep = new Set<string>();
  for (const capture of retained) {
    if (
      !capture || !uuid.test(capture.id) || typeof capture.name !== "string" ||
      !capture.name || typeof capture.version !== "string" || !capture.version
    ) {
      throw new Error("invalid retained bounded manifest");
    }
    const name = `capture-${capture.id}.duckdb`;
    const info = await Deno.lstat(join(root, name));
    if (!info.isFile || info.isSymlink) {
      throw new Error("retained bounded capture must be a regular file");
    }
    keep.add(name);
  }
  const owned = /^(capture|output)-([0-9a-f-]+)\.duckdb(?:\.(wal|tmp))?$/;
  for await (const entry of Deno.readDir(root)) {
    const match = owned.exec(entry.name);
    if (!match || !uuid.test(match[2])) continue;
    const base = `${match[1]}-${match[2]}.duckdb`;
    if (keep.has(base)) continue;
    await removeOwned(join(root, entry.name));
  }
}
