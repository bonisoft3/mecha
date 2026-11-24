// mecha's cluster for many subjects on one PGlite connection: guests minted
// with HS256 tokens, each request's role, scopes and claims set inside its own
// transaction (postgrest-js), and Electric's shape protocol answered for the
// subject a shape token names (mecha-browser's shapes.ts), and the app's
// drains called as their tables change (mecha-browser's drains.ts).
// Routes: /auth/guest, /auth/refresh, /auth/account, /auth/rename, /auth/whoami,
// /auth/shape, /auth/register/start, /auth/register/verify, /auth/login/start,
// /auth/login/verify, /auth/oidc/*, /auth/session*, /auth/signout, /crud/*,
// /electric/v1/shape.
import type { PGlite } from '@electric-sql/pglite'
import { createRestHandler, planRead, ReadQueryError, type ReadSchema } from '@mecha/postgrest-js'
import { type AuthDb, authCore, type Row } from '../../../services/auth/core.ts'
import {
  androidOrigins,
  isSession,
  nativeSchemesFrom,
  signJwt,
  verifyJwt,
} from '../../../services/auth/jwt.ts'
import { PUBLIC_WHERE, shapeWhere } from '../../../services/auth/where.ts'
import type { Provider } from '../../../services/auth/oidc.ts'
import { AUTH_TABLES, EVOLVE_AUTH_TABLES, prepareAuthTables, LINK_PER_PROVIDER, sealAuthTables, STAMP_EFFECTS } from '../../../services/auth/schema.ts'
import { createDrains, type Drain, type Drains } from '../../mecha-browser/drains.ts'
import { createShapes } from '../../mecha-browser/shapes.ts'
import { publicSnapshot, PublicSnapshotCapacity, PUBLIC_SNAPSHOT_LIMIT, type PublicSnapshot } from './public-snapshot.ts'
import { createSnapshotCoordinator, NOTIFY_CHANNEL, type BatchMachine, type Computation, type Output, type Snapshot, type SnapshotCoordinator, type SnapshotIdentity } from '../../compute-snapshot/src/index.ts'
import { lanes } from './lanes.ts'

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
  drains?: Drain[]
  /** The earliest retry of a failed drain moved (drains.ts). */
  retry?: () => void
  compute?: { computations: Computation[]; machine: BatchMachine; retainSnapshot?(identity: SnapshotIdentity): Promise<void>; execute?(snapshot: Snapshot): Promise<Output>; changed(): void }
  rpId?: string
  origin?: string
  androidApkKeyHashes?: string | readonly string[]
  nativeSchemes?: string | readonly string[]
  providers?: Record<string, Provider>
  fetcher?: typeof fetch
}

export interface EdgeCluster {
  handle: (req: Request) => Promise<Response>
  /** A /crud/* request as the service role, for the object's own clock:
   * what the ticker writes on the container tier. Never routed. */
  service: (req: Request) => Promise<Response>
  /** Runs `fn` on the cluster's serialized PGlite queue after shape triggers
   * are installed. */
  serialize: <T>(fn: () => Promise<T>, priority?: 'high' | 'low') => Promise<T>
  publicSnapshot<T>(generation: string, use: (snapshot: PublicSnapshot) => Promise<T>, priority?: 'high' | 'low'): Promise<T>
  /** The drains, installed and called once on first use: never by a boot
   * that only migrates, whose drains may name tables the migration makes. */
  drains: () => Promise<Drains>
  /** The drains once installed, or null. */
  installed: () => Drains | null
  compute(): Promise<SnapshotCoordinator | null>
  read<T>(use: () => Promise<T>): Promise<T>
}

// The auth service's lifetimes (services/auth/main.ts).
const USER_TOKEN_TTL_S = 7 * 24 * 3600
const REFRESH_TOKEN_TTL_S = 90 * 24 * 3600
const SHAPE_TOKEN_TTL_S = 900
const STATE_TTL_S = 300

const enc = new TextEncoder()
type Claims = Record<string, unknown>

function json(status: number, body: unknown, cookies: string[] = []): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  for (const c of cookies) headers.append('set-cookie', c)
  return new Response(JSON.stringify(body), { status, headers })
}

const now = () => Math.floor(Date.now() / 1000)

