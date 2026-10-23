// The fixture cluster with drains (drains_test.ts): a projection of the
// notes, recomputed whole as the service role, one whose function the test
// breaks, and one over a table a release may yet have to create.
import { edgeObject, type EdgeEnv } from '../src/object.ts'
import { edgeWorker } from '../src/worker.ts'
import pgliteWasm from '../../pglite-workerd/dist/pglite.wasm'
import initdbWasm from '../../pglite-workerd/dist/initdb.wasm'
import pgliteData from '../../pglite-workerd/dist/pglite.data'
import icu from '../../pglite-workerd/dist/icu-root.tgz'

const Base = edgeObject({
  assets: { pgliteWasm, initdbWasm, pgliteData, icu },
  tables: ['note', 'board'],
  drains: [
    { name: 'tally', on: ['note'], call: 'tally_notes', body: { tag: 'notes' } },
    { name: 'flaky', on: ['note'], call: 'flaky', body: {} },
    { name: 'later', on: ['later'], call: 'later_count', body: {} },
  ],
})
export class Cluster extends Base {
  override async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path === '/test/state') {
      const db = await this.booted()
      return Response.json({
        alarm: await this.ctx.storage.getAlarm(),
        tally: (await db.query('SELECT label, n, as_role FROM tally')).rows,
        flaky: (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM flaky_calls')).rows[0].n,
        later: (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM later_calls')).rows[0].n,
      })
    }
    if (path === '/test/alarm') {
      await this.alarm()
      return Response.json({ ok: true })
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
