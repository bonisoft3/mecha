// mecha compute: an app's numeric programs over the lake.
//
// A computation is one file of ES module text, importing nothing and
// exporting exactly:
//
//   reads    the tables it reads, copied into the lake from one Postgres
//            snapshot; what it reads changing is what reruns it;
//   queries  {name: SQL} over those tables in the lake. Each answers as an
//            array of plain row objects: numbers as numbers (a BIGINT or
//            HUGEINT beyond 2^53 fails the run), dates and times as DuckDB's
//            ISO 8601 text in UTC, lists and structs as arrays and objects.
//            Postgres's portable domains arrive as text, so a query casts.
//            Spec.queryTypes opts a query into the supplied portable type table;
//            its exact strings and validated values then replace the numeric
//            defaults above. Spec.sinkTypes validates every sink before writing;
//   plan     (inputs, seed, outputs) => [{wasm, input}]: the jobs, each one
//            call of a wasm module the computation ships, named by its file's
//            stem; outputs[i] is what job i wrote. The host runs the jobs past
//            those answered and asks again, until plan adds none, so a job
//            can take an earlier one's answer; the jobs already answered must
//            come back unchanged;
//   finish   (inputs, outputs) => {sink table: [rows]}.
//
// `inputs` is {query name: rows}, frozen, as are the outputs. `seed` is a
// 32-bit integer derived from the computation's name, so a replay is the
// same draw. plan and finish run in a fresh worker per run with no
// permissions and no globals beyond the language (cage.ts); either may answer
// a promise of its value, since Crypto's operations answer promises.
//
// The language is ES module text as SES 1.15's Compartment admits it, the
// text compiled by @endo/module-source (both as deno.json pins them):
//
//   - no `<!--` or `-->` anywhere in the text, strings and comments included,
//     so `while (n --> 0)` is refused; nor `import(` or `eval(`, spaced or
//     not, that is not a property's call (`(0, eval)(text)` evaluates in the
//     compartment, under these same rules);
//   - no top-level await: the module runs as a plain function;
//   - ECMAScript's globals as SES permits them (language.ts), so what SES
//     does not yet know, such as RegExp.escape or Error.isError, is absent;
//     less the clock, Math.random, and the host's time zone and locale;
//   - and past it, only what the computation declares in `endowments`
//     (language.ts's ENDOWABLE): Crypto, WebCrypto's operations that are
//     deterministic by their specification (crypto.ts), TextEncoder,
//     TextDecoder, URL, URLSearchParams and Cheerio. One used undeclared throws.
//
// The service loads every computation at startup and dies on one it refuses;
// admit.ts loads them as it does, for a lint to refuse them first.
//
// Cortex machines coalesce invalidations in PostgreSQL and invoke Durex work. A claimed run keeps its query inputs across retries; publication
// commits all sinks, the completion hook and the work receipt together. New
// invalidations remain pending while the claimed revision runs. The singleton
// coordinator fences access to the process-local lake and Wasm worker.
//
// Environment: DATABASE_URL, CDC_SLOT, LAKE_DIR, COMPUTATIONS (Spec[]), and
// SERVICE_JWT where the cluster has auth. Numerical work runs outside SQL
// transactions; sink writes retain the service role's policies and triggers.

import pg from "pg";
import { NativeRuntime } from "./native-runtime.ts";
import { compilationProfile } from "./native-feldera.ts";
import { reconcileNativeResources } from "./native-cleanup.ts";
import type { BatchSpec } from "./batches.ts";
import { Feldera, type FelderaProgram } from "./feldera.ts";
import { publish } from "./publication.ts";
import { type SinkWrites, validateSinkWrites } from "../../packages/compute-snapshot/src/sink-writes.ts";
import { PostgresJobCache } from "./job-cache.ts";
import type { TypeTable } from "@mecha/client/types";
import { bindBoundary, portableQuery, type TypeBoundary, type TypeSchemas, validateSchemas } from "./portable.ts";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  arrayFromArrayValue,
  arrayFromListValue,
  booleanFromValue,
  createDuckDBValueConverter,
  doubleFromDecimalValue,
  type DuckDBConnection,
  DuckDBInstance,
  DuckDBTimestampTZValue,
  DuckDBTypeId,
  type DuckDBValueConverter,
  nullConverter,
  numberFromValue,
  objectFromStructValue,
  stringFromValue,
} from "@duckdb/node-api";
import type { ModuleSource } from "@endo/module-source";
import { admit, Cage, IDENTIFIER, type Job, Runner, strictJson } from "./workers.ts";