export async function createEdgeCluster(cfg: EdgeClusterConfig): Promise<EdgeCluster> {
  const { db, secret, log } = cfg
  const allowedAndroidOrigins = androidOrigins(cfg.androidApkKeyHashes)
  const allowedNativeSchemes = nativeSchemesFrom(cfg.nativeSchemes)
  const lane = lanes()
  // Interactive API work takes the api lane, a shape's reach among it: a screen mounts only once
  // its shapes answer, and in the low lane that waited behind every render and background drain.
  // Subset snapshots and prefetches take the low one.
  const serialize = <T>(fn: () => Promise<T>, priority: 'high' | 'low' = 'high'): Promise<T> =>
    lane(fn, priority === 'high' ? 'api' : 'low')
  const serializeLow = <T>(fn: () => Promise<T>): Promise<T> => serialize(fn, 'low')
  let shapes: Awaited<ReturnType<typeof createShapes>>
  let shapesReady: Promise<void> | undefined
  const publicCache = new Map<string, boolean>()
  // services/auth/main.ts's tableScope: every base table the relation reaches
  // has scope_id generated as the literal 'public:' with no inheriting child.
  const warmPublicCache = async (tables: string[]) => {
    if (tables.length === 0) return
    const { rows } = await db.query<{ name: string; p: boolean }>(
      `WITH RECURSIVE input(name, oid) AS (
        SELECT t, to_regclass('public.' || t)::oid
        FROM unnest($1::text[]) AS t
      ),
      deps(name, oid) AS (
        SELECT name, oid FROM input WHERE oid IS NOT NULL
        UNION
        SELECT deps.name, d.refobjid
        FROM deps
        JOIN pg_catalog.pg_rewrite r ON r.ev_class = deps.oid
        JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::regclass
          AND d.objid = r.oid
          AND d.refclassid = 'pg_catalog.pg_class'::regclass
          AND d.refobjid <> deps.oid
      )
      SELECT i.name,
        (i.oid IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM deps
          LEFT JOIN pg_catalog.pg_class c ON c.oid = deps.oid
          WHERE deps.name = i.name AND (
            c.oid IS NULL
            OR c.relkind NOT IN ('r', 'v')
            OR (c.relkind = 'r' AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.pg_attribute a
              JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
              WHERE a.attrelid = c.oid AND a.attname = 'scope_id'
                AND a.attnotnull AND NOT a.attisdropped AND a.attgenerated = 's'
                AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhparent = c.oid)
                AND pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) = $2
            ))
          )
        )) AS p
      FROM input i`,
      [tables, "'public:'::text"],
    )
    for (const row of rows) publicCache.set(row.name, row.p)
  }
  let authTablesReady: Promise<void> | undefined
  // The passkeys and identity links live in mecha_auth, as the host auth
  // service keeps them (services/auth/schema.ts); the REST handler serves
  // public alone.
  const createAuthTables = async () => {
    await db.transaction(async (tx) => {
      await tx.exec(prepareAuthTables(AUTH_TABLES))
      await tx.exec(EVOLVE_AUTH_TABLES)
      await tx.exec(LINK_PER_PROVIDER)
      await tx.exec(STAMP_EFFECTS)
      await tx.exec(sealAuthTables(AUTH_TABLES))
    })
  }
  const ensureAuthTables = () => authTablesReady ??= serialize(createAuthTables).catch((e) => {
    authTablesReady = undefined
    throw e
  })
  // Before the cluster answers anything: an earlier release's table in public
  // moves, and the grants are taken back, where the cluster keeps auth tables.
  // One that has none makes its tables at the first ceremony.
  {
    const { rows: [held] } = await db.query<{ auth: boolean }>(
      `SELECT to_regclass('public.webauthn_credential') IS NOT NULL OR to_regclass('public.identity_link') IS NOT NULL OR to_regnamespace('mecha_auth') IS NOT NULL AS auth`,
    )
    if (held.auth) await ensureAuthTables()
  }

  // Anonymous rendering needs no change stream. Install its triggers before
  // the first API request can write, on the high-priority database lane.
  const ensureShapes = () => shapesReady ??= serialize(async () => {
    shapes = await createShapes({ db, tables: cfg.tables, schema: cfg.schema, serialize, serializeLow, fail: cfg.fail })
    await warmPublicCache(cfg.tables)
  })
  let drainsReady: Promise<Drains> | undefined
  let installed: Drains | null = null
  // An install that failed is tried again by the next use, not kept. Drains
  // are background work, so they take the low lane.
  const drains = () => drainsReady ??= createDrains({ db, drains: cfg.drains ?? [], serialize: serializeLow, log, retry: cfg.retry })
    .then((d) => installed = d, (e) => {
      drainsReady = undefined
      throw e
    })
  let computeReady: Promise<SnapshotCoordinator | null> | undefined
  const compute = () => computeReady ??= (async () => {
    if (!cfg.compute?.computations.length) return null
    await ensureShapes()
    const coordinator = await createSnapshotCoordinator({ db, serialize: serializeLow, ...cfg.compute })
    await serializeLow(() => db.listen(NOTIFY_CHANNEL, () => cfg.compute!.changed()))
    return coordinator
  })().catch(error => { computeReady = undefined; throw error })
  const publicOnly = async (table: string) => {
    const hit = publicCache.get(table)
    if (hit !== undefined) return hit
    await warmPublicCache([table])
    const warmed = publicCache.get(table)
    if (warmed === undefined) throw new Error(`public cache did not warm ${table}`)
    return warmed
  }
  const scopesOf = async (sub: string) => (await db.query<{ s: string[] }>('SELECT subject_scopes($1) AS s', [sub])).rows[0].s

  async function bearer(req: Request): Promise<Claims | null> {
    const auth = req.headers.get('authorization')
    return auth?.startsWith('Bearer ') ? await verifyJwt(secret, auth.slice('Bearer '.length)) : null
  }
  /** A session's claims, or null: a shape token is no session. */
  async function session(req: Request): Promise<Claims | null> {
    const claims = await bearer(req)
    return isSession(claims) ? claims : null
  }

  // The auth routes (services/auth/core.ts) on this cluster's PGlite: every
  // statement takes the api lane, and a transaction holds it from BEGIN to its end.
  const authDb: AuthDb = {
    async query(text, params) {
      await ensureAuthTables()
      return (await serialize(() => db.query<Row>(text, params))).rows
    },
    async tx(fn) {
      await ensureAuthTables()
      return await serialize(async () => {
        await db.query('BEGIN')
        try {
          const done = await fn(async (text, params) => (await db.query<Row>(text, params)).rows)
          await db.query('COMMIT')
          return done
        } catch (e) {
          await db.query('ROLLBACK')
          throw e
        }
      })
    },
  }
  const door = (req: Request) => cfg.origin ?? new URL(req.url).origin
  const auth = authCore({
    db: authDb,
    secret,
    rpId: (req) => cfg.rpId ?? new URL(req.url).hostname,
    origin: door,
    ceremonyOrigins: (req) => [door(req), ...allowedAndroidOrigins],
    providers: cfg.providers ?? {},
    nativeSchemes: allowedNativeSchemes,
    fetcher: cfg.fetcher,
  })

  /** A session's subject while its account is there: a token outlives its
   * account's deletion, and reaches nothing after it. */
  async function live(claims: Claims): Promise<boolean> {
    const { rows } = await serialize(() => db.query('SELECT 1 FROM app_user WHERE id = $1::uuid', [claims.sub]))
    return rows.length === 1
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
    const table = body.table
    const scopes = publicCache.get(table) === true
      ? ['public:']
      : await serialize(async () => (await publicOnly(table)) ? ['public:'] : await scopesOf(claims.sub as string))
    const where = shapeWhere(scopes)
    const token = await signJwt(secret, { typ: 'shape', table, where, sub: claims.sub, exp: now() + SHAPE_TOKEN_TTL_S })
    return json(200, { token, table, where, expires_in: SHAPE_TOKEN_TTL_S })
  }

  // As the stack's gate: the token names the table and the predicate the
  // client must send, compared by equality. What a request reaches is the
  // subject's scopes now, read where the log is filtered.
  async function shape(req: Request): Promise<Response> {
    const claims = await bearer(req)
    const p = new URL(req.url).searchParams
    // A session stands for its own public shapes, as the auth service's gate admits them.
    if (isSession(claims)) {
      const table = p.get('table')
      if (!table || !shapes.has(table)) return json(403, { error: 'table not authorized' })
      if (p.get('where') !== PUBLIC_WHERE) return json(403, { error: 'where not authorized' })
      return shapes.serve(req, () => Promise.resolve(['public:']))
    }
    if (!claims || claims.typ !== 'shape' || typeof claims.sub !== 'string') return json(401, { error: 'invalid shape token' })
    if (p.get('table') !== claims.table) return json(403, { error: 'table not authorized' })
    if (p.get('where') !== claims.where) return json(403, { error: 'where not authorized' })
    const table = claims.table as string
    const reachOf = () => publicCache.get(table) === true
      ? Promise.resolve(['public:'])
      : serialize(async () => (await publicOnly(table)) ? ['public:'] : await scopesOf(claims.sub as string))
    return shapes.serve(req, reachOf)
  }

  async function isPublicRead(table: string, search: URLSearchParams): Promise<boolean> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !(await publicOnly(table))) return false
    if (!(search.get('select') ?? '').includes('(')) return true
    try {
      const plan = await planRead(db, table, search, cfg.schema)
      return !plan.computed && (await Promise.all(plan.tables.map(publicOnly))).every(Boolean)
    } catch (e) {
      if (e instanceof ReadQueryError) return false
      throw e
    }
  }

  async function crud(req: Request): Promise<Response> {
    const claims = await session(req)
    if (!claims || !(await live(claims))) return json(401, { error: 'invalid token' })
    const sub = claims.sub as string
    const u = new URL(req.url)
    u.pathname = u.pathname.replace(/^\/crud/, '')
    const table = u.pathname.split('/').filter(Boolean)[0] ?? ''
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
    const headers = new Headers(req.headers)
    // As the container tier's proxy sets it (services/proxy/Caddyfile): a
    // POST repeating a primary key is absorbed, not refused, so at-least-once
    // delivery is safe at this boundary.
    if (req.method === 'POST') headers.set('prefer', 'return=representation,resolution=ignore-duplicates')
    const inner = new Request(u, { method: req.method, headers, body })
    return serialize(async () => {
      const shared = (req.method === 'GET' || req.method === 'HEAD') && await isPublicRead(table, u.searchParams)
      const rest = createRestHandler(
        db,
        shared
          ? { role: 'app_user', scopes: () => ['public:'], claims: () => ({ role: 'app_user' }) }
          : { role: 'app_user', scopes: () => scopesOf(sub), claims: () => claims },
        cfg.schema,
      )
      const res = await rest(inner)
      if (shared && res.status === 200) res.headers.set('x-mecha-scope', 'public')
      return res
    })
  }

  async function service(req: Request): Promise<Response> {
    await ensureShapes()
    await compute()
    await drains()
    const u = new URL(req.url)
    u.pathname = u.pathname.replace(/^\/crud/, '')
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
    const inner = new Request(u, { method: req.method, headers: req.headers, body })
    return serialize(() => createRestHandler(db, { role: 'service', scopes: () => [], claims: () => ({ role: 'service' }) }, cfg.schema)(inner))
  }

  async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    try {
      await ensureShapes()
      await compute()
      await drains()
      const answered = auth.route(req)
      if (answered !== null) return await answered
      if (req.method === 'POST' && path === '/auth/shape') return await shapeToken(req)
      if (path.startsWith('/crud/')) return await crud(req)
      if (path === '/electric/v1/shape') return await shape(req)
      return json(404, { error: `no route for ${path}` })
    } catch (e) {
      log(`cluster error on ${req.method} ${path}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      return json(500, { error: e instanceof Error ? e.message : String(e) })
    }
  }

  const pendingSnapshots = { high: 0, low: 0 }
  return {
    handle,
    service,
    async serialize<T>(fn: () => Promise<T>, priority: 'high' | 'low' = 'high'): Promise<T> {
      await ensureShapes()
      return await serialize(fn, priority)
    },
    drains,
    installed: () => installed,
    compute,
    read: serializeLow,
    async publicSnapshot(generation, use, priority = 'high') {
      // Admit per lane before joining the database queue so queued low-priority
      // prefetches cannot starve interactive renders, and each lane stays bounded.
      if (pendingSnapshots[priority] >= PUBLIC_SNAPSHOT_LIMIT) throw new PublicSnapshotCapacity('public snapshot queue full')
      pendingSnapshots[priority]++
      try {
        await drains()
        return await lane(() => publicSnapshot(db, generation, use, cfg.schema, priority), priority === 'high' ? 'render' : 'background-render')
      }
      finally { pendingSnapshots[priority]-- }
    },
  }
}
