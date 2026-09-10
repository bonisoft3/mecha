import type { PGlite } from '@electric-sql/pglite'
import { validateIdentifier } from './validate.js'

// Operator map: PostgREST operator → SQL operator
const OP_MAP: Record<string, string> = {
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
}

interface Filter {
  col: string
  op: string
  value: string
}

function parseFilters(params: URLSearchParams): Filter[] {
  const filters: Filter[] = []
  for (const [key, val] of params.entries()) {
    if (key === 'select') continue
    const dotIdx = val.indexOf('.')
    if (dotIdx === -1) continue
    const op = val.slice(0, dotIdx)
    const value = val.slice(dotIdx + 1)
    if (op in OP_MAP || op === 'is' || op === 'in') {
      filters.push({ col: key, op, value })
    }
  }
  return filters
}

function buildWhereClause(
  filters: Filter[],
  params: unknown[],
): string {
  if (filters.length === 0) return ''

  const clauses = filters.map((f) => {
    const quotedCol = `"${validateIdentifier(f.col)}"`

    if (f.op === 'is') {
      // IS NULL / IS TRUE / IS FALSE — no parameter binding
      const upper = f.value.toUpperCase()
      if (upper === 'NULL') return `${quotedCol} IS NULL`
      if (upper === 'TRUE') return `${quotedCol} IS TRUE`
      if (upper === 'FALSE') return `${quotedCol} IS FALSE`
      return `${quotedCol} IS NULL`
    }

    if (f.op === 'in') {
      // value looks like (v1,v2,v3)
      const inner = f.value.replace(/^\(|\)$/g, '')
      const values = inner.split(',').map((v) => v.trim())
      const placeholders = values.map((v) => {
        params.push(v)
        return `$${params.length}`
      })
      return `${quotedCol} IN (${placeholders.join(', ')})`
    }

    const sqlOp = OP_MAP[f.op]
    params.push(f.value)
    return `${quotedCol} ${sqlOp} $${params.length}`
  })

  return ' WHERE ' + clauses.join(' AND ')
}

interface OrderTerm {
  col: string
  dir: 'ASC' | 'DESC'
  nulls: 'NULLS FIRST' | 'NULLS LAST' | null
}

function parseOrder(params: URLSearchParams): OrderTerm[] {
  const raw = params.get('order')
  if (!raw) return []
  return raw.split(',').map((term) => {
    const parts = term.trim().split('.')
    const col = parts[0]
    const dir = parts[1]?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'
    let nulls: OrderTerm['nulls'] = null
    for (const p of parts.slice(2)) {
      if (p.toLowerCase() === 'nullsfirst') nulls = 'NULLS FIRST'
      else if (p.toLowerCase() === 'nullslast') nulls = 'NULLS LAST'
    }
    return { col, dir, nulls }
  })
}

function buildOrderClause(terms: OrderTerm[]): string {
  if (terms.length === 0) return ''
  const parts = terms.map((t) => {
    const col = `"${validateIdentifier(t.col)}"`
    return t.nulls ? `${col} ${t.dir} ${t.nulls}` : `${col} ${t.dir}`
  })
  return ' ORDER BY ' + parts.join(', ')
}

function parsePagination(params: URLSearchParams): { limit: number | null; offset: number | null } {
  const limitRaw = params.get('limit')
  const offsetRaw = params.get('offset')
  const limit = limitRaw !== null && /^\d+$/.test(limitRaw) ? parseInt(limitRaw, 10) : null
  const offset = offsetRaw !== null && /^\d+$/.test(offsetRaw) ? parseInt(offsetRaw, 10) : null
  return { limit, offset }
}

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

async function handleGet(
  db: Queryable,
  table: string,
  url: URL,
  req: Request,
): Promise<Response> {
  const params = url.searchParams
  const prefer = parsePrefer(req.headers.get('Prefer'))

  const selectParam = params.get('select')
  const columns = selectParam
    ? selectParam
        .split(',')
        .map((c) => `"${validateIdentifier(c.trim())}"`)
        .join(', ')
    : '*'

  const filters = parseFilters(params)
  const bindParams: unknown[] = []
  const where = buildWhereClause(filters, bindParams)

  const order = buildOrderClause(parseOrder(params))
  const { limit, offset } = parsePagination(params)

  let limitClause = ''
  if (limit !== null) limitClause += ` LIMIT ${limit}`
  if (offset !== null) limitClause += ` OFFSET ${offset}`

  const sql = `SELECT ${columns} FROM "${table}"${where}${order}${limitClause}`
  const result = await db.query(sql, bindParams)

  const responseHeaders: Record<string, string> = { 'Content-Type': 'application/json' }

  if (prefer.countExact) {
    const countSql = `SELECT COUNT(*) AS count FROM "${table}"${where}`
    const countResult = await db.query<{ count: string }>(countSql, bindParams)
    const total = parseInt(countResult.rows[0]?.count ?? '0', 10)
    const rangeOffset = offset ?? 0
    const rangeEnd = rangeOffset + result.rows.length - 1
    const rangeEndStr = result.rows.length === 0 ? rangeOffset : rangeEnd
    responseHeaders['Content-Range'] = `${rangeOffset}-${rangeEndStr}/${total}`
  }

  return new Response(JSON.stringify(result.rows), {
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
  const bindParams: unknown[] = []
  const valueClauses = rows.map((row) => {
    const placeholders = cols.map((c) => {
      bindParams.push(row[c])
      return `$${bindParams.length}`
    })
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

  const bindParams: unknown[] = []
  const setCols = Object.keys(body)
  const setClause = setCols
    .map((c) => {
      bindParams.push(body[c])
      return `"${validateIdentifier(c)}" = $${bindParams.length}`
    })
    .join(', ')

  const filters = parseFilters(url.searchParams)
  const where = buildWhereClause(filters, bindParams)
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
  const filters = parseFilters(url.searchParams)
  const where = buildWhereClause(filters, bindParams)

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
      const isValidationError = message.startsWith('Invalid identifier:')
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
