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
//            Postgres's portable domains arrive as text, so a query casts;
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
// permissions and no globals beyond the language (cage.ts).
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
//     less the clock, Math.random, and the host's time zone and locale.
//
// The service loads every computation at startup and dies on one it refuses;
// admit.ts loads them as it does, for a lint to refuse them first.
//
// A job is its input as JSON on a WASI module's stdin, answered by its stdout
// parsed as JSON, each in a fresh instance (wasi.ts), one job at a time in one
// worker. Snapshot capture, calculation and publication are serialized in
// this process; multiple compute replicas are not supported.
//
// finish returns {sink table: [rows]} for exactly the tables its `to` names,
// each row keyed by a text `id`, every row of a sink with the same columns,
// no number NaN or infinite; each list is the sink's whole content: rows the
// sink holds and the output lacks are deleted. Sink changes travel through
// CDC too, invalidating computations that declare them in `reads`.
//
// All computations run at startup, then on CDC invalidations of their reads.
// Each delivery takes a fresh snapshot, including a redelivery. Its output is
// written in a rolled-back Postgres transaction, as crud will write it, before anything is
// written; the writes then go through crud as the service role, the path every
// pipeline writes by: changed rows upserted on id in every sink, then the rows
// no longer produced deleted. Crud has no transaction across requests, so a
// write failing past the check leaves a mix. A failed delivery answers 500 and
// the service keeps serving: the Connect consumer resends it with backoff and,
// past its retries, crashes (events.yaml). A resend reads a fresh snapshot and
// rewrites every row of the sinks the failed write touched, which replaces the
// mix and outlasts a deadlock or a row deleted mid-run.
//
// Environment: CRUD_URL, DATABASE_URL, CDC_SLOT, LAKE_DIR, COMPUTATIONS (JSON list of
// {name, file, to, wasm}, wasm being the module files it ships);
// SERVICE_JWT where the cluster has auth.

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

const BATCH = 1000;
// Ids per DELETE: quoted uuids keep its URL near 8 KiB.
const DELETES = 200;
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
  to: string[];
  wasm: string[];
  onComplete?: string;
};

/** What the service needs of a computation; tests stand in their own. */
export interface Runnable {
  name: string;
  reads: string[];
  to: string[];
  run(lake: Reader): Promise<unknown>;
}

export interface Reader {
  query(sql: string): Promise<Row[]>;
}

