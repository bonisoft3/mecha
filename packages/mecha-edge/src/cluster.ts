// mecha's cluster for many subjects on one PGlite connection: guests minted
// with HS256 tokens, each request's role, scopes and claims set inside its own
// transaction (postgrest-js), and Electric's shape protocol answered for the
// subject a shape token names (mecha-browser's shapes.ts), and the app's
// drains called as their tables change (mecha-browser's drains.ts).
// Routes: /auth/guest, /auth/whoami, /auth/shape, /auth/register/start,
// /auth/register/verify, /auth/login/start, /auth/login/verify, /crud/*,
// /electric/v1/shape.
import type { PGlite } from '@electric-sql/pglite'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { createRestHandler, planRead, ReadQueryError, type ReadSchema } from '@mecha/postgrest-js'
import { shapeWhere, signJwt, verifyJwt } from '../../../services/auth/jwt.ts'
import { createDrains, type Drain, type Drains } from '../../mecha-browser/drains.ts'
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
  drains?: Drain[]
  /** The earliest retry of a failed drain moved (drains.ts). */
  retry?: () => void
  rpId?: string
  origin?: string
}

export interface EdgeCluster {
  handle: (req: Request) => Promise<Response>
  /** A /crud/* request as the service role, for the object's own clock:
   * what the ticker writes on the container tier. Never routed. */
  service: (req: Request) => Promise<Response>
  serialize: <T>(fn: () => Promise<T>, priority?: 'high' | 'low') => Promise<T>
  publicSnapshot<T>(generation: string, use: (snapshot: PublicSnapshot) => Promise<T>, priority?: 'high' | 'low'): Promise<T>
  /** The drains, installed and called once on first use: never by a boot
   * that only migrates, whose drains may name tables the migration makes. */
  drains: () => Promise<Drains>
  /** The drains once installed, or null. */
  installed: () => Drains | null
}

// The auth service's lifetimes (services/auth/main.ts).
const USER_TOKEN_TTL_S = 7 * 24 * 3600
const SHAPE_TOKEN_TTL_S = 900
const STATE_TTL_S = 300

