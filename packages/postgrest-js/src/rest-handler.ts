import type { PGlite } from '@electric-sql/pglite'
import { validateIdentifier } from './validate.js'
import { planRead, ReadQueryError, writeWhere } from './rest-read.js'

function parsePrefer(header: string | null): {
  returnRepresentation: boolean
  ignoreDuplicates: boolean
  mergeDuplicates: boolean
  countExact: boolean
} {
  if (!header) return { returnRepresentation: false, ignoreDuplicates: false, mergeDuplicates: false, countExact: false }
  const parts = header.split(',').map((p) => p.trim())
  return {
    returnRepresentation: parts.includes('return=representation'),
    ignoreDuplicates: parts.some((p) => p === 'resolution=ignore-duplicates'),
    mergeDuplicates: parts.some((p) => p === 'resolution=merge-duplicates'),
    countExact: parts.some((p) => p === 'count=exact'),
  }
}

/** What the handlers reach for, so a transaction can stand in for the connection. */
type Queryable = Pick<PGlite, 'query' | 'exec'>

async function tableExists(db: Queryable, table: string): Promise<boolean> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  )
  return parseInt(result.rows[0]?.count ?? '0', 10) > 0
}

/**
 * The columns of `table` PostgREST writes as JSON, each with the SQL that takes
 * a placeholder bound to the JSON text of the value sent. A domain
 * representation is a cast from json to the column's type by a function, which
 * PostgREST hands the value, a JSON null as SQL NULL, so a function called on
 * null input decides what a null stores and a strict one stores SQL NULL. A
 * json or jsonb column, or a domain over one, stores the value sent: a string
 * is a JSON string.
 */
async function writtenAsJson(db: Queryable, table: string): Promise<Map<string, (p: string) => string>> {
  const res = await db.query<{ col: string; fn: string | null; type: string }>(
    `SELECT a.attname AS col, quote_ident(n.nspname) || '.' || quote_ident(p.proname) AS fn,
            format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
       LEFT JOIN pg_cast c ON c.casttarget = a.atttypid AND c.castsource = 'json'::regtype AND c.castmethod = 'f'
       LEFT JOIN pg_proc p ON p.oid = c.castfunc
       LEFT JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE a.attrelid = format('public.%I', $1::text)::regclass AND a.attnum > 0 AND NOT a.attisdropped
        AND (c.oid IS NOT NULL OR EXISTS (
          WITH RECURSIVE base(oid, under) AS (
            SELECT t.oid, t.typbasetype FROM pg_type t WHERE t.oid = a.atttypid
            UNION ALL SELECT t.oid, t.typbasetype FROM pg_type t JOIN base ON t.oid = base.under)
          SELECT FROM base WHERE oid IN ('json'::regtype, 'jsonb'::regtype)))`,
    [table],
  )
  return new Map(res.rows.map((r) => [r.col, r.fn === null ? (p) => `${p}::${r.type}` : (p) => `${r.fn}(${p}::json)`]))
}

/** The placeholder a written value takes, as JSON where its column takes it so. */
function bindWritten(asJson: Map<string, (p: string) => string>, col: string, value: unknown, params: unknown[]): string {
  const sql = asJson.get(col)
  if (sql === undefined) {
    params.push(value)
    return `$${params.length}`
  }
  params.push(value === null || value === undefined ? null : JSON.stringify(value))
  return sql(`$${params.length}`)
}

async function handleGet(
  db: Queryable,
  table: string,
  url: URL,
  req: Request,
): Promise<Response> {
  const params = url.searchParams
  const prefer = parsePrefer(req.headers.get('Prefer'))

  const plan = await planRead(db, table, params)
  const result = await db.query<{ data: unknown }>(plan.sql, plan.params)

  const responseHeaders: Record<string, string> = { 'Content-Type': 'application/json' }

  if (prefer.countExact) {
    const countResult = await db.query<{ count: string }>(plan.countSql, plan.params)
    const total = parseInt(countResult.rows[0]?.count ?? '0', 10)
    const rangeOffset = plan.offset
    const rangeEnd = rangeOffset + result.rows.length - 1
    const rangeEndStr = result.rows.length === 0 ? '*' : `${rangeOffset}-${rangeEnd}`
    responseHeaders['Content-Range'] = `${rangeEndStr}/${total}`
  }

  return new Response(JSON.stringify(result.rows.map((row) => row.data)), {
    status: 200,
    headers: responseHeaders,
  })
}