const RPC_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** Where the image installed the lake's extensions (install.ts); a running
 * service reaches no extension host. */
export const EXTENSIONS = fileURLToPath(new URL("./extensions", import.meta.url));

export type Row = Record<string, unknown>;
export type Out = Record<string, Row[]>;

const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** An in-memory DuckDB in UTC, loading only the extensions installed beside
 * this file. */
export async function duckdb(): Promise<DuckDBInstance> {
  const instance = await DuckDBInstance.create(":memory:", {
    extension_directory: EXTENSIONS,
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
  });
  await (await instance.connect()).run("SET GLOBAL TimeZone = 'UTC'");
  return instance;
}

const safe = (value: unknown) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${value} is beyond a number's exact integers`);
  return n;
};

// The binding renders a TIMESTAMPTZ in the host's zone unless told.
DuckDBTimestampTZValue.timezoneOffsetInMinutes = 0;
const BY_TYPE: Partial<Record<DuckDBTypeId, DuckDBValueConverter<unknown>>> = {
  [DuckDBTypeId.BOOLEAN]: booleanFromValue,
  [DuckDBTypeId.TINYINT]: numberFromValue,
  [DuckDBTypeId.SMALLINT]: numberFromValue,
  [DuckDBTypeId.INTEGER]: numberFromValue,
  [DuckDBTypeId.UTINYINT]: numberFromValue,
  [DuckDBTypeId.USMALLINT]: numberFromValue,
  [DuckDBTypeId.UINTEGER]: numberFromValue,
  [DuckDBTypeId.BIGINT]: safe,
  [DuckDBTypeId.UBIGINT]: safe,
  [DuckDBTypeId.HUGEINT]: safe,
  [DuckDBTypeId.UHUGEINT]: safe,
  [DuckDBTypeId.FLOAT]: numberFromValue,
  [DuckDBTypeId.DOUBLE]: numberFromValue,
  [DuckDBTypeId.DECIMAL]: doubleFromDecimalValue,
  [DuckDBTypeId.VARCHAR]: stringFromValue,
  [DuckDBTypeId.UUID]: stringFromValue,
  [DuckDBTypeId.ENUM]: stringFromValue,
  [DuckDBTypeId.DATE]: stringFromValue,
  [DuckDBTypeId.TIME]: stringFromValue,
  [DuckDBTypeId.TIMESTAMP]: stringFromValue,
  [DuckDBTypeId.TIMESTAMP_TZ]: stringFromValue,
  [DuckDBTypeId.LIST]: arrayFromListValue,
  [DuckDBTypeId.ARRAY]: arrayFromArrayValue,
  [DuckDBTypeId.STRUCT]: objectFromStructValue,
  [DuckDBTypeId.SQLNULL]: nullConverter,
};
const PLAIN = createDuckDBValueConverter(BY_TYPE as Record<DuckDBTypeId, DuckDBValueConverter<unknown> | undefined>);

export type Spec = {
  name: string;
  file: string;
  feldera?: string;
  steps?: string;
  to: string[];
  wasm: string[];
  declaredReads?: string[];
  onComplete?: string;
  types?: TypeTable;
  queryTypes?: TypeSchemas;
  sinkTypes?: TypeSchemas;
  sinkWrites?: SinkWrites;
  /** What the module may use past the language; absent, it declares none. */
  endowments?: string[];
};

/** What the service needs of a computation; tests stand in their own. */
export interface Runnable {
  name: string;
  reads: string[];
  to: string[];
  run(lake: Reader): Promise<unknown>;
}

export interface Reader {
  query(sql: string, boundary?: TypeBoundary): Promise<Row[]>;
}

/** Queries on `con`, answered as the contract's plain rows. */
export const readerOf = (con: DuckDBConnection): Reader => ({
  query: async (sql, boundary) => boundary
    ? await portableQuery(con, sql, boundary, PLAIN)
    : (await con.runAndReadAll(sql)).convertRowObjects(PLAIN) as Row[],
});

/** The 32-bit seed of a computation's name: the first four bytes of its SHA-256. */
export async function seedOf(name: string): Promise<number> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name));
  return new DataView(digest).getUint32(0);
}

