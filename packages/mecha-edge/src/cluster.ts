// mecha's cluster for many subjects on one PGlite connection: guests minted
// with HS256 tokens, each request's role, scopes and claims set inside its own
// transaction (postgrest-js), and Electric's shape protocol answered for the
// subject a shape token names (mecha-browser's shapes.ts), and people signed
// in by a passkey (the auth service's passkey.ts) or through the providers the
// environment names (its oidc.ts), over this connection. The schema is the data
// directory's: nothing here migrates but webauthn_credential and identity_link,
// which the auth service makes for itself too.
// Routes: /auth/guest, /auth/whoami, /auth/shape, /auth/register/*,
// /auth/login/*, /auth/oidc/*, /crud/*, /electric/v1/shape.
import type { PGlite } from '@electric-sql/pglite'
import { createRestHandler, planRead, ReadQueryError, type ReadSchema } from '@mecha/postgrest-js'
import { generateHandle } from '../../../services/auth/handle.ts'
import { shapeWhere, signJwt, verifyJwt } from '../../../services/auth/jwt.ts'
import { type Links, oidc, type Profile, type Provider } from '../../../services/auth/oidc.ts'
import { type Credentials, passkey } from '../../../services/auth/passkey.ts'
import { createShapes } from '../../mecha-browser/shapes.ts'
import { publicSnapshot, PublicSnapshotCapacity, type PublicSnapshot } from './public-snapshot.ts'

