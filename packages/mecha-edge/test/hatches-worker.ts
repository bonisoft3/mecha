import { edgeObject, type EdgeEnv } from '../src/object.ts'
import { edgeWorker } from '../src/worker.ts'
import type { EdgeHatch } from '../src/hatches.ts'
import pgliteWasm from '../../pglite-workerd/dist/pglite.wasm'
import initdbWasm from '../../pglite-workerd/dist/initdb.wasm'
import pgliteData from '../../pglite-workerd/dist/pglite.data'
import icu from '../../pglite-workerd/dist/icu-root.tgz'

const hatch: EdgeHatch = {
  route: '/hatch',
  create: ({ database, env }) => {
    let served = 0
    let swept = 0
    let sweepFails = false
    return {
    async sweep() {
      swept++
      if (sweepFails) throw new AggregateError([new Error('order one')], 'left unsettled')
    },
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/hatch/served') return Response.json({ served: ++served })
      if (path === '/hatch/swept') return Response.json({ swept })
      if (path === '/hatch/sweep-fails') { sweepFails = !sweepFails; return Response.json({ sweepFails }) }
      if (path === '/hatch/wal') return Response.json((await database.query("SELECT pg_wal_lsn_diff(redo_lsn, '0/0')::text AS redo, pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::text AS current FROM pg_control_checkpoint()")).rows[0])
      if (req.method === 'GET') {
        const result = await database.query('SELECT id, body FROM hatch_private ORDER BY id')
        return Response.json({ rows: result.rows, configured: env.HATCH_SETTING }, { headers: { 'x-test-hatch': 'yes' } })
      }
      const { id, body } = await req.json() as { id: number; body: string }
      const rollback = new Error('deliberate rollback')
      try {
        await database.transaction(async tx => {
          await tx.query('INSERT INTO hatch_private (id, body) VALUES ($1, $2)', [id, body])
          await tx.query('INSERT INTO hatch_private (id, body) VALUES ($1, $2)', [id + 1, 'paired'])
          if (path === '/hatch/rollback') throw rollback
        })
      } catch (error) {
        if (error !== rollback) throw error
        return Response.json({ rolledBack: true }, { status: 409 })
      }
      return Response.json({ created: true }, { status: 201 })
    },
    }
  },
}
export const Cluster = edgeObject({ assets: { pgliteWasm, initdbWasm, pgliteData, icu }, tables: ['note', 'board'], hatches: [hatch] })
export default {
  fetch(req: Request, env: EdgeEnv, ctx: ExecutionContext) {
    const path = new URL(req.url).pathname
    // Exercise the object boundary independently of the generated Worker's dispatch.
    if (path === '/test/object-boundary') {
      const target = new URL(req.url)
      target.pathname = '/hatch-other'
      return env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(new Request(target, req))
    }
    if (path === '/hatch' || path.startsWith('/hatch/')) return env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(req)
    return edgeWorker.fetch(req, env, ctx)
  },
}
