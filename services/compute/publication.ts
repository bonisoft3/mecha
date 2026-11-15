import pg from "npm:pg@8.16.3";
import type { TypeTable } from "./portable-contract.ts";
import { postgresRows, type TypeSchemas, validateSchemas } from "./portable.ts";
import {
  type SinkWrites,
  validateSinkWrites,
} from "../../packages/compute-snapshot/src/sink-writes.ts";

type Row = Record<string, unknown>;
export type Publication = {
  name: string;
  to: string[];
  sinkWrites?: SinkWrites;
  onComplete?: string;
  types?: TypeTable;
  sinkTypes?: TypeSchemas;
};
export type Delta = Record<string, { upserts: Row[]; deletes: string[] }>;
export type Summary = Record<
  string,
  { rows: number; upserted: number; deleted: number }
>;

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const BATCH = 500;
const isRow = (value: unknown): value is Row =>
  value !== null && typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype;

function identifier(name: string) {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`invalid SQL identifier: ${name}`);
  }
  return `"${name}"`;
}

function json(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (value: unknown): void => {
    if (
      value === null || typeof value === "string" || typeof value === "boolean"
    ) return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (!Array.isArray(value) && !isRow(value)) {
      throw new Error("publication requires finite JSON values");
    }
    if (ancestors.has(value)) {
      throw new Error("publication requires acyclic JSON values");
    }
    ancestors.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      visit(child);
    }
    ancestors.delete(value);
  };
  visit(value);
  return JSON.stringify(value);
}

function validate(spec: Publication, out: unknown): Record<string, Row[]> {
  validateSinkWrites(spec.to, spec.sinkWrites);
  for (const table of spec.to) identifier(table);
  if (spec.onComplete !== undefined) identifier(spec.onComplete);
  if (new Set(spec.to).size !== spec.to.length) {
    throw new Error(`computation ${spec.name}: duplicate sinks`);
  }
  if (!isRow(out)) {
    throw new Error(`computation ${spec.name} returned no {sink: rows}`);
  }
  if (
    JSON.stringify(Object.keys(out).sort()) !==
      JSON.stringify([...spec.to].sort())
  ) {
    throw new Error(`computation ${spec.name} returned different sinks`);
  }
  for (const [table, rows] of Object.entries(out)) {
    if (!Array.isArray(rows) || !rows.every(isRow)) {
      throw new Error(`computation ${spec.name}: ${table} is no list of rows`);
    }
    const ids = new Set<string>();
    const columns = rows.length
      ? JSON.stringify(Object.keys(rows[0]).sort())
      : "";
    for (const row of rows) {
      if (typeof row.id !== "string" || ids.has(row.id)) {
        throw new Error(`${table} row id is not a unique text id`);
      }
      ids.add(row.id);
      for (const name of Object.keys(row)) identifier(name);
      if (JSON.stringify(Object.keys(row).sort()) !== columns) {
        throw new Error(`${table} rows differ in columns`);
      }
      json(row);
    }
  }
  return out as Record<string, Row[]>;
}

function validateDelta(spec: Publication, out: unknown): Delta {
  if (!isRow(out)) {
    throw new Error(`computation ${spec.name} returned no {sink: delta}`);
  }
  const upserts: Record<string, Row[]> = {};
  for (const [table, delta] of Object.entries(out)) {
    if (
      !isRow(delta) ||
      Object.keys(delta).sort().join(",") !== "deletes,upserts" ||
      !Array.isArray(delta.upserts) || !Array.isArray(delta.deletes)
    ) throw new Error(`${table} delta requires upserts and deletes`);
    upserts[table] = delta.upserts as Row[];
  }
  validate(spec, upserts);
  for (const [table, delta] of Object.entries(out as Delta)) {
    const ids = new Set(delta.upserts.map((row) => row.id));
    for (const id of delta.deletes) {
      if (typeof id !== "string" || ids.has(id)) {
        throw new Error(`${table} delta id is repeated or is not a text id`);
      }
      ids.add(id);
    }
  }
  return out as Delta;
}

