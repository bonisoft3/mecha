// The Worker in front of the cluster's one object: /auth, /crud, /electric and
// /import go to the object, the rest to the static assets (the document for a
// navigation to any other path), and reads the object answered once are
// answered again from the colo's Cache API.
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
// - A guest's GET /crud is kept seconds, keyed by its URL, its subject, and
//   the time of that subject's last write, so a guest reads its own writes.
// - Nothing live, no write, no 4xx or 5xx, and no session but a guest's.
// - The browser keeps a shape response that is not live as Electric's server
//   would let it, and nothing else.
import { verifyJwt } from '../../../services/auth/jwt.ts'
import type { EdgeEnv } from './object.ts'

const SHAPE_TTL_S = 300
const CRUD_TTL_S = 5
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
  return out
}

// A log read from its start is kept long by a browser and briefly by a shared
// cache; any other read that is not live, a minute and five more stale.
const electricCache = (p: URLSearchParams) => p.get('offset') === '-1'
  ? 'public, max-age=604800, s-maxage=3600, stale-while-revalidate=2629746'
  : 'public, max-age=60, stale-while-revalidate=300'

const navigation = (req: Request) =>
  req.method === 'GET' && (req.headers.get('sec-fetch-mode') === 'navigate' || (req.headers.get('accept') ?? '').includes('text/html'))

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
      const res = await object().fetch(req)
      if (path === '/import/reset' && res.ok) {
        await cache.put(keyOf(env.CF_VERSION_METADATA.id, 'reset'), new Response(String(Date.now()), { headers: { 'cache-control': 'max-age=86400' } }))
        await cache.delete(keyOf(env.CF_VERSION_METADATA.id, 'epoch'))
      }
      return res
    }
    if (!CLUSTER_ROUTES.test(path)) {
      if (!env.ASSETS) return json({ error: `no route for ${path}` }, 404)
      const res = await env.ASSETS.fetch(req)
      if (res.status !== 404 || !navigation(req)) return res
      // A route is the page's: the document answers a navigation to any path,
      // and nothing else, so a missing asset is a 404 and not the whole page.
      return env.ASSETS.fetch(new Request(new URL('/', req.url), req))
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

    const guest = claims?.role === 'app_user' && claims.guest === true && typeof claims.sub === 'string'
    if (path.startsWith('/crud/') && guest) {
      const reset = (await (await cache.match(keyOf(version, 'reset')))?.text()) ?? '0'
      const writesKey = keyOf(version, reset, 'writes', claims.sub as string)
      if (req.method === 'GET') {
        const lastWrite = (await (await cache.match(writesKey))?.text()) ?? '0'
        return cached(keyOf(version, reset, 'crud', claims.sub as string, lastWrite, url.pathname + url.search), () => object().fetch(req), CRUD_TTL_S, ctx)
      }
      const res = await object().fetch(req)
      // Before answering, so the guest's next read cannot find the old key.
      await cache.put(writesKey, new Response(String(Date.now()), { headers: { 'cache-control': `max-age=${CRUD_TTL_S}` } }))
      return res
    }
    return object().fetch(req)
  },
}