export interface EdgeClusterConfig {
  db: PGlite
  /** Server tables that carry shapes. */
  tables: string[]
  schema?: ReadSchema & Record<string, { durability?: string }>
  /** The HS256 secret every token is signed with. */
  secret: string
  /** The providers a person may sign in through (oidc.ts's providersFrom),
   * none by default. */
  providers?: Record<string, Provider>
  /** The relying party passkeys belong to and the origin their ceremonies are
   * made on: by default the Worker's door, the hostname and origin of the
   * request the object is handed. */
  webauthn?: { rpId?: string; origin?: string }
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
  const publicCache = new Map<string, boolean>()
  // services/auth/main.ts's tableScope: every base table the relation reaches
  // has scope_id generated as the literal 'public:' with no inheriting child.
  const publicOnly = async (table: string) => {
    const hit = publicCache.get(table)
    if (hit !== undefined) return hit
    const p = (await db.query<{ p: boolean }>(
      `WITH RECURSIVE deps(oid) AS (
        SELECT to_regclass($1)::oid
        UNION
        SELECT d.refobjid
        FROM deps
        JOIN pg_catalog.pg_rewrite r ON r.ev_class = deps.oid
        JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::regclass
          AND d.objid = r.oid
          AND d.refclassid = 'pg_catalog.pg_class'::regclass
          AND d.refobjid <> deps.oid
      )
      SELECT EXISTS (SELECT 1 FROM deps WHERE oid IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM deps
          LEFT JOIN pg_catalog.pg_class c ON c.oid = deps.oid
          WHERE c.oid IS NULL
             OR c.relkind NOT IN ('r', 'v')
             OR (c.relkind = 'r' AND NOT EXISTS (
               SELECT 1 FROM pg_catalog.pg_attribute a
               JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
               WHERE a.attrelid = c.oid AND a.attname = 'scope_id'
                 AND a.attnotnull AND NOT a.attisdropped AND a.attgenerated = 's'
                 AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhparent = c.oid)
                 AND pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) = $2
             ))
        ) AS p`,
      [`public.${table}`, "'public:'::text"],
    )).rows[0].p
    publicCache.set(table, p)
    return p
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

  // The auth service's guest (main.ts): a handle like an account's, since a
  // passkey promotes the guest and keeps it.
  async function guest(): Promise<Response> {
    const id = crypto.randomUUID()
    let handle = ''
    for (let attempt = 0; attempt < 3 && !handle; attempt++) {
      const tried = generateHandle()
      try {
        await serialize(() => db.query('INSERT INTO app_user (id, handle) VALUES ($1, $2)', [id, tried]))
        handle = tried
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e
      }
    }
    if (!handle) return json(500, { error: 'could not allocate identity' })
    const token = await signJwt(secret, { role: 'app_user', sub: id, handle, guest: true, exp: now() + USER_TOKEN_TTL_S })
    return json(200, { token, user: { id, handle, guest: true } })
  }

  // As the auth service makes it (services/auth/main.ts's migrate), once,
  // before the first sign-in reads it.
  let linksReady: Promise<void> | undefined
  const ensureLinks = () => linksReady ??= serialize(async () => {
    await db.exec(`CREATE TABLE IF NOT EXISTS identity_link (
      provider text not null,
      sub text not null,
      user_id uuid not null unique references app_user(id) on delete cascade,
      created_at timestamptz not null default now(),
      name text,
      picture text,
      primary key (provider, sub)
    );
    INSERT INTO mecha.rls_exempt VALUES
      ('public.identity_link', 'the auth service''s own table: read by it alone, on its own connection')
      ON CONFLICT DO NOTHING;`)
  })
  // As the auth service makes it (main.ts's migrate), once, before the first
  // ceremony reads it.
  let credentialsReady: Promise<void> | undefined
  const ensureCredentials = () => credentialsReady ??= serialize(async () => {
    await db.exec(`CREATE TABLE IF NOT EXISTS webauthn_credential (
      id text primary key,
      user_id uuid not null references app_user(id) on delete cascade,
      public_key bytea not null,
      counter bigint not null default 0
    );
    INSERT INTO mecha.rls_exempt VALUES
      ('public.webauthn_credential', 'the auth service''s own table: read by it alone, on its own connection')
      ON CONFLICT DO NOTHING;`)
  })
  // The auth service's credentials (main.ts) on the one connection.
  const credentials: Credentials = {
    create: async (user, c) => {
      await ensureCredentials()
      return serialize(async () => {
        try {
          await db.transaction(async (tx) => {
            await tx.query('INSERT INTO app_user (id, handle) VALUES ($1, $2)', [user.id, user.handle])
            await tx.query('INSERT INTO webauthn_credential (id, user_id, public_key, counter) VALUES ($1, $2, $3, $4)', [c.id, user.id, c.publicKey, c.counter])
          })
          return true
        } catch (e) {
          if ((e as { code?: string }).code === '23505') return false
          throw e
        }
      })
    },
    promote: async (userId, c) => {
      await ensureCredentials()
      const added = await serialize(() => db.query(
        `INSERT INTO webauthn_credential (id, user_id, public_key, counter)
          SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM webauthn_credential WHERE user_id = $2)`,
        [c.id, userId, c.publicKey, c.counter],
      ))
      return (added.affectedRows ?? 0) > 0
    },
    find: async (id) => {
      await ensureCredentials()
      const [c] = (await serialize(() => db.query<{ id: string; public_key: Uint8Array; counter: string | number; user_id: string; handle: string }>(
        `SELECT c.id, c.public_key, c.counter, c.user_id, u.handle
          FROM webauthn_credential c JOIN app_user u ON u.id = c.user_id WHERE c.id = $1`,
        [id],
      ))).rows
      return c ? { id: c.id, publicKey: new Uint8Array(c.public_key), counter: Number(c.counter), userId: c.user_id, handle: c.handle } : null
    },
    count: async (id, counter) => {
      await ensureCredentials()
      await serialize(() => db.query('UPDATE webauthn_credential SET counter = $2 WHERE id = $1', [id, counter]))
    },
  }
  const issue = (user: { id: string; handle: string }) =>
    signJwt(secret, { role: 'app_user', sub: user.id, handle: user.handle, guest: false, exp: now() + USER_TOKEN_TTL_S })
  // The door is the Worker's, whose request the object is handed whole.
  const passkeys = (req: Request) => passkey({
    secret,
    rpId: cfg.webauthn?.rpId ?? new URL(req.url).hostname,
    origin: () => cfg.webauthn?.origin ?? new URL(req.url).origin,
    credentials,
    handle: generateHandle,
    issue,
  })(req)

  // The auth service's links (main.ts) on the one connection: the chain is
  // the lock that keeps two sign-ins of one subject from making two people.
  const links: Links = {
    userFor: async (p: Profile) => {
      await ensureLinks()
      return serialize(() => db.transaction(async (tx) => {
        const [link] = (await tx.query<{ user_id: string }>(
          'UPDATE identity_link SET name = $3, picture = $4 WHERE provider = $1 AND sub = $2 RETURNING user_id',
          [p.provider, p.sub, p.name, p.picture],
        )).rows
        if (link) {
          const [u] = (await tx.query<{ handle: string }>('SELECT handle FROM app_user WHERE id = $1', [link.user_id])).rows
          return { id: link.user_id, handle: u.handle }
        }
        const id = crypto.randomUUID()
        // Generated handles can collide; regenerate and retry — never a user error.
        for (let attempt = 0; attempt < 3; attempt++) {
          const handle = generateHandle()
          await tx.exec('SAVEPOINT handle')
          try {
            await tx.query('INSERT INTO app_user (id, handle) VALUES ($1, $2)', [id, handle])
          } catch (e) {
            if ((e as { code?: string }).code !== '23505') throw e
            await tx.exec('ROLLBACK TO SAVEPOINT handle')
            continue
          }
          await tx.query(
            'INSERT INTO identity_link (provider, sub, user_id, name, picture) VALUES ($1, $2, $3, $4, $5)',
            [p.provider, p.sub, id, p.name, p.picture],
          )
          return { id, handle }
        }
        throw new Error('could not allocate identity')
      }))
    },
    handleOf: async (provider: string, id: string) => {
      await ensureLinks()
      const [u] = (await serialize(() => db.query<{ handle: string }>(
        `SELECT u.handle FROM app_user u
          WHERE u.id = $1 AND EXISTS (SELECT 1 FROM identity_link l WHERE l.user_id = u.id AND l.provider = $2)`,
        [id, provider],
      ))).rows
      return u ? u.handle : null
    },
  }
  const providerSignIn = oidc({
    secret,
    origin: (req) => new URL(req.url).origin,
    providers: cfg.providers ?? {},
    links,
    issue,
  })

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
    const inner = new Request(u, { method: req.method, headers: req.headers, body })
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

  async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    try {
      await ensureShapes()
      const signedIn = providerSignIn(req)
      if (signedIn !== null) return await signedIn
      const ceremony = passkeys(req)
      if (ceremony !== null) return await ceremony
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