async function handlePost(
  db: Queryable,
  table: string,
  req: Request,
): Promise<Response> {
  const prefer = parsePrefer(req.headers.get('Prefer'))
  const rawBody = await req.json()

  // Normalise to array for bulk insert support
  const rows = Array.isArray(rawBody)
    ? (rawBody as Record<string, unknown>[])
    : [rawBody as Record<string, unknown>]

  // Guard against empty array body
  if (rows.length === 0) {
    return new Response('[]', { status: 201, headers: { 'Content-Type': 'application/json' } })
  }

  // All rows must share the same column set (derived from first row)
  const cols = Object.keys(rows[0])
  const quotedCols = cols.map((c) => `"${validateIdentifier(c)}"`).join(', ')

  // Build multi-row VALUES clause
  const asJson = await writtenAsJson(db, table)
  const bindParams: unknown[] = []
  const valueClauses = rows.map((row) => {
    const placeholders = cols.map((c) => bindWritten(asJson, c, row[c], bindParams))
    return `(${placeholders.join(', ')})`
  })

  let conflict = ''
  if (prefer.ignoreDuplicates) {
    conflict = ' ON CONFLICT DO NOTHING'
  } else if (prefer.mergeDuplicates) {
    // Update all non-primary-key columns on conflict with (id)
    const updateCols = cols.filter((c) => c !== 'id')
    if (updateCols.length > 0) {
      const updateSet = updateCols.map((c) => `"${validateIdentifier(c)}"=EXCLUDED."${validateIdentifier(c)}"`).join(', ')
      conflict = ` ON CONFLICT (id) DO UPDATE SET ${updateSet}`
    } else {
      conflict = ' ON CONFLICT DO NOTHING'
    }
  }

  const returning = prefer.returnRepresentation ? ' RETURNING *' : ''
  const sql = `INSERT INTO "${table}" (${quotedCols}) VALUES ${valueClauses.join(', ')}${conflict}${returning}`
  const result = await db.query(sql, bindParams)

  if (prefer.returnRepresentation) {
    return new Response(JSON.stringify(result.rows), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Response(null, { status: 201 })
}

async function handlePatch(
  db: Queryable,
  table: string,
  url: URL,
  req: Request,
): Promise<Response> {
  const prefer = parsePrefer(req.headers.get('Prefer'))
  const body = (await req.json()) as Record<string, unknown>

  const asJson = await writtenAsJson(db, table)
  const bindParams: unknown[] = []
  const setCols = Object.keys(body)
  const setClause = setCols
    .map((c) => `"${validateIdentifier(c)}" = ${bindWritten(asJson, c, body[c], bindParams)}`)
    .join(', ')

  const where = writeWhere(url.searchParams, bindParams)
  const returning = prefer.returnRepresentation ? ' RETURNING *' : ''

  const sql = `UPDATE "${table}" SET ${setClause}${where}${returning}`
  const result = await db.query(sql, bindParams)

  if (prefer.returnRepresentation) {
    return new Response(JSON.stringify(result.rows), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Response(null, { status: 204 })
}

async function handleDelete(
  db: Queryable,
  table: string,
  url: URL,
): Promise<Response> {
  const bindParams: unknown[] = []
  const where = writeWhere(url.searchParams, bindParams)

  const sql = `DELETE FROM "${table}"${where}`
  await db.query(sql, bindParams)

  return new Response(null, { status: 204 })
}

/**
 * What PostgREST's `db-pre-request` hook does, for the browser tier.
 *
 * Both halves are required and neither is optional in effect. PGlite connects
 * as `postgres`, a superuser, and **superusers bypass RLS entirely** -- FORCE
 * does not reach them -- so without the role switch every policy is inert and
 * the browser silently sees every scope. Without the scopes, `current_scopes()`
 * returns empty and the floor hides everything. Omitting the option leaves both
 * unset, which is right only for a database that has no policies.
 */
export interface RestHandlerAuth {
  /** Resolves the subject's scopes for this request, as `subject_scopes` would. */
  scopes: (req: Request) => string[] | Promise<string[]>
  /** The non-superuser role policies are written against. */
  role?: string
}

/**
 * Applies a subject's scopes to a PGlite connection for the whole session.
 *
 * For the readers no request reaches: a browser-tier app queries its
 * collections directly. Call it at boot and on identity change.
 */
export async function applyScopeSession(
  db: PGlite,
  scopes: string[],
  role = 'app_user',
): Promise<void> {
  // One statement, not three awaited ones. Between a RESET and a SET the
  // connection is the PGlite superuser, which bypasses RLS entirely -- and the
  // connection is shared with the app's own live queries, so anything reading
  // inside that window would see every scope. `exec` sends them together, so
  // the window does not exist.
  await db.exec(`RESET ROLE;` + scopeSql(scopes, role, false))
}

/** `local` decides whether the setting dies with the transaction. */
function scopeSql(scopes: string[], role: string, local: boolean): string {
  for (const s of scopes) {
    if (s.includes(',')) {
      throw new Error(`Invalid scope ${s}: a comma would split it into two scopes`)
    }
  }
  return (
    `SELECT set_config('app.scopes', '${scopes.join(',').replace(/'/g, "''")}', ${local});` +
    `SET${local ? ' LOCAL' : ''} ROLE "${validateIdentifier(role)}";`
  )
}

/**
 * Creates a PostgREST-subset request handler backed by a PGlite instance.
 *
 * Usage:
 *   const handler = createRestHandler(pglite)
 *   const response = await handler(request)
 */
export function createRestHandler(
  db: PGlite,
  auth?: RestHandlerAuth,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      // Transaction-local, not session-level: PGlite is one connection, shared
      // with the app's own collection queries. `SET LOCAL` expires at commit,
      // and PGlite serialises transactions, so no two requests overlap.
      if (auth) {
        const scopes = await auth.scopes(req)
        const role = auth.role ?? 'app_user'
        const res = await db.transaction(async (tx) => {
          await tx.exec(scopeSql(scopes, role, true))
          return await route(tx, req)
        })
        // PGlite yields undefined for a transaction it rolled back without
        // throwing, and there is no response to send in that case.
        if (!res) throw new Error('request transaction rolled back')
        return res
      }
      return await route(db, req)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isValidationError = err instanceof ReadQueryError || message.startsWith('Invalid identifier:')
      return new Response(JSON.stringify({ error: message }), {
        status: isValidationError ? 400 : 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }
}

async function route(db: Queryable, req: Request): Promise<Response> {
  const url = new URL(req.url)
  // Extract first path segment as table name
  const segments = url.pathname.split('/').filter(Boolean)
  const table = segments[0]

  if (!table) {
    return new Response(JSON.stringify({ error: 'Missing table name' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Validate table name is a safe identifier before using it in SQL
  try {
    validateIdentifier(table)
  } catch {
    return new Response(JSON.stringify({ error: `Invalid table name: ${table}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Validate table exists
  const exists = await tableExists(db, table)
  if (!exists) {
    return new Response(
      JSON.stringify({ error: `Table "${table}" not found` }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }

  switch (req.method.toUpperCase()) {
    case 'GET':
      return await handleGet(db, table, url, req)
    case 'POST':
      return await handlePost(db, table, req)
    case 'PATCH':
      return await handlePatch(db, table, url, req)
    case 'DELETE':
      return await handleDelete(db, table, url)
    default:
      return new Response(
        JSON.stringify({ error: `Method ${req.method} not allowed` }),
        {
          status: 405,
          headers: { 'Content-Type': 'application/json' },
        },
      )
  }
}
