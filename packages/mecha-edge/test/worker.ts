// The fixture cluster exposes eviction, scheduled timers, and public reads
// to cluster_test.ts. A pending timer keeps an object awake.
import { edgeObject, DataDirectoryLoading, type EdgeEnv } from '../src/object.ts'
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
    if (path === '/test/abort') this.ctx.abort('aborted by the test')
    if (path === '/test/timers') return Promise.resolve(Response.json({ bornAt: this.bornAt, timers: [...timers.values()] }))
    if (path === '/test/public') return this.readPublic(async snapshot => Response.json(await snapshot.read('/board?select=title')))
      .catch(error => {
        if (!(error instanceof DataDirectoryLoading)) throw error
        return Response.json({ loading: true }, { status: 503 })
      })
    return super.fetch(req)
  }
}

export default {
  fetch(req: Request, env: EdgeEnv, ctx: ExecutionContext) {
    if (new URL(req.url).pathname.startsWith('/test/')) return env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(req)
    return edgeWorker.fetch(req, env, ctx)
  },
}