/** Each wasm file's stem, its name in a job. */
export const stem = (file: string) => file.replace(/^.*\//, "").replace(/\.wasm$/, "");

export class Computation implements Runnable {
  private previous?: { inputs: Record<string, Row[]>; out: unknown };

  private constructor(
    readonly name: string,
    readonly to: string[],
    readonly file: string,
    private compiled: ModuleSource,
    readonly reads: string[],
    private queries: Record<string, string>,
    private wasm: Set<string>,
    private seed: number,
    private runner: Runner,
    readonly onComplete: string | undefined,
    private endowments: string[],
    readonly types: TypeTable | undefined,
    private queryTypes: TypeSchemas | undefined,
    readonly sinkTypes: TypeSchemas | undefined,
    readonly sinkWrites: SinkWrites | undefined,
  ) {}

  static async load(spec: Spec, runner: Runner): Promise<Computation> {
    validateSinkWrites(spec.to, spec.sinkWrites);
    if (spec.onComplete !== undefined && !RPC_IDENTIFIER.test(spec.onComplete)) {
      throw new Error(
        `computation ${spec.name}: onComplete is no SQL/PostgREST RPC identifier: ${spec.onComplete}`,
      );
    }
    const { compiled, reads, queries } = await admit(spec.file, spec.endowments ?? []);
    if (spec.declaredReads !== undefined &&
      !isDeepStrictEqual([...new Set(spec.declaredReads)].sort(), [...new Set(reads)].sort())) {
      throw new Error(`computation ${spec.name}: module reads differ from declared Duckstream sources`);
    }
    if (spec.types !== undefined && spec.queryTypes === undefined && spec.sinkTypes === undefined) {
      throw new Error("a portable type table requires query or sink schemas");
    }
    validateSchemas(spec.types, spec.queryTypes, Object.keys(queries));
    validateSchemas(spec.types, spec.sinkTypes, spec.to, true);
    if (!spec.to.every((t) => IDENTIFIER.test(t))) {
      throw new Error(`computation ${spec.name}: a sink's table name is no identifier: ${spec.to}`);
    }
    return new Computation(
      spec.name,
      [...spec.to],
      spec.file,
      compiled,
      reads,
      queries,
      new Set(spec.wasm.map(stem)),
      await seedOf(spec.name),
      runner,
      spec.onComplete,
      spec.endowments ?? [],
      spec.types,
      spec.queryTypes,
      spec.sinkTypes,
      spec.sinkWrites,
    );
  }

  async capture(lake: Reader): Promise<Record<string, Row[]>> {
    const inputs: Record<string, Row[]> = {};
    for (const [name, sql] of Object.entries(this.queries)) {
      const fields = this.queryTypes?.[name];
      inputs[name] = await lake.query(sql, fields === undefined ? undefined : { fields, types: this.types! });
    }
    strictJson(inputs);
    return inputs;
  }

  feldera(endpoint: string, program: FelderaProgram): Feldera {
    if (
      !isDeepStrictEqual(
        Object.keys(program.outputs).sort(),
        Object.keys(this.queries).sort(),
      )
    ) {
      throw new Error(
        `computation ${this.name}: Feldera outputs differ from declared queries`,
      );
    }
    for (const [name, fields] of Object.entries(this.queryTypes ?? {})) {
      const physical = program.outputs[name].fields;
      bindBoundary({ fields, types: this.types! }).columns(physical.map((field) => field.name));
      for (const field of fields) {
        if (field.type !== "uuid" || physical.find((column) => column.name === field.name)?.type !== "VARCHAR") {
          throw new Error(
            `computation ${this.name}: typed Feldera query ${name}.${field.name} requires an admitted UUID string carrier`,
          );
        }
      }
    }
    return new Feldera(endpoint, this.name, program);
  }

  async run(lake: Reader): Promise<unknown> {
    return await this.calculate(await this.capture(lake));
  }

  async calculate(value: unknown): Promise<unknown> {
    if (
      !isRow(value) || Object.keys(value).sort().join() !== Object.keys(this.queries).sort().join() ||
      !Object.values(value).every((rows) => Array.isArray(rows) && rows.every(isRow))
    ) {
      throw new Error(`computation ${this.name}: invalid retained query inputs`);
    }
    const inputs = value as Record<string, Row[]>;
    for (const [name, fields] of Object.entries(this.queryTypes ?? {})) {
      const normalized = bindBoundary({ fields, types: this.types! }).rows(inputs[name], "canonical");
      if (!isDeepStrictEqual(normalized, inputs[name])) {
        throw new Error(`computation ${this.name}: retained query ${name} is not canonical`);
      }
    }
    // Replayed capture notifications may describe inputs already calculated.
    if (this.previous && isDeepStrictEqual(inputs, this.previous.inputs)) {
      return structuredClone(this.previous.out);
    }
    const cage = new Cage(this.file);
    try {
      await cage.load(this.compiled, this.endowments);
      const ran: Job[] = [];
      const outputs: unknown[] = [];
      let { jobs } = await cage.ask({ inputs, seed: this.seed });
      while (true) {
        const planned = this.jobs(jobs);
        if (ran.some((job, i) => job.wasm !== planned[i]?.wasm || job.input !== planned[i].input)) {
          throw new Error(`computation ${this.name}: plan changed the jobs it was answered`);
        }
        if (planned.length === ran.length) break;
        const fresh = planned.slice(ran.length);
        outputs.push(...await this.runner.run(fresh));
        ran.push(...fresh);
        ({ jobs } = await cage.ask({ outputs, plan: true }));
      }
      const out = (await cage.ask({ outputs })).out;
      this.previous = structuredClone({ inputs, out });
      return out;
    } finally {
      cage.close();
    }
  }

  /** plan's answer as the runner's jobs, each input as its JSON. */
  private jobs(jobs: unknown): Job[] {
    if (!Array.isArray(jobs)) throw new Error(`computation ${this.name}: plan returned no list of jobs`);
    return jobs.map((job) => {
      if (typeof job !== "object" || job === null || !this.wasm.has(job.wasm) || !("input" in job)) {
        throw new Error(`computation ${this.name}: a job is no {wasm, input} of ${[...this.wasm]}`);
      }
      return { wasm: job.wasm, input: strictJson(job.input) };
    });
  }
}

/** The service's one lake: Postgres tables copied into a DuckLake. */
export class Lake implements Reader {
  private constructor(
    private databaseUrl: string,
    private con: DuckDBConnection,
    private reader: Reader,
  ) {}

  /** The lake starts empty: what it holds is only ever this process's copy. */
  static async open(databaseUrl: string, lakeDir: string): Promise<Lake> {
    await Deno.mkdir(lakeDir, { recursive: true });
    for await (const entry of Deno.readDir(lakeDir)) {
      await Deno.remove(`${lakeDir}/${entry.name}`, { recursive: true });
    }
    await Deno.mkdir(`${lakeDir}/data`);
    const db = await duckdb();
    const con = await db.connect();
    await con.run("LOAD postgres; LOAD ducklake");
    await con.run("SET memory_limit = '512MiB'; SET threads = 2");
    await con.run(
      `ATTACH ${literal(`ducklake:${lakeDir}/catalog.ducklake`)} AS lake (DATA_PATH ${literal(`${lakeDir}/data/`)})`,
    );
    const reader = await db.connect();
    await reader.run("USE lake");
    return new Lake(databaseUrl, con, readerOf(reader));
  }

  /** A failed delivery may have left Postgres attached; each one starts clean. */
  async attach() {
    await this.con.run("DETACH DATABASE IF EXISTS pg");
    await this.con.run(
      `ATTACH ${literal(this.databaseUrl)} AS pg (TYPE postgres, READ_ONLY, ISOLATION_LEVEL 'REPEATABLE READ')`,
    );
  }

  async detach() {
    await this.con.run("DETACH pg");
  }

  /** CDC can arrive before Postgres statistics catch up. Always copy the
   * declared inputs in one transaction instead of caching by those counters. */
  async hold(tables: string[]) {
    await this.con.run("BEGIN");
    try {
      for (const t of tables) {
        await this.con.run(`DROP TABLE IF EXISTS lake.${t}`);
        await this.con.run(
          `CREATE TABLE lake.${t} AS SELECT * FROM pg.public.${t}`,
        );
      }
      await this.con.run("COMMIT");
    } catch (e) {
      // The connection serves the next delivery's snapshot.
      await this.con.run("ROLLBACK").catch((r) => {
        throw new AggregateError([e, r], "a snapshot failed, and so did its rollback");
      });
      throw e;
    }
    // Only the newest snapshot is read; older ones are files nobody will.
    await this.con.run(
      "CALL ducklake_expire_snapshots('lake', older_than => now())",
    );
    await this.con.run(
      "CALL ducklake_cleanup_old_files('lake', cleanup_all => true)",
    );
  }

  query(sql: string, boundary?: TypeBoundary): Promise<Row[]> {
    return this.reader.query(sql, boundary);
  }
}

/** The trusted deployment token supplies the same role and claims as crud;
 * unauthenticated clusters use cluster.cue's PGRST_DB_ANON_ROLE. */
export function crudClaims(jwt: string | undefined): Row {
  if (jwt === undefined) return { role: "anon" };
  const payload = jwt.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
  const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
  if (!isRow(claims) || typeof claims.role !== "string") throw new Error("SERVICE_JWT names no role");
  return claims;
}

/** Source catalog and capture readiness for durable batches. */
export class Database {
  private constructor(private con: DuckDBConnection) {}

  static async open(databaseUrl: string, jwt: string | undefined): Promise<Database> {
    const con = await (await duckdb()).connect();
    await con.run("LOAD postgres");
    await con.run(`ATTACH ${literal(databaseUrl)} AS pg (TYPE postgres)`);
    crudClaims(jwt);
    return new Database(con);
  }

  /** Conduit's HTTP health can precede the source opening its slot. A
   * bootstrap snapshot taken earlier would leave a gap in change capture. */
  async requireCapture(slot: string) {
    const rows = (await this.con.runAndReadAll(`SELECT * FROM postgres_query('pg', ${
      literal(
        `SELECT slot_name FROM pg_replication_slots WHERE slot_name = ${literal(slot)}
       AND database = current_database() AND plugin = 'pgoutput' AND NOT temporary
       AND confirmed_flush_lsn IS NOT NULL AND wal_status <> 'lost'`,
      )
    })`)).getRows();
    if (rows.length !== 1) {
      throw new Error(`CDC slot ${slot} is not ready; refusing a bootstrap snapshot before capture`);
    }
  }

  async schema(tables: string[]): Promise<unknown> {
    const names = [...new Set(tables)].map(literal).join(",");
    return (await this.con.runAndReadAll(`SELECT * FROM postgres_query('pg', ${
      literal(`
      SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type,
        a.attnotnull, a.attgenerated, a.attidentity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='public' AND c.relname IN (${names || "NULL"})
        AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`)
    })`)).getRows();
  }
}

const isRow = (row: unknown): row is Row =>
  typeof row === "object" && row !== null && Object.getPrototypeOf(row) === Object.prototype;

/** Acknowledgment follows the receiver's durable acceptance boundary. */
export function handler(service: { refresh(tables?: string[]): Promise<boolean> }, jwt: string | undefined) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/invalidate") {
      return new Response(null, { status: 404 });
    }
    if (
      jwt !== undefined && req.headers.get("authorization") !== `Bearer ${jwt}`
    ) return new Response(null, { status: 401 });
    const body = await req.json();
    if (
      !isRow(body) || !Array.isArray(body.tables) ||
      !body.tables.every((t) => typeof t === "string" && IDENTIFIER.test(t))
    ) {
      throw new Error("invalidation requires {tables: SQL identifiers[]}");
    }
    return new Response(null, {
      status: await service.refresh(body.tables) ? 204 : 503,
    });
  };
}

