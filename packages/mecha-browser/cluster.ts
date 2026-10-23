// mecha's browser platform as one cluster behind one fetch handler, for the one
// user a single-file page has: PGlite runs the RLS bootstrap and the migrations,
// the user is minted at boot and every request is theirs, PostgREST answers
// /crud, and a shape server speaks Electric's protocol over a log the tables'
// triggers feed. The app's drains are called as their tables change
// (drains.ts), and its schedules are swept on a timer at the next instant one
// owes a tick (clock.ts): while the page is open, since nothing runs while it
// is closed, and at boot, which records what came due meanwhile, late where its
// lateness has passed, as any tier whose clock stopped does. Its bare imports
// are pinned in cluster.deno.json, which a bundler takes into its own map.
// Routes: /auth/guest, /auth/shape, /auth/whoami, /crud/*, /electric/v1/shape
// (shapes.ts).
import type { PGlite } from '@electric-sql/pglite'
import { createRestHandler } from '@mecha/postgrest-js'
import { encodeBase64Url } from 'jsr:@std/encoding@1.0.7/base64url'
import { shapeWhere } from '../../services/auth/jwt.ts'
import { createClock, hasSchedules, serviceCrud } from './clock.ts'
import { createDrains, type Drain, type Drains } from './drains.ts'
import { browserTier } from './fence.ts'
import { createShapes } from './shapes.ts'

export interface ClusterConfig {
  db: PGlite
  /** The database's scripts in order, each run through the browser tier's
   * fence: the bundler's are the edge's (pronto's edge-scripts.ts), mecha's
   * schedule table before the app's schedule seed among them. */
  sql: string[]
  /** Server tables that carry shapes. */
  tables: string[]
  schema?: Record<string, { durability?: string }>
  /** Where a request's failure is written before it is answered as a 500. */
  log: (line: string) => void
  /** Where a failure no request can answer is raised: a change whose row
   * could not be read back, after which every read of its table is a 410. */
  fail: (error: Error) => void
  drains?: Drain[]
  /** A frozen archive retains its schedules and runs none. */
  clock?: 'ticker' | 'disabled'
}

export interface Cluster {
  handle: (req: Request) => Promise<Response>
  drains: Drains
  /** Resolves when the clock's pass under way, if any, is done. */
  swept: () => Promise<void>
  /** Ends the drains and the clock once what is under way returns, for a
   * host that closes the database next. */
  stop: () => Promise<void>
}

/** setTimeout's longest wait; a farther instant is re-read when it fires. */
const LONGEST_WAIT = 2 ** 31 - 1

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
  const asService = createRestHandler(db, { role: 'service', scopes: () => [], claims: () => ({ role: 'service' }) })
  const inner = async (req: Request) => {
    const u = new URL(req.url)
    u.pathname = u.pathname.replace(/^\/crud/, '')
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
    return new Request(u, { method: req.method, headers: req.headers, body })
  }
  async function crud(req: Request): Promise<Response> {
    const r = await inner(req)
    const res = await serialize(() => rest(r))
    // A write may have armed a deadline (a machine's settle).
    if (ticks && res.ok && req.method !== 'GET' && req.method !== 'HEAD') await clock.arm()
    return res
  }

  const drains = await createDrains({ db, drains: cfg.drains ?? [], serialize, log })

  // The sweep writes through crud as the service role, as the ticker does.
  const crudAsService = serviceCrud(async (req) => {
    const r = await inner(req)
    return serialize(() => asService(r))
  })
  const ticks = cfg.clock !== 'disabled' && await serialize(() => hasSchedules(db))
  let timer: ReturnType<typeof setTimeout> | null = null
  let timerAt: number | null = null
  let stopped = false
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = timerAt = null
  }
  const clock = createClock({
    db, read: serialize, crud: crudAsService, ticks,
    timer: {
      get: () => Promise.resolve(timerAt),
      clear: () => Promise.resolve(clearTimer()),
      set: (at) => {
        clearTimer()
        if (stopped) return Promise.resolve()
        timerAt = at
        timer = setTimeout(() => {
          timer = timerAt = null
          sweep()
        }, Math.min(Math.max(at - Date.now(), 0), LONGEST_WAIT))
        return Promise.resolve()
      },
    },
  })
  function sweep() {
    clock.sweep('page').then(({ report }) => {
      for (const s of report.schedules) if (s.error !== undefined) log(`schedule ${s.schedule} failed: ${s.error}`)
    }).catch((e) => fail(e instanceof Error ? e : new Error(String(e))))
  }
  if (ticks) sweep()

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

  return {
    handle,
    drains,
    swept: () => clock.settled(),
    stop: async () => {
      stopped = true
      clearTimer()
      await clock.settled()
      clearTimer()
      await drains.stop()
    },
  }
}
