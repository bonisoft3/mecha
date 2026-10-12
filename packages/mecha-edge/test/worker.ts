// The edge cluster over the fixture's tables, for cluster_test.ts, with two
// routes of the test's own: /test/abort (ctx.abort(), as an eviction) and
// /test/timers (what is scheduled: a pending timer keeps an object awake).
import { edgeObject, type EdgeEnv } from '../src/object.ts'
import { edgeWorker } from '../src/worker.ts'
import pgliteWasm from '../../pglite-workerd/dist/pglite.wasm'
import initdbWasm from '../../pglite-workerd/dist/initdb.wasm'
import pgliteData from '../../pglite-workerd/dist/pglite.data'
import icu from '../../pglite-workerd/dist/icu-root.tgz'

const timers = new Map<unknown, string>()
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
  const id = realSetTimeout(() => { timers.delete(id); fn(...a) }, ms)
  timers.set(id, `${ms}ms ${new Error().stack?.split('\n').slice(2, 6).map((l) => l.trim()).join(' < ')}`)
  return id
}) as typeof setTimeout
globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => { timers.delete(id); realClearTimeout(id) }) as typeof clearTimeout

const Base = edgeObject({ assets: { pgliteWasm, initdbWasm, pgliteData, icu }, tables: ['note', 'board'] })

export class Cluster extends Base {
  readonly bornAt = new Date().toISOString()
  override fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path === '/test/abort') this.ctx.abort(new Error('aborted by the test'))
    if (path === '/test/timers') return Promise.resolve(Response.json({ bornAt: this.bornAt, timers: [...timers.values()] }))
    return super.fetch(req)
  }
}

export default {
  fetch(req: Request, env: EdgeEnv, ctx: ExecutionContext) {
    if (new URL(req.url).pathname.startsWith('/test/')) return env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(req)
    return edgeWorker.fetch(req, env, ctx)
  },
}