export type PublicationIsolation =
  | "read committed"
  | "repeatable read"
  | "serializable";

async function roleSettings(client: pg.PoolClient, claims: Row) {
  const role = claims.role ?? "anon";
  if (typeof role !== "string" || !role.length) {
    throw new Error("publication claims require a text role");
  }
  // PostgREST 12.2.3 uses cluster-wide settings granted to the authenticator.
  const { rows: settings } = await client.query<{ key: string; value: string }>(
    `
    WITH role_setting AS (
      SELECT r.rolname, unnest(r.rolconfig) AS setting
      FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
      WHERE member = current_user::regrole::oid
    ), kv_settings AS (
      SELECT rolname, substr(setting, 1, strpos(setting, '=') - 1) AS key,
        lower(substr(setting, strpos(setting, '=') + 1)) AS value FROM role_setting
    )
    SELECT kv.key, kv.value FROM kv_settings kv JOIN pg_settings ps ON ps.name = kv.key
    AND (ps.context = 'user' OR has_parameter_privilege(current_user::regrole::oid, ps.name, 'set'))
    WHERE kv.rolname = $1`,
    [role],
  );
  const level = settings.find(({ key }) =>
    key === "default_transaction_isolation"
  )?.value;
  const isolation: PublicationIsolation =
    level === "serializable" || level === "repeatable read"
      ? level
      : "read committed";
  return { role, settings, isolation };
}

export type StagedPages = {
  stages: Map<string, { name: string; columns?: string[] }>;
  rows: Record<string, number>;
};

export function preparePublish(
  spec: Publication,
  out: unknown,
): Record<string, Row[]> {
  const rows = validate(spec, out);
  validateSchemas(spec.types, spec.sinkTypes, spec.to, true);
  const sinks = { ...rows };
  for (const [table, fields] of Object.entries(spec.sinkTypes ?? {})) {
    sinks[table] = postgresRows({ fields, types: spec.types! }, sinks[table]);
  }
  return sinks;
}

/** Caller owns the transaction and must roll it back if publication fails. */
export async function publish(
  client: pg.PoolClient,
  spec: Publication,
  out: unknown,
  claims: Row,
): Promise<Summary> {
  return await apply(client, spec, preparePublish(spec, out), claims);
}

/** Caller owns the transaction and must roll it back if publication fails. */
export async function publishPrepared(
  client: pg.PoolClient,
  spec: Publication,
  sinks: Record<string, Row[]>,
  claims: Row,
): Promise<Summary> {
  return await apply(client, spec, sinks, claims);
}

/** Caller commits the delta, freshness guard and receipt in the same transaction. */
export async function publishDelta(
  client: pg.PoolClient,
  spec: Publication,
  out: unknown,
  claims: Row,
): Promise<Summary> {
  const delta = validateDelta(spec, out);
  validateSchemas(spec.types, spec.sinkTypes, spec.to, true);
  const sinks = Object.fromEntries(
    Object.entries(delta).map(([table, rows]) => [table, rows.upserts]),
  );
  for (const [table, fields] of Object.entries(spec.sinkTypes ?? {})) {
    sinks[table] = postgresRows({ fields, types: spec.types! }, sinks[table]);
  }
  return await apply(
    client,
    spec,
    sinks,
    claims,
    Object.fromEntries(
      Object.entries(delta).map(([table, rows]) => [table, rows.deletes]),
    ),
  );
}

// Once a statement aborts an explicit transaction block, PostgreSQL refuses
// cleanup SQL with 25P02 until the caller's ROLLBACK — which itself reverts
// transaction-local GUC settings and drops temp tables created in that block.
function isAbortedTransaction(error: unknown): boolean {
  return error instanceof pg.DatabaseError && error.code === "25P02";
}

