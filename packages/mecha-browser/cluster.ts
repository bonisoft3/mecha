// mecha's browser platform as one cluster behind one fetch handler, for the one
// user a single-file page has: PGlite runs the RLS bootstrap and the migrations,
// the user is minted at boot and every request is theirs, PostgREST answers
// /crud, and a shape server speaks Electric's protocol over a log the tables'
// triggers feed. Its bare imports are pinned in cluster.deno.json, which a
// bundler takes into its own map.
// Routes: /auth/guest, /auth/shape, /auth/whoami, /crud/*, /electric/v1/shape
// (shapes.ts).
import type { PGlite } from '@electric-sql/pglite'
import { createRestHandler } from '@mecha/postgrest-js'
import { encodeBase64Url } from 'jsr:@std/encoding@1.0.7/base64url'
import { shapeWhere } from '../../services/auth/jwt.ts'
import { browserTier } from './fence.ts'
import { createShapes } from './shapes.ts'

export interface ClusterConfig {
  db: PGlite
  /** rls.sql first, then the app's migrations in order. */
  sql: string[]
  /** Server tables that carry shapes. */
  tables: string[]
  schema?: Record<string, { durability?: string }>
  /** Where a request's failure is written before it is answered as a 500. */
  log: (line: string) => void
  /** Where a failure no request can answer is raised: a change whose row
   * could not be read back, after which every read of its table is a 410. */
  fail: (error: Error) => void
}

export interface Cluster {
  handle: (req: Request) => Promise<Response>
}

type Row = Record<string, unknown>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// The shell reads a token's payload for the user it names, and nothing here
// checks a signature, so a token is its claims, unsigned.
const enc = new TextEncoder()
const token = (claims: Row) => `${encodeBase64Url(enc.encode('{"alg":"none","typ":"JWT"}'))}.${encodeBase64Url(enc.encode(JSON.stringify(claims)))}.`

export async function createCluster(cfg: ClusterConfig): Promise<Cluster> {
  const { db, log, fail } = cfg
  for (const sql of cfg.sql) await db.exec(browserTier(sql))

  // PGlite is one connection: requests are serialised so no two interleave,
  // and the user's claims are set once, session-wide, for RLS to read.
  let chain: Promise<unknown> = Promise.resolve()
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn)
    chain = p.catch(() => {})
    return p
  }
  const id = crypto.randomUUID()
  const user = { id, handle: `guest-${id.slice(0, 8)}`, guest: true }
  await db.query('INSERT INTO app_user (id, handle) VALUES ($1, $2)', [user.id, user.handle])
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: user.id, role: 'app_user', guest: user.guest })])
  const scopes = async () => (await db.query<{ s: string[] }>('SELECT subject_scopes($1) AS s', [user.id])).rows[0].s

  const shapes = await createShapes({ db, tables: cfg.tables, schema: cfg.schema, serialize, fail })

  const rest = createRestHandler(db, { role: 'app_user', scopes })
  async function crud(req: Request): Promise<Response> {
    const u = new URL(req.url)
    u.pathname = u.pathname.replace(/^\/crud/, '')
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
    const inner = new Request(u, { method: req.method, headers: req.headers, body })
    return serialize(() => rest(inner))
  }

  // The shell asks for a guest and later for a shape token: the one user
  // answers both, and a shape's predicate is what their scopes reach now.
  const session = () => json(200, { token: token({ sub: user.id, handle: user.handle, guest: user.guest }), user })
  async function shapeToken(req: Request): Promise<Response> {
    const body = (await req.json()) as { table?: string; key?: unknown }
    if (!body.table || !shapes.has(body.table)) return json(400, { error: 'table required' })
    if (body.key !== undefined) return json(400, { error: 'keyed shapes are not served here' })
    const where = shapeWhere(await serialize(scopes))
    // The client caches a shape token until expires_in; nothing here expires.
    return json(200, { token: token({ typ: 'shape', table: body.table, where }), table: body.table, where, expires_in: 86_400 })
  }

  async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    try {
      if (req.method === 'POST' && path === '/auth/guest') return session()
      if (req.method === 'POST' && path === '/auth/shape') return await shapeToken(req)
      if (req.method === 'GET' && path === '/auth/whoami') return json(200, user)
      if (path.startsWith('/crud/')) return await crud(req)
      if (path === '/electric/v1/shape') return await shapes.serve(req, () => serialize(scopes))
      return json(404, { error: `no route for ${path}` })
    } catch (e) {
      log(`cluster error on ${req.method} ${path}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      return json(500, { error: e instanceof Error ? e.message : String(e) })
    }
  }

  return { handle }
}