function need(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}

export type QueryEngine = "duckdb-snapshot" | "feldera";

export function queryEngine(value = "duckdb-snapshot"): QueryEngine {
  if (value !== "duckdb-snapshot" && value !== "feldera") {
    throw new Error(`unsupported DUCKSTREAM_ENGINE: ${value}`);
  }
  return value;
}

export async function computationVersion(
  spec: Spec,
  schema: unknown,
  engine: QueryEngine = "duckdb-snapshot",
): Promise<string> {
  const hash = async (bytes: Uint8Array) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
      ),
    )
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const files = await Promise.all(
    [spec.file, ...spec.wasm, ...(spec.feldera ? [spec.feldera] : [])]
      .map(async (file) => await hash(await Deno.readFile(file))),
  );
  const contract = spec.feldera === undefined && engine === "duckdb-snapshot"
    ? { protocol: 1, spec, schema, files }
    : { protocol: engine === "feldera" ? 3 : 2, engine, spec, schema, files };
  return await hash(new TextEncoder().encode(strictJson(contract, true)));
}

async function main() {
  const { openBatches } = await import("./batches.ts");
  const specs: Spec[] = JSON.parse(need("COMPUTATIONS"));
  const engine = queryEngine(Deno.env.get("DUCKSTREAM_ENGINE"));
  const profile = compilationProfile(Deno.env.get("FELDERA_COMPILATION_PROFILE"));
  if (engine === "feldera" && specs.some((spec) => !spec.feldera)) {
    throw new Error(
      "Feldera mode requires a compiled Feldera descriptor for every computation",
    );
  }

  const sinks = specs.flatMap((s) => s.to);
  if (new Set(sinks).size !== sinks.length) throw new Error(`two computations write one sink: ${sinks.sort()}`);
  const files = [...new Set(specs.flatMap((s) => s.wasm))];
  const stems = files.map(stem);
  if (new Set(stems).size !== stems.length) throw new Error(`two wasm modules share a name: ${files}`);
  const databaseUrl = need("DATABASE_URL");
  await using jobCache = await PostgresJobCache.open(databaseUrl);
  using runner = await Runner.cached(Object.fromEntries(
    await Promise.all(files.map(async (f) => [stem(f), await Deno.readFile(f)])),
  ), jobCache);
  const computations: Computation[] = [];
  for (const spec of specs) computations.push(await Computation.load(spec, runner));
  const jwt = Deno.env.get("SERVICE_JWT");
  const database = await Database.open(databaseUrl, jwt);
  if (engine === "duckdb-snapshot") await database.requireCapture(need("CDC_SLOT"));
  let lake: Lake | undefined;
  const claims = crudClaims(jwt);
  const batches: BatchSpec[] = [];
  const native: NativeRuntime[] = [];
  const nativeDb = new pg.Pool({ connectionString: databaseUrl });
  const engineFailure = Promise.withResolvers<unknown>();
  for (let i = 0; i < computations.length; i++) {
    const c = computations[i];
    const spec = specs[i];
    const version = await computationVersion(
      spec,
      await database.schema([...c.reads, ...c.to]),
      engine,
    );
    if (engine === "feldera") {
      const program = JSON.parse(await Deno.readTextFile(spec.feldera!));
      c.feldera(need("FELDERA_URL"), program);
      const runtime = new NativeRuntime(nativeDb, need("FELDERA_URL"), c,
        program, version, databaseUrl, claims, profile);
      native.push(runtime);
      batches.push(runtime.spec);
      continue;
    }
    batches.push({
      name: c.name,
      reads: c.reads,
      to: c.to,
      version,
      async capture() {
        // Open only after the coordinator owns the singleton lock: opening
        // the ephemeral lake removes its previous files.
        lake ??= await Lake.open(databaseUrl, need("LAKE_DIR"));
        await lake.attach();
        try {
          await lake.hold(c.reads);
        } catch (e) {
          await lake.detach().catch((d) => {
            throw new AggregateError([e, d], "capture and detach failed");
          });
          throw e;
        }
        await lake.detach();
        return await c.capture(lake);
      },
      calculate: (input) => c.calculate(input),
      async publish(client, out) {
        const sinks = await publish(client, c, out, claims);
        console.log(JSON.stringify({ computation: c.name, sinks }));
      },
    });
  }
  NativeRuntime.validateGraph(native);
  const coordinator = await openBatches(databaseUrl, batches);
  const service = {
    async refresh(tables?: string[]) {
      if (native.length) throw new Error("native CDC owns computation invalidation");
      await coordinator.invalidate(tables);
      return true;
    },
  };
  await reconcileNativeResources(nativeDb, native.map((runtime) => runtime.spec.name), Deno.env.get("FELDERA_URL"));
  for (const runtime of native) await runtime.initialize();
  if (!native.length) await service.refresh();
  let stopping = false;
  const polling = (async () => {
    while (!stopping && native.length) {
      for (const runtime of native) {
        if (await runtime.pending()) await coordinator.invalidateNames([runtime.spec.name]);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  polling.catch((error) => engineFailure.resolve(error));
  const server = serve(service, jwt, 9997);
  try {
    await Promise.race([server.finished, coordinator.promise, engineFailure.promise.then((error) => { throw error; })]);
  } finally {
    stopping = true;
    await server.shutdown();
    await coordinator.close();
    await nativeDb.end();
  }
}

/** An error as one line, each cause of an aggregate included. */
function said(error: unknown): string {
  if (error instanceof AggregateError) return `${error.message}: ${error.errors.map(said).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}

/** The delivery server; a failed delivery is logged and answered 500 with its
 * message, which Connect's crash quotes once the retries run out. */
export function serve(
  service: { refresh(tables?: string[]): Promise<boolean> },
  jwt: string | undefined,
  port: number,
) {
  return Deno.serve({
    port,
    onError(error) {
      console.error(error);
      return new Response(said(error), { status: 500 });
    },
  }, handler(service, jwt));
}

if (import.meta.main) await main();
