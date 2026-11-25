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
// Routes: /auth/guest, /auth/shape, /auth/whoami, /auth/oidc, /auth/session/adopt, /auth/signout, /crud/*, /electric/v1/shape
// (shapes.ts).
import type { PGlite } from '@electric-sql/pglite'
import { createRestHandler } from '@mecha/postgrest-js'
import { encodeBase64Url } from 'jsr:@std/encoding@1.0.7/base64url'
import { shapeWhere } from '../../services/auth/where.ts'
import { createClock, hasSchedules, serviceCrud } from './clock.ts'
import { createDrains, type Drain, type Drains } from './drains.ts'
import { browserTier } from './fence.ts'
import { createShapes } from './shapes.ts'
import { createSnapshotCoordinator, NOTIFY_CHANNEL, type CoordinatorConfig } from '../compute-snapshot/src/index.ts'

export interface ClusterConfig {
  compute?: Pick<CoordinatorConfig, 'computations' | 'machine' | 'execute'>
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
  /** The time the clock and the computations read and wait on: the host's
   * own unless a driver holds it, as omnishell's terminal does under
   * `?clock=manual`. Given, its instant is also the session's `mecha.clock`. */
  time?: Time
}

/** An instant in ms, and a wait that calls `fire` once `ms` have passed on
 * the same clock, returning the wait's cancel. */
export interface Time {
  now: () => number
  after: (ms: number, fire: () => void) => () => void
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

/** The host's clock. */
export const hostTime: Time = {
  now: () => Date.now(),
  after: (ms, fire) => {
    const t = setTimeout(fire, Math.min(ms, LONGEST_WAIT))
    return () => clearTimeout(t)
  },
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
  const time = cfg.time ?? hostTime
  // Under a time the host gives, the database reads it too: the session's
  // `mecha.clock` holds its instant, set before the scripts and before every
  // pass through the connection, for a function the app points at it.
  const stamp = cfg.time === undefined ? null : async () => {
    await db.query(`SELECT set_config('mecha.clock', $1, false)`, [new Date(time.now()).toISOString()])
  }
  await stamp?.()
  for (const sql of cfg.sql) await db.exec(browserTier(sql))

  // PGlite is one connection: requests are serialised so no two interleave,
  // and the user's claims are set once, session-wide, for RLS to read.
  let chain: Promise<unknown> = Promise.resolve()
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = stamp === null ? fn : async () => { await stamp(); return fn() }
    const p = chain.then(run, run)
    chain = p.catch(() => {})
    return p
  }
  const FRUITS = [
    'acerola', 'amora', 'avocado', 'banana', 'caju', 'carambola', 'cherry', 'citrus',
    'coconut', 'cupuacu', 'fig', 'guava', 'jabuticaba', 'jackfruit', 'kiwi', 'lemon',
    'lime', 'lychee', 'mango', 'maracuja', 'melon', 'nectarine', 'olive', 'orange',
    'papaya', 'peach', 'pear', 'persimmon', 'pineapple', 'pitanga', 'plum', 'tangerine',
  ]
  const ANIMALS = [
    'albatross', 'armadillo', 'badger', 'capybara', 'chameleon', 'condor', 'dolphin', 'falcon',
    'flamingo', 'fox', 'gecko', 'heron', 'hummingbird', 'ibis', 'iguana', 'jaguar',
    'kingfisher', 'koala', 'lemur', 'lynx', 'macaw', 'manatee', 'meerkat', 'ocelot',
    'otter', 'owl', 'panda', 'pelican', 'penguin', 'quokka', 'tapir', 'toucan',
  ]
  const id = crypto.randomUUID()
  const hex = id.replaceAll('-', '').toLowerCase()
  const initHandle = `${FRUITS[(parseInt(hex.slice(0, 2), 16) || 0) % FRUITS.length]}-${ANIMALS[(parseInt(hex.slice(2, 4), 16) || 0) % ANIMALS.length]}-${hex.slice(-4) || '0000'}`
  const { rows: insertedRows } = await db.query<{ handle: string }>('INSERT INTO app_user (id, handle) VALUES ($1, $2) RETURNING handle', [id, initHandle])
  const user = { id, handle: insertedRows[0]?.handle ?? initHandle, guest: true }
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
  const compute = cfg.compute ? await createSnapshotCoordinator({ ...cfg.compute, db, serialize, now: time.now }) : null
  let computeTimer: (() => void) | null = null
  let computeStopped = false
  let computeRunning = false
  const computeError = (error: unknown) => fail(error instanceof Error ? error : new Error(String(error)))
  const armCompute = async () => {
    if (!compute || computeStopped || computeRunning) return
    const due = await compute.wakeAt()
    if (computeStopped || computeRunning) return
    computeTimer?.()
    computeTimer = due === null ? null : time.after(Math.max(0, due - time.now()), () => {
      computeTimer = null
      computeRunning = true
      void compute.resume().catch((e) => log(`compute retry: ${String(e)}`)).finally(() => { computeRunning = false }).then(armCompute).catch(computeError)
    })
  }
  const unlistenCompute = compute ? await db.listen(NOTIFY_CHANNEL, () => { void armCompute().catch(computeError) }) : null
  await armCompute()

  // The sweep writes through crud as the service role, as the ticker does.
  const crudAsService = serviceCrud(async (req) => {
    const r = await inner(req)
    return serialize(() => asService(r))
  })
  const ticks = cfg.clock !== 'disabled' && await serialize(() => hasSchedules(db))
  let timer: (() => void) | null = null
  let timerAt: number | null = null
  let stopped = false
  const clearTimer = () => {
    timer?.()
    timer = timerAt = null
  }
  const clock = createClock({
    db, read: serialize, crud: crudAsService, ticks, now: time.now,
    timer: {
      get: () => Promise.resolve(timerAt),
      clear: () => Promise.resolve(clearTimer()),
      set: (at) => {
        clearTimer()
        if (stopped) return Promise.resolve()
        timerAt = at
        timer = time.after(Math.max(at - time.now(), 0), () => {
          timer = timerAt = null
          sweep()
        })
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
      // The browser tier turns no provider on: a page signs in as a guest.
      if (req.method === 'GET' && path === '/auth/oidc') return json(200, { providers: [], credential: {} })
      // Browser-tier sessions live solely in memory with no cookie handoff.
      if (req.method === 'POST' && (path === '/auth/session/adopt' || path === '/auth/signout')) return new Response(null, { status: 204 })
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
      computeStopped = true
      computeTimer?.()
      await unlistenCompute?.()
      await compute?.stop()
      clearTimer()
      await clock.settled()
      clearTimer()
      await drains.stop()
    },
  }
}
