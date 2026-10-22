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
    if (path === '/test/clock-start') return (async () => {
      const db = await this.booted()
      const future = new Date(Date.now() + 2_000).toISOString()
      await db.query(`INSERT INTO schedule (name, due_at, emits_entity) VALUES
        ('broken', now() - interval '1 second', 'missing'), ('healthy', $1, 'tick')`, [future])
      await this.rearm()
      return Response.json({ future })
    })()
    if (path === '/test/cron-start') return (async () => {
      const db = await this.booted()
      await db.query(`INSERT INTO schedule (name, cron, emits_entity) VALUES ('minutely', '* * * * *', 'tick')`)
      return Response.json({ ok: true })
    })()
    if (path === '/test/tables') return (async () => {
      const db = await this.booted()
      return Response.json((await db.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename))
    })()
    if (path === '/test/clock-state') return (async () => {
      const db = await this.booted()
      return Response.json({ alarm: await this.ctx.storage.getAlarm(), ticks: (await db.query('SELECT schedule, caller FROM tick')).rows })
    })()
    if (path === '/test/alarm') return this.alarm().then(() => Response.json({ ok: true }))
    if (path === '/test/alarm-state') return this.ctx.storage.getAlarm().then(alarm => Response.json({ alarm }))
    if (path === '/test/set-alarm') return this.ctx.storage.setAlarm(Date.now() + 60_000).then(() => Response.json({ ok: true }))
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
  scheduled: edgeWorker.scheduled,
}