/** Queries on `con`, answered as the contract's plain rows. */
export const readerOf = (con: DuckDBConnection): Reader => ({
  query: async (sql) => (await con.runAndReadAll(sql)).convertRowObjects(PLAIN) as Row[],
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
  ) {}

  static async load(spec: Spec, runner: Runner): Promise<Computation> {
    if (spec.onComplete !== undefined && !RPC_IDENTIFIER.test(spec.onComplete)) {
      throw new Error(
        `computation ${spec.name}: onComplete is no SQL/PostgREST RPC identifier: ${spec.onComplete}`,
      );
    }
    const { compiled, reads, queries } = await admit(spec.file);
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
    );
  }

  async run(lake: Reader): Promise<unknown> {
    const inputs: Record<string, Row[]> = {};
    for (const [name, sql] of Object.entries(this.queries)) inputs[name] = await lake.query(sql);
    // One committed transaction can produce many CDC rows. Pure calculations
    // may reuse their last answer, but every delivery still reads fresh inputs
    // and retries publication and its completion hook.
    if (this.previous && isDeepStrictEqual(inputs, this.previous.inputs)) {
      return structuredClone(this.previous.out);
    }
    const cage = new Cage(this.file);
    try {
      await cage.load(this.compiled);
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
      `ATTACH ${literal(this.databaseUrl)} AS pg (TYPE postgres, READ_ONLY)`,
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

  query(sql: string): Promise<Row[]> {
    return this.reader.query(sql);
  }
}

/** `text` as a Postgres dollar-quoted literal. */
export function dollar(text: string): string {
  const tag = "$mecha$";
  if (text.includes(tag)) throw new Error(`a value holds ${tag}`);
  return `${tag}${text}${tag}`;
}

/** Upserts and deletions per table. */
export type Plan = Record<string, [Row[], string[]]>;

export interface Store {
  ids(table: string): Promise<string[]>;
  check(plan: Plan): Promise<void>;
}

/** The claims crud acts on for `jwt`; without one it answers as its anon
 * role, cluster.cue's PGRST_DB_ANON_ROLE. The signature is crud's to check. */
export function crudClaims(jwt: string | undefined): Row {
  if (jwt === undefined) return { role: "anon" };
  const payload = jwt.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
  const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
  if (!isRow(claims) || typeof claims.role !== "string") throw new Error("SERVICE_JWT names no role");
  return claims;
}

/** Postgres as the sinks' check sees it: their ids, and a dry run. */
export class Database implements Store {
  private constructor(private con: DuckDBConnection, private claims: Row) {}

  /** `databaseUrl` connects as crud's authenticator does, which decides the
   * settings crud applies for the claims' role. */
  static async open(databaseUrl: string, jwt: string | undefined): Promise<Database> {
    const con = await (await duckdb()).connect();
    await con.run("LOAD postgres");
    await con.run(`ATTACH ${literal(databaseUrl)} AS pg (TYPE postgres)`);
    return new Database(con, crudClaims(jwt));
  }

  /** Conduit's HTTP health can precede the source opening its slot. A
   * bootstrap snapshot taken earlier would leave a gap in change capture. */
  async requireCapture(slot: string) {
    const rows = (await this.con.runAndReadAll(`SELECT * FROM postgres_query('pg', ${literal(
      `SELECT slot_name FROM pg_replication_slots WHERE slot_name = ${literal(slot)}
       AND database = current_database() AND plugin = 'pgoutput' AND NOT temporary
       AND confirmed_flush_lsn IS NOT NULL AND wal_status <> 'lost'`,
    )})`)).getRows();
    if (rows.length !== 1) throw new Error(`CDC slot ${slot} is not ready; refusing a bootstrap snapshot before capture`);
  }

  /** What crud applies for the role: its transaction's isolation level and
   * the settings it sets. Read per check, as crud rereads them when its
   * config reloads. */
  private async role(): Promise<[string, string[][]]> {
    // PostgREST 12.2.3's queryRoleSettings (Postgres 15 and up), for one role:
    // cluster-wide settings only, of roles the authenticator is a member of,
    // that it may set; default_transaction_isolation is not set but read as
    // the isolation level of every request's transaction (toIsolationLevel).
    const rows = (await this.con.runAndReadAll(
      `SELECT * FROM postgres_query('pg', ${literal(`
        WITH role_setting AS (
          SELECT r.rolname, unnest(r.rolconfig) AS setting
          FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
          WHERE member = current_user::regrole::oid
        ), kv_settings AS (
          SELECT rolname, substr(setting, 1, strpos(setting, '=') - 1) AS key,
            lower(substr(setting, strpos(setting, '=') + 1)) AS value
          FROM role_setting
        )
        SELECT kv.key, kv.value FROM kv_settings kv
        JOIN pg_settings ps ON ps.name = kv.key
          AND (ps.context = 'user' OR has_parameter_privilege(current_user::regrole::oid, ps.name, 'set'))
        WHERE kv.rolname = ${literal(this.claims.role as string)}`)})`,
    )).getRows() as string[][];
    const level = rows.find(([key]) => key === "default_transaction_isolation")?.[1];
    const isolation = level === "repeatable read" || level === "serializable" ? level : "read committed";
    return [isolation, rows.filter(([key]) => key !== "default_transaction_isolation")];
  }

  async ids(table: string): Promise<string[]> {
    return ((await this.con.runAndReadAll(`SELECT id::VARCHAR FROM pg.public.${table}`)).getRows() as string[][])
      .map((r) => r[0]);
  }

  /** Apply `plan` in one transaction and roll it back: a row breaking a
   * constraint, a validation, a reference or a grant or policy fails here,
   * before crud writes anything. It is crud's request rehearsed: a
   * transaction at the role's isolation level, the settings crud applies for
   * the role (its statement and lock timeouts), set before the role as crud
   * sets them, the role, claims and pre-request hook, every sink's upserts
   * and then their deletions. */
  async check(plan: Plan) {
    const pg = (sql: string) => this.con.run("CALL postgres_execute('pg', ?)", [sql]);
    const role = this.claims.role as string;
    const [isolation, settings] = await this.role();
    await this.con.run("BEGIN");
    try {
      await pg(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
      for (const [name, value] of settings) await pg(`SELECT set_config(${literal(name)}, ${literal(value)}, true)`);
      await pg(`SET LOCAL ROLE "${role.replaceAll('"', '""')}"`);
      await pg(`SELECT set_config('request.jwt.claims', ${dollar(strictJson(this.claims))}, true)`);
      await pg("SELECT public.app_pre_request()");
      for (const [table, [rows]] of Object.entries(plan)) {
        for (let i = 0; i < rows.length; i += BATCH) {
          const batch = rows.slice(i, i + BATCH);
          const names = Object.keys(batch[0]);
          const columns = names.map((c) => `"${c}"`).join(", ");
          const rest = names.filter((c) => c !== "id");
          const update = rest.length > 0
            ? `DO UPDATE SET (${rest.map((c) => `"${c}"`).join(", ")}) = ROW(${rest.map((c) => `EXCLUDED."${c}"`).join(", ")})`
            : "DO NOTHING";
          await pg(
            `INSERT INTO public.${table} (${columns}) SELECT ${columns} FROM ` +
              `json_populate_recordset(NULL::public.${table}, ${dollar(strictJson(batch))}) ON CONFLICT (id) ${update}`,
          );
        }
      }
      for (const [table, [, deletes]] of Object.entries(plan)) {
        for (let i = 0; i < deletes.length; i += BATCH) {
          await pg(
            `DELETE FROM public.${table} WHERE id::text IN ` +
              `(SELECT jsonb_array_elements_text(${dollar(strictJson(deletes.slice(i, i + BATCH)))}::jsonb))`,
          );
        }
      }
    } finally {
      await this.con.run("ROLLBACK");
    }
  }
}

const isRow = (row: unknown): row is Row =>
  typeof row === "object" && row !== null && Object.getPrototypeOf(row) === Object.prototype;

/** What the sinks hold: per table, id -> the row's JSON as last written here,
 * null for a row this process has not written. The ids are the table's own,
 * read before each apply, so a row deleted by a cascade is written again. */
export class Sinks {
  held = new Map<string, Map<string, string | null>>();
  private headers: Record<string, string>;

  constructor(private database: Store, private crudUrl: string, jwt: string | undefined) {
    this.headers = jwt ? { Authorization: `Bearer ${jwt}` } : {};
  }

  /** Refuse an output outside the contract; else what changes, per table. */
  async plan(c: { name: string; to: string[] }, out: unknown) {
    if (!isRow(out)) throw new Error(`computation ${c.name} returned no {sink: rows}`);
    if ([...Object.keys(out)].sort().join() !== [...c.to].sort().join()) {
      throw new Error(`computation ${c.name} returned ${Object.keys(out).sort()}, not its sinks ${[...c.to].sort()}`);
    }
    const plan: Record<string, [Row[], string[], Map<string, string>]> = {};
    for (const [table, rows] of Object.entries(out)) {
      if (!Array.isArray(rows) || !rows.every(isRow)) throw new Error(`computation ${c.name}: ${table} is no list of rows`);
      const written = this.held.get(table) ?? new Map();
      const held = new Map((await this.database.ids(table)).map((k) => [k, written.get(k) ?? null]));
      this.held.set(table, held);
      const now = new Map<string, string>();
      const columns = rows.length > 0 ? Object.keys(rows[0]).sort().join() : "";
      for (const row of rows) {
        if (typeof row.id !== "string" || now.has(row.id)) {
          throw new Error(`computation ${c.name}: ${table} row id ${JSON.stringify(row.id)} is not a unique text id`);
        }
        if (Object.keys(row).sort().join() !== columns) throw new Error(`computation ${c.name}: ${table} rows differ in columns`);
        now.set(row.id, strictJson(row, true));
      }
      plan[table] = [
        rows.filter((row) => (held.has(row.id as string) ? held.get(row.id as string) : "") !== now.get(row.id as string)),
        [...held.keys()].filter((k) => !now.has(k)),
        now,
      ];
    }
    return plan;
  }

  async apply(c: { name: string; to: string[]; onComplete?: string }, out: unknown) {
    if (c.onComplete !== undefined && !RPC_IDENTIFIER.test(c.onComplete)) {
      throw new Error(`computation ${c.name}: onComplete is no SQL/PostgREST RPC identifier: ${c.onComplete}`);
    }
    const plan = await this.plan(c, out);
    await this.database.check(Object.fromEntries(Object.entries(plan).map(([t, [rows, deletes]]) => [t, [rows, deletes]])));
    try {
      for (const [table, [rows]] of Object.entries(plan)) {
        for (let i = 0; i < rows.length; i += BATCH) await this.send("POST", `${table}?on_conflict=id`, rows.slice(i, i + BATCH));
      }
      for (const [table, [, deletes]] of Object.entries(plan)) {
        for (let i = 0; i < deletes.length; i += DELETES) {
          const ids = deletes.slice(i, i + DELETES).map((k) => JSON.stringify(k)).join(",");
          await this.send("DELETE", `${table}?id=in.(${encodeURIComponent(ids)})`);
        }
      }
    } catch (e) {
      // Some writes may have landed: what the sinks hold is unknown again, so
      // the redelivery rewrites every row it produces.
      for (const table of Object.keys(plan)) this.held.delete(table);
      throw e;
    }
    for (const [table, [, , now]] of Object.entries(plan)) this.held.set(table, now);
    if (c.onComplete !== undefined) {
      await this.send("POST", `rpc/${c.onComplete}`, {}, "return=minimal");
    }
    return Object.fromEntries(
      Object.entries(plan).map(([t, [rows, deletes, now]]) => [t, { rows: now.size, upserted: rows.length, deleted: deletes.length }]),
    );
  }

  async send(method: string, path: string, body?: unknown, prefer = "resolution=merge-duplicates,return=minimal") {
    const headers: Record<string, string> = { ...this.headers, Prefer: prefer };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${this.crudUrl}/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : strictJson(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  }
}

export interface Snapshots {
  attach(): Promise<void>;
  detach(): Promise<void>;
  hold(tables: string[]): Promise<void>;
}

export class Service {
  private active = false;

  constructor(
    private computations: Runnable[],
    private lake: Snapshots & Reader,
    private sinks: { apply(c: Runnable, out: unknown): Promise<unknown> },
  ) {}

  /** An overlapping HTTP retry must not start a second snapshot. Leave its
   * delivery unacknowledged in the broker, rather than queueing it in memory. */
  async refresh(tables?: string[]): Promise<boolean> {
    if (this.active) return false;
    this.active = true;
    try {
      for (const c of this.computations) {
        if (tables === undefined || c.reads.some((t) => tables.includes(t))) {
          await this.step(c);
        }
      }
      return true;
    } finally {
      this.active = false;
    }
  }

  private async step(c: Runnable) {
    await this.lake.attach();
    try {
      await this.lake.hold(c.reads);
    } catch (e) {
      await this.lake.detach().catch((d) => {
        throw new AggregateError([e, d], "a snapshot failed, and so did detaching Postgres");
      });
      throw e;
    }
    await this.lake.detach();
    const started = performance.now();
    const out = await c.run(this.lake);
    const written = await this.sinks.apply(c, out);
    console.log(JSON.stringify({
      computation: c.name,
      sinks: written,
      seconds: Math.round(performance.now() - started) / 1000,
    }));
  }
}

/** Internal delivery endpoint. A 2xx means every affected output and hook
 * completed; a failure reaches serve's onError. */
export function handler(service: Service, jwt: string | undefined) {
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

async function main() {
  const specs: Spec[] = JSON.parse(need("COMPUTATIONS"));
  const sinks = specs.flatMap((s) => s.to);
  if (new Set(sinks).size !== sinks.length) throw new Error(`two computations write one sink: ${sinks.sort()}`);
  const files = [...new Set(specs.flatMap((s) => s.wasm))];
  const stems = files.map(stem);
  if (new Set(stems).size !== stems.length) throw new Error(`two wasm modules share a name: ${files}`);
  const modules = Object.fromEntries(
    await Promise.all(files.map(async (f) => [stem(f), await WebAssembly.compile(await Deno.readFile(f))])),
  );
  const runner = new Runner(modules);
  const computations: Runnable[] = [];
  for (const spec of specs) computations.push(await Computation.load(spec, runner));
  const databaseUrl = need("DATABASE_URL");
  const jwt = Deno.env.get("SERVICE_JWT");
  const database = await Database.open(databaseUrl, jwt);
  await database.requireCapture(need("CDC_SLOT"));
  const service = new Service(
    computations,
    await Lake.open(databaseUrl, need("LAKE_DIR")),
    new Sinks(database, need("CRUD_URL"), jwt),
  );
  await service.refresh();
  await serve(service, jwt, 9997).finished;
}

/** An error as one line, each cause of an aggregate included. */
function said(error: unknown): string {
  if (error instanceof AggregateError) return `${error.message}: ${error.errors.map(said).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}

/** The delivery server; a failed delivery is logged and answered 500 with its
 * message, which Connect's crash quotes once the retries run out. */
export function serve(service: Service, jwt: string | undefined, port: number) {
  return Deno.serve({
    port,
    onError(error) {
      console.error(error);
      return new Response(said(error), { status: 500 });
    },
  }, handler(service, jwt));
}

if (import.meta.main) await main();
