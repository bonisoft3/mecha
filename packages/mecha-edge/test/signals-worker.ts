import { edgeObject, type EdgeEnv } from '../src/object.ts'
import { edgeWorker } from '../src/worker.ts'
import pgliteWasm from '../../pglite-workerd/dist/pglite.wasm'
import initdbWasm from '../../pglite-workerd/dist/initdb.wasm'
import pgliteData from '../../pglite-workerd/dist/pglite.data'
import icu from '../../pglite-workerd/dist/icu-root.tgz'

export const Cluster = edgeObject({ assets: { pgliteWasm, initdbWasm, pgliteData, icu }, tables: ['note', 'board'] })
export default {
  fetch(req: Request, env: EdgeEnv, ctx: ExecutionContext) {
    return edgeWorker.fetch(req, env, ctx)
  },
}
