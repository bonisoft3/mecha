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
  source: string;
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
      !options.version || !options.spec.name || !options.source ||
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
  async capture(): Promise<BoundedCapture> {
    const manifest = this.manifest();
    const digest = createHash("sha256");
    digest.update(`${this.options.version}\0`);
    const held = await database(this.path(manifest, "capture"));
    const { con } = held;
    try {
      await con.run("CREATE SCHEMA duckstream_private");
      if (this.options.reads.length) {
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
    const cage = new StepCage({
      file: this.options.spec.steps ?? this.options.spec.file,
      source: this.options.source,
      endowments: this.options.spec.endowments ?? [],
    });
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
        const step = await cage.advance({
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
        }, checkpoint);
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
      cage.close();
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