export async function dropStagedPages(
  client: pg.PoolClient,
  staged: StagedPages,
): Promise<void> {
  for (const { name } of staged.stages.values()) {
    await client.query(`DROP TABLE IF EXISTS pg_temp.${identifier(name)}`);
  }
}

export async function stagePages(
  client: pg.PoolClient,
  spec: Publication,
  pages: (sink: string) => AsyncIterable<Row[]>,
): Promise<StagedPages> {
  validate(spec, Object.fromEntries(spec.to.map((table) => [table, []])));
  validateSchemas(spec.types, spec.sinkTypes, spec.to, true);
  const rows: Record<string, number> = Object.fromEntries(
    spec.to.map((table) => [table, 0]),
  );
  const stages = new Map<string, { name: string; columns?: string[] }>();
  try {
    for (const table of spec.to) {
      const name = `publication_${crypto.randomUUID().replaceAll("-", "")}`;
      const stage = `pg_temp.${identifier(name)}`;
      await client.query(
        `CREATE TEMP TABLE ${identifier(name)} AS SELECT * FROM public.${identifier(table)} WITH NO DATA`,
      );
      await client.query(`GRANT SELECT ON TABLE ${stage} TO PUBLIC`);
      await client.query(`CREATE UNIQUE INDEX ON ${stage} (id)`);
      stages.set(table, { name });
      let columns: string[] | undefined;
      for await (const page of pages(table)) {
        validate(
          spec,
          Object.fromEntries(
            spec.to.map((sink) => [sink, sink === table ? page : []]),
          ),
        );
        const encoded = json(page);
        if (
          page.length > 128 ||
          new TextEncoder().encode(encoded).length > 256 * 1024
        ) {
          throw new Error(`${table} publication page exceeds its bound`);
        }
        if (!page.length) continue;
        const names = Object.keys(page[0]).sort();
        if (columns && JSON.stringify(columns) !== JSON.stringify(names)) {
          throw new Error(`${table} rows differ in columns`);
        }
        columns = names;
        const fields = spec.sinkTypes?.[table];
        const normalized = fields
          ? postgresRows({ fields, types: spec.types! }, page)
          : page;
        const list = columns.map(identifier).join(", ");
        await client.query(
          `INSERT INTO ${stage} (${list}) SELECT ${list} FROM json_populate_recordset(NULL::public.${identifier(table)}, $1::json)`,
          [json(normalized)],
        );
        rows[table] += page.length;
      }
      stages.set(table, { name, columns });
    }
    return { stages, rows };
  } catch (error) {
    await dropStagedPages(client, { stages, rows }).catch((cleanupError) => {
      if (isAbortedTransaction(cleanupError)) return;
      throw new AggregateError(
        [error, cleanupError],
        "staging and cleanup failed",
      );
    });
    throw error;
  }
}

async function applyStagedPages(
  client: pg.PoolClient,
  spec: Publication,
  staged: StagedPages,
): Promise<Summary> {
  const summary: Summary = Object.fromEntries(
    spec.to.map((table) => [
      table,
      { rows: staged.rows[table] ?? 0, upserted: 0, deleted: 0 },
    ]),
  );
  for (const table of spec.to) {
    const { name, columns } = staged.stages.get(table)!;
    const stage = `pg_temp.${identifier(name)}`;
    if (columns) {
      const list = columns.map(identifier).join(", ");
      const rest = columns.filter((column) => column !== "id");
      const changes = rest.map((column) =>
        `${identifier(column)} = EXCLUDED.${identifier(column)}`
      ).join(", ");
      const existing = rest.map((column) => `sink.${identifier(column)}`).join(
        ", ",
      );
      const incoming = rest.map((column) => `EXCLUDED.${identifier(column)}`)
        .join(", ");
      const conflict = rest.length
        ? `DO UPDATE SET ${changes} WHERE to_jsonb(ROW(${existing})) IS DISTINCT FROM to_jsonb(ROW(${incoming}))`
        : "DO NOTHING";
      const result = await client.query(
        `INSERT INTO public.${identifier(table)} AS sink (${list}) SELECT ${list} FROM ${stage} WHERE true ON CONFLICT (id) ${conflict}`,
      );
      summary[table].upserted = result.rowCount!;
    }
  }
  for (const table of spec.to) {
    if (spec.sinkWrites?.[table] !== "upsert") {
      const stage = `pg_temp.${identifier(staged.stages.get(table)!.name)}`;
      const result = await client.query(
        `DELETE FROM public.${identifier(table)} AS sink WHERE NOT EXISTS (SELECT FROM ${stage} AS retained WHERE sink.id = retained.id)`,
      );
      summary[table].deleted = result.rowCount!;
    }
  }
  if (spec.onComplete) {
    await client.query(`SELECT public.${identifier(spec.onComplete)}()`);
  }
  return summary;
}

