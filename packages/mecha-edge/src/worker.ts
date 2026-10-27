// The Worker in front of the cluster's one object: /auth, /crud, /electric,
// /import and /poke go to the object, the rest to the static assets (the
// document for a navigation to any other path), and reads the object answered
// once are answered again from the colo's Cache API. The Cron Trigger is the
// ticker's clock outside the object (object.ts, clock.ts): `scheduled` pokes
// it, and /poke under the import's token is the same poke from a publish.
//
// - A shape response that is not live is a prefix of the log under its
//   handle: replayed later it is still true, and the client reads on from the
//   offset it ends at. Its key is the request (table, the token's where,
//   handle, offset, subset), the Worker's version and the object's epoch, the
//   part of every handle a new object changes. The epoch is learned from the
//   handles responses carry, a 409 must-refetch's included, so once an object
//   restarted no chunk of the old one is served in this colo again. A shape
//   is cached only behind a token the Worker verified for that table and
//   where; a public-only table's where names `public:` alone, so its chunks
//   are every guest's.
// - A guest's GET /crud is keyed by its URL and last write: a public-only
//   read (marked `x-mecha-scope: public` by the cluster) is shared across
//   guests, while a subject-scoped read is keyed by the guest's `sub`; writes
//   advance both keys. A subject-scoped read is kept seconds. A public one is
//   fresh as long, and after that served stale while one refresh per colo
//   replaces it, for a day: a read the object takes long to answer is paid by
//   the refresh, not a guest. A write through this colo moves the key; one
//   made elsewhere (another colo, the object itself) is seen as before, once
//   the entry is past its seconds, after one stale answer.
// - Nothing live, no write, no 4xx or 5xx, and no session but a guest's.
// - The browser keeps a shape response that is not live as Electric's server
//   would let it, and nothing else.
import { verifyJwt } from '../../../services/auth/jwt.ts'
import type { EdgeEnv } from './object.ts'
import { pokeCluster } from './clock.ts'

const SHAPE_TTL_S = 300
const CRUD_TTL_S = 5
const PUBLIC_CRUD_FRESH_MS = CRUD_TTL_S * 1000
const PUBLIC_CRUD_KEEP_S = 86_400
const STORED_AT = 'x-edge-stored-at'
// One refresh per stale key per isolate, as edge-ssr.ts's renders.
const refreshing = new Map<string, Promise<void>>()
const CLUSTER_ROUTES = /^\/(auth|crud|electric)(\/|$)/
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
// Cache API keys are URLs; none of these is ever fetched.
const keyOf = (...parts: string[]) => new Request(`https://edge-cache.invalid/${parts.map(encodeURIComponent).join('/')}`)

async function cached(key: Request, miss: () => Promise<Response>, ttl: number, ctx: ExecutionContext, browser?: string): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default
  const hit = await cache.match(key)
  if (hit) return marked(hit, 'hit', browser)
  const res = await miss()
  if (res.status !== 200) return marked(res, 'miss')
  const stored = new Response(res.body, res)
  stored.headers.set('cache-control', `max-age=${ttl}`)
  ctx.waitUntil(cache.put(key, stored.clone()))
  return marked(stored, 'miss', browser)
}

/** What the browser may keep: a shape response that is not live, a 200,
 * under Electric 1.8's own cache headers (its shapes/api/response.ex), which
 * its client is written against: it sends `expired_handle` and a cache buster
 * past a stale entry. Anything else, nothing. */
function marked(res: Response, state: string, browser = 'no-store'): Response {
  const out = new Response(res.body, res)
  out.headers.set('cache-control', res.status === 200 ? browser : 'no-store')
  out.headers.set('x-edge-cache', state)
  out.headers.delete(STORED_AT)
  return out
}

// A log read from its start is kept long by a browser and briefly by a shared
// cache; any other read that is not live, a minute and five more stale.
const electricCache = (p: URLSearchParams) => p.get('offset') === 'now' || p.get('log') === 'changes_only'
  ? 'no-store'
  : p.get('offset') === '-1'
  ? 'public, max-age=604800, s-maxage=3600, stale-while-revalidate=2629746'
  : 'public, max-age=60, stale-while-revalidate=300'

