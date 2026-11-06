import { edgeObject, type EdgeEnv } from '../src/object.ts'
import { edgeWorker } from '../src/worker.ts'
import type { EdgeHatch } from '../src/hatches.ts'
import { effects } from './airlock-effects.ts'
import pgliteWasm from '../../pglite-workerd/dist/pglite.wasm'
import initdbWasm from '../../pglite-workerd/dist/initdb.wasm'
import pgliteData from '../../pglite-workerd/dist/pglite.data'
import icu from '../../pglite-workerd/dist/icu-root.tgz'

// The test's way into the object: POST claims an effect as a machine's
// invoking transition would, GET reads the row and its ledger entry.
const hatch: EdgeHatch = {
  route: '/effect',
  create: ({ database }) => ({
    async fetch(req) {
      if (req.method === 'POST') {
        const { id, effect, mode } = await req.json() as { id: string; effect: string; mode: string }
        await database.transaction(async tx => {
          await tx.query(`INSERT INTO effect_row (id, status) VALUES ($1, 'running')`, [id])
          await tx.query(`INSERT INTO airlock.external_effect_ledger (key, effect, row, input) VALUES ($1, $2, jsonb_build_object('id', $3::text), jsonb_build_object('id', $3::text, 'mode', $4::text))`, [`${effect}:${id}`, effect, id, mode])
          await tx.query(`SELECT graphile_worker.add_job('external_effect', json_build_object('key', $1::text), job_key => $1)`, [`${effect}:${id}`])
        })
        return Response.json({ claimed: true }, { status: 201 })
      }
      const id = new URL(req.url).pathname.split('/').pop()
      if (id === 'seen') return Response.json((await database.query(`SELECT coalesce(max(settled), 0)::int AS settled FROM settled_seen`)).rows[0])
      const { rows: [row] } = await database.query(
        `SELECT r.status, l.entered, l.outcome->>'kind' AS kind, l.outcome->'data' AS data
           FROM effect_row r JOIN airlock.external_effect_ledger l ON l.row->>'id' = r.id WHERE r.id = $1`, [id])
      return Response.json(row ?? null)
    },
  }),
}
// A drain over the effect's rows, which a settle's write wakes.
export const Cluster = edgeObject({
  assets: { pgliteWasm, initdbWasm, pgliteData, icu }, tables: ['note', 'board'], effects, hatches: [hatch],
  drains: [{ name: 'seen', on: ['effect_row'], call: 'see_settled', body: {} }],
})
export default {
  fetch(req: Request, env: EdgeEnv, ctx: ExecutionContext) {
    const path = new URL(req.url).pathname
    if (path === '/effect' || path.startsWith('/effect/')) return env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(req)
    return edgeWorker.fetch(req, env, ctx)
  },
}