/** Caller owns the transaction and must roll it back if publication fails. */
export async function publishStagedPages(
  client: pg.PoolClient,
  spec: Publication,
  staged: StagedPages,
  claims: Row,
): Promise<Summary> {
  const previous = await enterAuthority(client, claims);
  let applyError: unknown;
  try {
    return await applyStagedPages(client, spec, staged);
  } catch (error) {
    applyError = error;
    throw error;
  } finally {
    await leaveAuthority(client, previous).catch((cleanupError) => {
      if (applyError !== undefined) {
        if (isAbortedTransaction(cleanupError)) return;
        throw new AggregateError(
          [applyError, cleanupError],
          "publication and authority cleanup failed",
        );
      }
      throw cleanupError;
    });
  }
}

/** Caller owns the transaction and must roll it back if publication fails. */
export async function publishPages(
  client: pg.PoolClient,
  spec: Publication,
  pages: (sink: string) => AsyncIterable<Row[]>,
  claims: Row,
): Promise<Summary> {
  const previous = await enterAuthority(client, claims);
  let staged: StagedPages | undefined;
  let mainError: unknown;
  try {
    staged = await stagePages(client, spec, pages);
    return await applyStagedPages(client, spec, staged);
  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    const errors: unknown[] = mainError !== undefined ? [mainError] : [];
    const recordCleanup = (err: unknown) => {
      if (mainError !== undefined && isAbortedTransaction(err)) return;
      errors.push(err);
    };
    if (staged) {
      await dropStagedPages(client, staged).catch(recordCleanup);
    }
    await leaveAuthority(client, previous).catch(recordCleanup);
    if (mainError !== undefined && errors.length > 1) {
      throw new AggregateError(errors, "publication and cleanup failed");
    }
    if (mainError === undefined && errors.length > 0) {
      throw errors[0];
    }
  }
}

async function enterAuthority(client: pg.PoolClient, claims: Row) {
  const claimsJson = json(claims);
  const { role, settings, isolation } = await roleSettings(client, claims);
  const { rows: transaction } = await client.query<{ isolation: string }>(
    "SELECT current_setting('transaction_isolation') AS isolation",
  );
  if (
    transaction[0].isolation !== "serializable" &&
    transaction[0].isolation !== isolation
  ) {
    throw new Error(
      `publication requires transaction isolation ${isolation}; caller uses ${
        transaction[0].isolation
      }`,
    );
  }
  const applied = settings.filter(({ key }) =>
    key !== "default_transaction_isolation"
  );
  const names = [
    ...new Set([
      "role",
      "request.jwt.claims",
      ...applied.map(({ key }) => key),
    ]),
  ];
  const { rows: previous } = await client.query<
    { name: string; value: string | null }
  >(
    "SELECT name, current_setting(name, true) AS value FROM unnest($1::text[]) AS name",
    [names],
  );
  for (const { key, value } of applied) {
    await client.query("SELECT set_config($1, $2, true)", [key, value]);
  }
  await client.query("SELECT set_config('role', $1, true)", [role]);
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
    claimsJson,
  ]);
  await client.query("SELECT public.app_pre_request()");
  return previous;
}

