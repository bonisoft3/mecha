// mecha's cluster for many subjects on one PGlite connection: guests minted
// with HS256 tokens, each request's role, scopes and claims set inside its own
// transaction (postgrest-js), and Electric's shape protocol answered for the
// subject a shape token names (mecha-browser's shapes.ts). The schema is the
// data directory's: nothing here migrates.
// Routes: /auth/guest, /auth/whoami, /auth/shape, /crud/*, /electric/v1/shape.
import type { PGlite } from '@electric-sql/pglite'
import { createRestHandler, type ReadSchema } from '@mecha/postgrest-js'
import { shapeWhere, signJwt, verifyJwt } from '../../../services/auth/jwt.ts'
import { createShapes } from '../../mecha-browser/shapes.ts'
import { publicSnapshot, PublicSnapshotCapacity, type PublicSnapshot } from './public-snapshot.ts'

export interface EdgeClusterConfig {
  db: PGlite
  /** Server tables that carry shapes. */
  tables: string[]
  schema?: ReadSchema & Record<string, { durability?: string }>
  /** The HS256 secret every token is signed with. */
  secret: string
  /** Where a request's failure is written before it is answered as a 500. */
  log: (line: string) => void
  /** A change whose row could not be read back: the shape log has a hole. */
  fail: (error: Error) => void
}

export interface EdgeCluster {
  handle: (req: Request) => Promise<Response>
  publicSnapshot<T>(generation: string, use: (snapshot: PublicSnapshot) => Promise<T>): Promise<T>
}

// The auth service's lifetimes (services/auth/main.ts).
const USER_TOKEN_TTL_S = 7 * 24 * 3600
const SHAPE_TOKEN_TTL_S = 900

type Claims = Record<string, unknown>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const now = () => Math.floor(Date.now() / 1000)