const enc = new TextEncoder()
const ADJECTIVES = ['amber', 'brisk', 'calm', 'dusk', 'ember', 'fern', 'gold', 'hazel', 'ivory', 'jade', 'kind', 'lunar', 'mellow', 'noble', 'ochre', 'pale', 'quiet', 'rustic', 'sage', 'tidal']
const NOUNS = ['fox', 'wren', 'otter', 'pine', 'reed', 'moth', 'lark', 'moss', 'dune', 'cove', 'elk', 'finch', 'heron', 'ibis', 'kite', 'lynx', 'newt', 'orca', 'quail', 'seal']
function generateHandle(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${a}-${n}-${10 + Math.floor(Math.random() * 90)}`
}

type Claims = Record<string, unknown>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const now = () => Math.floor(Date.now() / 1000)

export async function createEdgeCluster(cfg: EdgeClusterConfig): Promise<EdgeCluster> {
  const { db, secret, log } = cfg
  // PGlite is one connection: interactive renders and API reads/writes take
  // the high lane ahead of background shape tokens, subset snapshots, and
  // prefetches, with 1 low turn after every 4 consecutive high turns.
  let running = false
  let highStreak = 0
  const high: Array<() => void> = []
  const low: Array<() => void> = []
  function pump() {
    if (running) return
    const takeLow = low.length > 0 && (high.length === 0 || highStreak >= 4)
    const next = takeLow ? low.shift() : high.shift()
    if (!next) return
    highStreak = takeLow ? 0 : highStreak + 1
    running = true
    next()
  }
  function serialize<T>(fn: () => Promise<T>, priority: 'high' | 'low' = 'high'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      ;(priority === 'high' ? high : low).push(() => {
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
          running = false
          pump()
        })
      })
      pump()
    })
  }
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
  const createAuthTables = async () => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS webauthn_credential (
        id text primary key,
        user_id uuid not null references app_user(id) on delete cascade,
        public_key bytea not null,
        counter bigint not null default 0
      );
      ALTER TABLE webauthn_credential ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON webauthn_credential FROM PUBLIC;
      DO $$
      DECLARE
        r text;
      BEGIN
        FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('app_user', 'service', 'anon') LOOP
          EXECUTE format('REVOKE ALL ON webauthn_credential FROM %I', r);
        END LOOP;
      END $$;
    `)
  }
  const ensureAuthTables = () => authTablesReady ??= serialize(createAuthTables).catch((e) => {
    authTablesReady = undefined
    throw e
  })

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

  async function readState(body: Record<string, unknown>, purpose: string): Promise<Record<string, unknown> | null> {
    if (typeof body.state !== 'string') return null
    const claims = await verifyJwt(secret, body.state)
    return claims && claims.purpose === purpose ? claims : null
  }

  async function registerStart(req: Request): Promise<Response> {
    const hasAuth = req.headers.has('authorization')
    const claims = hasAuth ? await session(req) : null
    if (hasAuth && !claims) return json(401, { error: 'invalid token' })
    if (claims && claims.guest !== true) return json(409, { error: 'already an account' })
    const promote = claims !== null
    const handle = claims ? (claims.handle as string) : generateHandle()
    const userId = claims ? (claims.sub as string) : crypto.randomUUID()
    const rpId = cfg.rpId ?? new URL(req.url).hostname
    const options = await generateRegistrationOptions({
      rpName: rpId,
      rpID: rpId,
      userName: handle,
      userID: enc.encode(userId),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
    })
    const state = await signJwt(secret, {
      purpose: 'register',
      handle,
      userId,
      promote,
      challenge: options.challenge,
      exp: now() + STATE_TTL_S,
    })
    return json(200, { ...options, state })
  }

  async function registerVerify(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return json(400, { error: 'invalid json body' })
    const st = await readState(body, 'register')
    if (!st) return json(401, { error: 'invalid state' })
    const rpId = cfg.rpId ?? new URL(req.url).hostname
    const origin = cfg.origin ?? new URL(req.url).origin
    let verification
    try {
      verification = await verifyRegistrationResponse({
        // deno-lint-ignore no-explicit-any
        response: body.response as any,
        expectedChallenge: st.challenge as string,
        expectedOrigin: origin,
        expectedRPID: rpId,
        requireUserVerification: false,
      })
    } catch {
      return json(401, { error: 'registration verification failed' })
    }
    if (!verification.verified || !verification.registrationInfo) {
      return json(401, { error: 'registration verification failed' })
    }
    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo
    const userId = st.userId as string
    await ensureAuthTables()
    if (st.promote === true) {
      const added = await serialize(() =>
        db.query(
          `INSERT INTO webauthn_credential (id, user_id, public_key, counter)
           SELECT $1, $2, $3, $4
           WHERE NOT EXISTS (SELECT 1 FROM webauthn_credential WHERE user_id = $2)`,
          [credentialID, userId, credentialPublicKey, counter],
        ),
      )
      if (added.affectedRows === 0) return json(409, { error: 'already an account' })
      const token = await signJwt(secret, { role: 'app_user', sub: userId, handle: st.handle, exp: now() + USER_TOKEN_TTL_S })
      return json(200, { token, user: { id: userId, handle: st.handle } })
    }
    let handle = st.handle as string
    let inserted = false
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      try {
        await serialize(async () => {
          await db.query('BEGIN')
          try {
            await db.query('INSERT INTO app_user (id, handle) VALUES ($1, $2)', [userId, handle])
            await db.query(
              'INSERT INTO webauthn_credential (id, user_id, public_key, counter) VALUES ($1, $2, $3, $4)',
              [credentialID, userId, credentialPublicKey, counter],
            )
            await db.query('COMMIT')
          } catch (e) {
            await db.query('ROLLBACK')
            throw e
          }
        })
        inserted = true
      } catch (e) {
        if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === '23505') {
          handle = generateHandle()
        } else {
          throw e
        }
      }
    }
    if (!inserted) return json(500, { error: 'could not allocate identity' })
    const token = await signJwt(secret, { role: 'app_user', sub: userId, handle, exp: now() + USER_TOKEN_TTL_S })
    return json(200, { token, user: { id: userId, handle } })
  }

  async function loginStart(req: Request): Promise<Response> {
    const rpId = cfg.rpId ?? new URL(req.url).hostname
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      allowCredentials: [],
    })
    const state = await signJwt(secret, {
      purpose: 'login',
      challenge: options.challenge,
      exp: now() + STATE_TTL_S,
    })
    return json(200, { ...options, state })
  }

  async function loginVerify(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return json(400, { error: 'invalid json body' })
    const st = await readState(body, 'login')
    if (!st) return json(401, { error: 'invalid state' })
    const response = body.response as { id?: string } | undefined
    if (!response || typeof response.id !== 'string') {
      return json(401, { error: 'authentication verification failed' })
    }
    await ensureAuthTables()
    const { rows: creds } = await serialize(() =>
      db.query<{ id: string; public_key: Uint8Array; counter: number | bigint; user_id: string; handle: string }>(
        `SELECT c.id, c.public_key, c.counter, c.user_id, u.handle
         FROM webauthn_credential c JOIN app_user u ON u.id = c.user_id
         WHERE c.id = $1`,
        [response.id],
      ),
    )
    if (creds.length === 0) return json(401, { error: 'authentication verification failed' })
    const cred = creds[0]
    const rpId = cfg.rpId ?? new URL(req.url).hostname
    const origin = cfg.origin ?? new URL(req.url).origin
    let verification
    try {
      verification = await verifyAuthenticationResponse({
        // deno-lint-ignore no-explicit-any
        response: body.response as any,
        expectedChallenge: st.challenge as string,
        expectedOrigin: origin,
        expectedRPID: rpId,
        requireUserVerification: false,
        authenticator: {
          credentialID: cred.id,
          credentialPublicKey: cred.public_key instanceof Uint8Array ? cred.public_key : new Uint8Array(cred.public_key),
          counter: Number(cred.counter),
        },
      })
    } catch {
      return json(401, { error: 'authentication verification failed' })
    }
    if (!verification.verified) return json(401, { error: 'authentication verification failed' })
    await serialize(() =>
      db.query('UPDATE webauthn_credential SET counter = $1 WHERE id = $2', [
        verification.authenticationInfo.newCounter,
        cred.id,
      ]),
    )
    const token = await signJwt(secret, { role: 'app_user', sub: cred.user_id, handle: cred.handle, exp: now() + USER_TOKEN_TTL_S })
    return json(200, { token, user: { id: cred.user_id, handle: cred.handle } })
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
      : await serialize(async () => (await publicOnly(table)) ? ['public:'] : await scopesOf(claims.sub as string), 'low')
    const where = shapeWhere(scopes)
    const token = await signJwt(secret, { typ: 'shape', table, where, sub: claims.sub, exp: now() + SHAPE_TOKEN_TTL_S })
    return json(200, { token, table, where, expires_in: SHAPE_TOKEN_TTL_S })
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
    const table = claims.table as string
    const reachOf = () => publicCache.get(table) === true
      ? Promise.resolve(['public:'])
      : serialize(async () => (await publicOnly(table)) ? ['public:'] : await scopesOf(claims.sub as string), 'low')
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
    if (!claims) return json(401, { error: 'invalid token' })
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
      await drains()
      if (req.method === 'POST' && path === '/auth/guest') return await guest()
      if (req.method === 'GET' && path === '/auth/whoami') return await whoami(req)
      if (req.method === 'POST' && path === '/auth/shape') return await shapeToken(req)
      if (req.method === 'POST' && path === '/auth/register/start') return await registerStart(req)
      if (req.method === 'POST' && path === '/auth/register/verify') return await registerVerify(req)
      if (req.method === 'POST' && path === '/auth/login/start') return await loginStart(req)
      if (req.method === 'POST' && path === '/auth/login/verify') return await loginVerify(req)
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
    drains,
    serialize,
    installed: () => installed,
    async publicSnapshot(generation, use, priority = 'high') {
      // Admit per lane before joining the database queue so queued low-priority
      // prefetches cannot starve interactive renders, and each lane stays bounded.
      if (pendingSnapshots[priority] >= 16) throw new PublicSnapshotCapacity('public snapshot queue full')
      pendingSnapshots[priority]++
      try {
        await drains()
        return await serialize(() => publicSnapshot(db, generation, use, cfg.schema), priority)
      }
      finally { pendingSnapshots[priority]-- }
    },
  }
}
