import { DurableObject } from 'cloudflare:workers'
import type { PGlite } from '@electric-sql/pglite'
import { DataDirectory } from '../src/data-directory.ts'
import pgliteWasm from '../dist/pglite.wasm'
import initdbWasm from '../dist/initdb.wasm'
import pgliteData from '../dist/pglite.data'
import icu from '../dist/icu-root.tgz'

interface Env {
  ARCHIVE: DurableObjectNamespace<CompressedArchive>
  PROBE_TOKEN: string
  STORAGE_CODEC?: 'raw' | 'deflate'
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

export class CompressedArchive extends DurableObject<Env> {
  readonly #dir = new DataDirectory(this.ctx.storage, this.env.STORAGE_CODEC === 'raw'
    ? { version: 1, blockSize: 8192, codec: 'raw' }
    : { version: 1, blockSize: 131072, codec: 'deflate' })
  #db: Promise<PGlite> | null = null

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path.startsWith('/import/')) {
      if (req.headers.get('content-encoding') === 'gzip') {
        if (!req.body) throw new Error('missing compressed import body')
        const headers = new Headers(req.headers)
        headers.delete('content-encoding')
        headers.delete('content-length')
        req = new Request(req, { headers, body: req.body.pipeThrough(new DecompressionStream('gzip')) })
      }
      return this.#dir.importing(path.slice('/import/'.length), req)
    }
    if (path === '/stats') return json({
      bytes: this.ctx.storage.sql.databaseSize,
      blocks: this.ctx.storage.sql.exec('SELECT count(*) AS count, sum(length(data)) AS payload FROM fs_block').one(),
      format: this.ctx.storage.sql.exec('SELECT value FROM fs_format WHERE id = 1').one(),
    })
    if (path === '/abort' && req.method === 'POST') this.ctx.abort(new Error('compression recovery probe'))
    if (path !== '/sql' || req.method !== 'POST') return json({ error: 'unknown probe route' }, 404)
    this.#db ??= this.#dir.open({ pgliteWasm, initdbWasm, pgliteData, icu })
    const db = await this.#db
    const { sql, params = [], workMem } = await req.json() as { sql: string; params?: unknown[]; workMem?: string }
    if (workMem !== undefined && workMem !== '1MB' && workMem !== '8MB') throw new Error('unsupported probe work_mem')
    const result = await db.transaction(async tx => {
      await tx.exec('SET TRANSACTION READ ONLY')
      if (workMem) await tx.exec(`SET LOCAL work_mem = '${workMem}'`)
      return tx.query(sql, params)
    })
    return json({ rows: result.rows })
  }
}

export default {
  fetch(req: Request, env: Env): Promise<Response> | Response {
    if (!env.PROBE_TOKEN) throw new Error('PROBE_TOKEN is required')
    if (req.headers.get('authorization') !== `Bearer ${env.PROBE_TOKEN}`) return json({ error: 'unauthorized' }, 401)
    return env.ARCHIVE.get(env.ARCHIVE.idFromName('archive')).fetch(req)
  },
}