export async function createEdgeCluster(cfg: EdgeClusterConfig): Promise<EdgeCluster> {
  const { db, secret, log } = cfg
  // PGlite is one connection: every use of it is one link of this chain.
  let chain: Promise<unknown> = Promise.resolve()
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn)
    chain = p.catch(() => {})
    return p
  }
  let shapes: Awaited<ReturnType<typeof createShapes>>
  let shapesReady: Promise<void> | undefined
  // Anonymous rendering needs no change stream. Install its triggers before
  // the first API request can write, on the same chain as every snapshot.
  const ensureShapes = () => shapesReady ??= serialize(async () => {
    shapes = await createShapes({ db, tables: cfg.tables, schema: cfg.schema, serialize, fail: cfg.fail })
  })
  // services/auth/main.ts's tableScope: scope_id generated as the literal
  // 'public:' on a plain table no other inherits from.
  const publicOnly = async (table: string) => (await db.query<{ p: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      WHERE a.attrelid = to_regclass($1) AND a.attname = 'scope_id'
        AND a.attnotnull AND NOT a.attisdropped AND a.attgenerated = 's'
        AND c.relkind = 'r'
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhparent = a.attrelid)
        AND pg_catalog.pg_get_expr(d.adbin, d.adrelid) = $2) AS p`,
    [`public.${table}`, "'public:'::text"],
  )).rows[0].p
  const scopesOf = async (sub: string) => (await db.query<{ s: string[] }>('SELECT subject_scopes($1) AS s', [sub])).rows[0].s

  async function bearer(req: Request): Promise<Claims | null> {
    const auth = req.headers.get('authorization')
    return auth?.startsWith('Bearer ') ? await verifyJwt(secret, auth.slice('Bearer '.length)) : null
  }
  /** A session's claims, or null: a shape token is no session. */
  async function session(req: Request): Promise<Claims | null> {
    const claims = await bearer(req)
    return claims && claims.role === 'app_user' && typeof claims.sub === 'string' ? claims : null
  }

  async function guest(): Promise<Response> {
    const id = crypto.randomUUID()
    const handle = `guest-${id.slice(0, 8)}`
    await serialize(() => db.query('INSERT INTO app_user (id, handle) VALUES ($1, $2)', [id, handle]))
    const token = await signJwt(secret, { role: 'app_user', sub: id, handle, guest: true, exp: now() + USER_TOKEN_TTL_S })
    return json(200, { token, user: { id, handle, guest: true } })
  }

  async function whoami(req: Request): Promise<Response> {
    const claims = await session(req)
    if (!claims) return json(401, { error: 'invalid token' })
    return json(200, { id: claims.sub, handle: claims.handle })
  }

  async function shapeToken(req: Request): Promise<Response> {
    const claims = await session(req)
    if (!claims) return json(401, { error: 'invalid token' })
    const body = (await req.json()) as { table?: string; key?: unknown }
    if (!body.table || !shapes.has(body.table)) return json(400, { error: 'table required' })
    if (body.key !== undefined) return json(400, { error: 'keyed shapes are not served here' })
    // As the auth service mints it: a table whose every row is public by
    // construction takes `public:` alone, so every subject sends one `where`
    // and its shapes are one in the Worker's cache.
    const scopes = await serialize(async () => (await publicOnly(body.table!)) ? ['public:'] : await scopesOf(claims.sub as string))
    const where = shapeWhere(scopes)
    const token = await signJwt(secret, { typ: 'shape', table: body.table, where, sub: claims.sub, exp: now() + SHAPE_TOKEN_TTL_S })
    return json(200, { token, table: body.table, where, expires_in: SHAPE_TOKEN_TTL_S })
  }

  // As the stack's gate: the token names the table and the predicate the
  // client must send, compared by equality. What a request reaches is the
  // subject's scopes now, read where the log is filtered.
  async function shape(req: Request): Promise<Response> {
    const claims = await bearer(req)
    if (!claims || claims.typ !== 'shape' || typeof claims.sub !== 'string') return json(401, { error: 'invalid shape token' })
    const p = new URL(req.url).searchParams
    if (p.get('table') !== claims.table) return json(403, { error: 'table not authorized' })
    if (p.get('where') !== claims.where) return json(403, { error: 'where not authorized' })
    return shapes.serve(req, () => serialize(() => scopesOf(claims.sub as string)))
  }

  async function crud(req: Request): Promise<Response> {
    const claims = await session(req)
    if (!claims) return json(401, { error: 'invalid token' })
    const sub = claims.sub as string
    const u = new URL(req.url)
    u.pathname = u.pathname.replace(/^\/crud/, '')
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
    const inner = new Request(u, { method: req.method, headers: req.headers, body })
    const rest = createRestHandler(db, { role: 'app_user', scopes: () => scopesOf(sub), claims: () => claims }, cfg.schema)
    return serialize(() => rest(inner))
  }

  async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    try {
      await ensureShapes()
      if (req.method === 'POST' && path === '/auth/guest') return await guest()
      if (req.method === 'GET' && path === '/auth/whoami') return await whoami(req)
      if (req.method === 'POST' && path === '/auth/shape') return await shapeToken(req)
      if (path.startsWith('/crud/')) return await crud(req)
      if (path === '/electric/v1/shape') return await shape(req)
      return json(404, { error: `no route for ${path}` })
    } catch (e) {
      log(`cluster error on ${req.method} ${path}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      return json(500, { error: e instanceof Error ? e.message : String(e) })
    }
  }

  let pendingSnapshots = 0
  return {
    handle,
    async publicSnapshot(generation, use) {
      // Admit before joining the database chain; the renderer's queue cannot
      // see requests waiting here, and each snapshot also delays API writes.
      if (pendingSnapshots >= 16) throw new PublicSnapshotCapacity('public snapshot queue full')
      pendingSnapshots++
      try { return await serialize(() => publicSnapshot(db, generation, use, cfg.schema)) }
      finally { pendingSnapshots-- }
    },
  }
}