/** A public read as the colo keeps it: a day, stamped with when it was read. */
function storedPublic(res: Response): Response {
  const stored = new Response(res.body, res)
  stored.headers.delete('x-mecha-scope')
  stored.headers.set('cache-control', `max-age=${PUBLIC_CRUD_KEEP_S}`)
  stored.headers.set(STORED_AT, String(Date.now()))
  return stored
}

const navigation = (req: Request) =>
  (req.method === 'GET' || req.method === 'HEAD') && (req.headers.get('sec-fetch-mode') === 'navigate' || (req.headers.get('accept') ?? '').includes('text/html'))

const epochOf = (handle: string | null) => handle?.slice(handle.lastIndexOf('-') + 1) ?? null

export const edgeWorker = {
  async fetch(req: Request, env: EdgeEnv, ctx: ExecutionContext): Promise<Response> {
    if (!env.JWT_SECRET) throw new Error('JWT_SECRET is not set')
    if (!env.IMPORT_TOKEN) throw new Error('IMPORT_TOKEN is not set')
    const url = new URL(req.url)
    const path = url.pathname
    const object = () => env.CLUSTER.get(env.CLUSTER.idFromName('cluster'))
    const cache = (caches as unknown as { default: Cache }).default
    if (path.startsWith('/import/')) {
      if (req.headers.get('authorization') !== `Bearer ${env.IMPORT_TOKEN}`) return json({ error: 'unauthorized' }, 401)
      const reqHeaders = new Headers(req.headers)
      if (env.CF_VERSION_METADATA?.id) reqHeaders.set('x-expected-version', env.CF_VERSION_METADATA.id)
      const res = await object().fetch(new Request(req, { headers: reqHeaders }))
      // A reset, or a migration that changed the schema, moves every key a
      // read of the old data was kept under.
      const moved = res.ok && (path === '/import/reset' || (path === '/import/migrate' && ((await res.clone().json()) as { applied: string[] }).applied.length > 0))
      if (moved) {
        await cache.put(keyOf(env.CF_VERSION_METADATA.id, 'reset'), new Response(String(Date.now()), { headers: { 'cache-control': 'max-age=86400' } }))
        await cache.delete(keyOf(env.CF_VERSION_METADATA.id, 'epoch'))
      }
      return res
    }
    if (path === '/poke') {
      if (req.method !== 'POST') return json({ error: 'poke is a POST' }, 405)
      if (req.headers.get('authorization') !== `Bearer ${env.IMPORT_TOKEN}`) return json({ error: 'unauthorized' }, 401)
      return object().fetch(req)
    }
    if (!CLUSTER_ROUTES.test(path)) {
      if (!env.ASSETS) return json({ error: `no route for ${path}` }, 404)
      const res = await env.ASSETS.fetch(req)
      if (res.status === 200) {
        if (path.startsWith('/_immutable-') || path.includes('/_immutable-')) {
          const out = new Response(req.method === 'HEAD' ? null : res.body, res)
          out.headers.set('cache-control', 'public, max-age=31536000, immutable')
          return out
        }
        return res
      }
      if (res.status !== 404) return res
      if (!navigation(req) || /^\/(?:_immutable-|(?:shell|omnishell|messages)\/)/.test(path)) {
        const out = new Response(req.method === 'HEAD' ? null : res.body, res)
        out.headers.set('cache-control', 'no-store')
        return out
      }
      // A route is the page's: the document answers a navigation to any path,
      // and nothing else, so a missing asset is a 404 and not the whole page.
      const root = await env.ASSETS.fetch(new Request(new URL('/', req.url), req))
      return req.method === 'HEAD' ? new Response(null, root) : root
    }
    const version = env.CF_VERSION_METADATA.id
    const auth = req.headers.get('authorization')
    const claims = auth?.startsWith('Bearer ') ? await verifyJwt(env.JWT_SECRET, auth.slice('Bearer '.length)) : null
    const p = url.searchParams

    if (req.method === 'GET' && path === '/electric/v1/shape') {
      const epochKey = keyOf(version, 'epoch')
      const epoch = await (await cache.match(epochKey))?.text()
      // Awaited when it moves, so the refetch a 409 sends finds the new key.
      const learn = async (res: Response) => {
        const seen = epochOf(res.headers.get('electric-handle'))
        if (seen && seen !== epoch) await cache.put(epochKey, new Response(seen, { headers: { 'cache-control': `max-age=${SHAPE_TTL_S}` } }))
        return res
      }
      const live = p.get('live') === 'true'
      const verified = claims?.typ === 'shape' && p.get('table') === claims.table && p.get('where') === claims.where
      const browser = live ? 'no-store' : electricCache(p)
      if (live || !verified || !epoch) return marked(await learn(await object().fetch(req)), 'bypass', browser)
      // Every parameter but a live poll's cursor: a cache buster or an
      // expired_handle is how the client asks past a stale entry.
      const params = [...p].filter(([k]) => k !== 'cursor').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return cached(keyOf(version, epoch, ...params.flat()), async () => learn(await object().fetch(req)), SHAPE_TTL_S, ctx, browser)
    }

    const session = claims?.role === 'app_user' && typeof claims.sub === 'string'
    const guest = session && claims.guest === true
    if (path.startsWith('/crud/') && session) {
      const reset = (await (await cache.match(keyOf(version, 'reset')))?.text()) ?? '0'
      const writesKey = keyOf(version, reset, 'writes', claims.sub as string)
      const publicWritesKey = keyOf(version, reset, 'writes', 'public')
      if (req.method === 'GET' && guest) {
        const lastPublicWrite = (await (await cache.match(publicWritesKey))?.text()) ?? '0'
        const publicKey = keyOf(version, reset, 'crud', 'public', lastPublicWrite, url.pathname + url.search)
        const publicHit = await cache.match(publicKey)
        if (publicHit) {
          if (Date.now() - Number(publicHit.headers.get(STORED_AT)) <= PUBLIC_CRUD_FRESH_MS) return marked(publicHit, 'hit')
          if (!refreshing.has(publicKey.url)) {
            const refresh = (async () => {
              const res = await object().fetch(new Request(req.url, { headers: req.headers }))
              if (res.status !== 200 || res.headers.get('x-mecha-scope') !== 'public') {
                await cache.delete(publicKey)
                throw new Error(`refreshing ${url.pathname}${url.search} answered ${res.status} ${res.headers.get('x-mecha-scope') ?? 'unscoped'}: its stale entry is dropped`)
              }
              await cache.put(publicKey, storedPublic(res))
            })().finally(() => refreshing.delete(publicKey.url))
            refreshing.set(publicKey.url, refresh)
            ctx.waitUntil(refresh)
          }
          return marked(publicHit, 'stale')
        }
        const lastWrite = (await (await cache.match(writesKey))?.text()) ?? '0'
        const subjectKey = keyOf(version, reset, 'crud', claims.sub as string, lastWrite, url.pathname + url.search)
        const subjectHit = await cache.match(subjectKey)
        if (subjectHit) return marked(subjectHit, 'hit')
        const res = await object().fetch(req)
        if (res.status !== 200) return marked(res, 'miss')
        const isPublic = res.headers.get('x-mecha-scope') === 'public'
        const stored = isPublic ? storedPublic(res) : new Response(res.body, res)
        if (!isPublic) stored.headers.set('cache-control', `max-age=${CRUD_TTL_S}`)
        ctx.waitUntil(cache.put(isPublic ? publicKey : subjectKey, stored.clone()))
        return marked(stored, 'miss')
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const res = await object().fetch(req)
        const now = String(Date.now())
        // Before answering, so the next read cannot find the old key.
        await cache.put(writesKey, new Response(now, { headers: { 'cache-control': `max-age=${CRUD_TTL_S}` } }))
        await cache.put(publicWritesKey, new Response(now, { headers: { 'cache-control': 'max-age=86400' } }))
        return res
      }
    }
    return object().fetch(req)
  },

  scheduled(_controller: ScheduledController, env: EdgeEnv): Promise<void> {
    return pokeCluster(env)
  },
}
