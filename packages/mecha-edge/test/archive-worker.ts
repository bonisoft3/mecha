import { edgeObject, type EdgeEnv } from '../src/object.ts'
import { edgeWorker } from '../src/worker.ts'
import pgliteWasm from '../../pglite-workerd/dist/pglite.wasm'
import initdbWasm from '../../pglite-workerd/dist/initdb.wasm'
import pgliteData from '../../pglite-workerd/dist/pglite.data'
import icu from '../../pglite-workerd/dist/icu-root.tgz'

const Base = edgeObject({ assets: { pgliteWasm, initdbWasm, pgliteData, icu }, tables: [], clock: 'disabled' })
export class Cluster extends Base {
  override async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path === '/test/set-alarm') {
      await this.ctx.storage.setAlarm(Date.now() + 60_000)
      return Response.json({ ok: true })
    }
    if (path === '/test/alarm') {
      await this.alarm()
      return Response.json({ alarm: await this.ctx.storage.getAlarm() })
    }
    if (path === '/test/rearm') {
      await this.rearm()
      return Response.json({ alarm: await this.ctx.storage.getAlarm() })
    }
    if (path === '/test/state') {
      const db = await this.booted()
      return Response.json({ alarm: await this.ctx.storage.getAlarm(), schedules: (await db.query('SELECT * FROM schedule')).rows })
    }
    return super.fetch(req)
  }
}
export default {
  fetch(req: Request, env: EdgeEnv, ctx: ExecutionContext) {
    if (new URL(req.url).pathname.startsWith('/test/')) return env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(req)
    return edgeWorker.fetch(req, env, ctx)
  },
}
