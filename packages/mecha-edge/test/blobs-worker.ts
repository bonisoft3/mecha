import { edgeObject, type EdgeEnv } from '../src/object.ts'
import { edgeWorker } from '../src/worker.ts'
import pgliteWasm from '../../pglite-workerd/dist/pglite.wasm'
import initdbWasm from '../../pglite-workerd/dist/initdb.wasm'
import pgliteData from '../../pglite-workerd/dist/pglite.data'
import icu from '../../pglite-workerd/dist/icu-root.tgz'

export const Cluster = edgeObject({ assets: { pgliteWasm, initdbWasm, pgliteData, icu }, tables: ['note', 'board'] })
export default {
  async fetch(req: Request, env: EdgeEnv & { BLOB_OBJECTS: { get(key: string): Promise<{ body: ReadableStream } | null> } }, ctx: ExecutionContext) {
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname.startsWith('/read/')) {
      const object = await env.BLOB_OBJECTS.get(url.pathname.slice('/read/'.length))
      return object ? new Response(object.body) : new Response(null, { status: 404 })
    }
    return edgeWorker.fetch(req, env, ctx)
  },
}