async function leaveAuthority(
  client: pg.PoolClient, previous: { name: string; value: string | null }[],
) {
  for (const { name, value } of previous) {
    await client.query("SELECT set_config($1, $2, true)", [name, value ?? ""]);
  }
}

async function apply(
  client: pg.PoolClient,
  spec: Publication,
  sinks: Record<string, Row[]>,
  claims: Row,
  deletions?: Record<string, string[]>,
): Promise<Summary> {
  const previous = await enterAuthority(client, claims);
  for (const table of spec.to) {
    const ids = [
      ...sinks[table].map((row) => row.id),
      ...(deletions?.[table] ?? []),
    ];
    const seen = new Set<string>();
    // PostgreSQL accepts alternate UUID spellings that denote the same key.
    for (let i = 0; i < ids.length; i += BATCH) {
      const { rows: keys } = await client.query<{ id: string }>(
        `SELECT to_jsonb(input)->>'id' AS id
         FROM json_populate_recordset(NULL::public.${
          identifier(table)
        }, $1::json) AS input`,
        [json(ids.slice(i, i + BATCH).map((id) => ({ id })))],
      );
      for (const { id } of keys) {
        if (id === null || seen.has(id)) {
          throw new Error(
            `${table} publication contains repeated PostgreSQL keys`,
          );
        }
        seen.add(id);
      }
    }
  }
  const summary: Summary = Object.fromEntries(
    spec.to.map((
      table,
    ) => [table, { rows: sinks[table].length, upserted: 0, deleted: 0 }]),
  );
  for (const table of spec.to) {
    const rows = sinks[table];
    if (!rows.length) continue;
    const names = Object.keys(rows[0]);
    const columns = names.map(identifier).join(", ");
    const rest = names.filter((name) => name !== "id");
    const changes = rest.map((name) =>
      `${identifier(name)} = EXCLUDED.${identifier(name)}`
    ).join(", ");
    const existing = rest.map((name) => `sink.${identifier(name)}`).join(", ");
    const incoming = rest.map((name) => `EXCLUDED.${identifier(name)}`).join(
      ", ",
    );
    const conflict = rest.length
      ? `DO UPDATE SET ${changes} WHERE to_jsonb(ROW(${existing})) IS DISTINCT FROM to_jsonb(ROW(${incoming}))`
      : "DO NOTHING";
    for (let i = 0; i < rows.length; i += BATCH) {
      const result = await client.query(
        `INSERT INTO public.${identifier(table)} AS sink (${columns})
         SELECT ${columns} FROM json_populate_recordset(NULL::public.${
          identifier(table)
        }, $1::json)
         ON CONFLICT (id) ${conflict}`,
        [json(rows.slice(i, i + BATCH))],
      );
      summary[table].upserted += result.rowCount!;
    }
  }
  for (const table of spec.to) {
    if (spec.sinkWrites?.[table] === "upsert") continue;
    if (deletions) {
      const ids = deletions[table];
      for (let i = 0; i < ids.length; i += BATCH) {
        const result = await client.query(
          `DELETE FROM public.${identifier(table)} AS sink
           USING json_populate_recordset(NULL::public.${
            identifier(table)
          }, $1::json) AS removed
           WHERE sink.id = removed.id`,
          [json(ids.slice(i, i + BATCH).map((id) => ({ id })))],
        );
        summary[table].deleted += result.rowCount!;
      }
    } else {
      const result = await client.query(
        `DELETE FROM public.${identifier(table)} AS sink
         WHERE NOT EXISTS (
           SELECT FROM json_populate_recordset(NULL::public.${
          identifier(table)
        }, $1::json) AS retained
           WHERE sink.id = retained.id
         )`,
        [json(sinks[table].map(({ id }) => ({ id })))],
      );
      summary[table].deleted = result.rowCount!;
    }
  }
  if (spec.onComplete) {
    await client.query(`SELECT public.${identifier(spec.onComplete)}()`);
  }
  await leaveAuthority(client, previous);
  return summary;
}
