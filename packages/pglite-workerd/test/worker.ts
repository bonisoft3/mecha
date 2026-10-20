// The package in a Durable Object, for validate_test.ts: DataDirectory's import
// routes, and SQL over the PGlite it opens on the first query.
//   POST /import/<route>   DataDirectory.importing
//   POST /sql              {sql} → rows
//   POST /exec             a script
//   GET  /state            when the object was constructed, whether PGlite is
//                          open, and the timers pending
//   POST /abort            reset the object, as an eviction does
//   GET  /probe            (the Worker) what runtime wasm compilation workerd allows
// ?do=<name> picks the object.
import { DurableObject } from 'cloudflare:workers'
import type { PGlite } from '@electric-sql/pglite'
import { DataDirectory } from '../src/data-directory.ts'
import type { StorageFormat } from '../src/storage-block.ts'
import { filesystemCases } from './filesystem-cases.ts'
import pgliteWasm from '../dist/pglite.wasm'
import initdbWasm from '../dist/initdb.wasm'
import pgliteData from '../dist/pglite.data'
import icu from '../dist/icu-root.tgz'

// The host step pgl_step calls (modules/pgl_step): here, an echo that says it
// ran, and a failure for the machine named `failing`, for host-step_test.ts.
;(globalThis as { __pgliteStep?: (name: string, json: string) => string }).__pgliteStep = (name, json) =>
  name === 'failing' ? `!the host refused ${JSON.parse(json).why}` : JSON.stringify({ machine: name, input: JSON.parse(json), ran: 'host' })

// A pending timer keeps an object awake; these record where each was set.
const timers = new Map<unknown, string>()
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
  const id = realSetTimeout(() => { timers.delete(id); fn(...a) }, ms)
  timers.set(id, `${ms}ms ${new Error().stack?.split('\n').slice(2, 6).map((l) => l.trim()).join(' < ')}`)
  return id
}) as typeof setTimeout
globalThis.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => { timers.delete(id); realClearTimeout(id) }) as typeof clearTimeout

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export class Fixture extends DurableObject {
  readonly #bornAt = new Date().toISOString()
  protected get storageFormat(): StorageFormat | undefined { return undefined }
  readonly #dir = new DataDirectory(this.ctx.storage, this.storageFormat)
  #db: Promise<PGlite> | null = null

  override async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path === '/filesystem-cases') { filesystemCases(this.ctx.storage.sql); return json({ ok: true }) }
    if (path.startsWith('/import/')) return this.#dir.importing(path.slice('/import/'.length), req)
    if (path === '/state') return json({ bornAt: this.#bornAt, open: this.#db !== null, timers: [...timers.values()] })
    if (path === '/abort') this.ctx.abort('aborted by /abort')
    this.#db ??= this.#dir.open({ pgliteWasm, initdbWasm, pgliteData, icu })
    const db = await this.#db
    if (path === '/sql') {
      const { sql } = (await req.json()) as { sql: string }
      try {
        return json((await db.query(sql)).rows)
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500)
      }
    }
    if (path === '/exec') {
      await db.exec(await req.text())
      return json({ ok: true })
    }
    return json({ error: `no route ${path}` }, 404)
  }
}

export class CompressedFixture extends Fixture {
  protected override get storageFormat(): StorageFormat { return { version: 1, blockSize: 131072, codec: 'deflate' } }
}

export default {
  fetch(req: Request, env: { FIXTURE: DurableObjectNamespace<Fixture>; COMPRESSED: DurableObjectNamespace<CompressedFixture> }): Promise<Response> | Response {
    const url = new URL(req.url)
    if (url.pathname === '/probe') {
      let compile: string
      try {
        new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
        compile = 'ok'
      } catch (e) {
        compile = String(e)
      }
      return json({ webAssemblyFunction: typeof (WebAssembly as unknown as { Function?: unknown }).Function, runtimeCompile: compile })
    }
    const name = url.searchParams.get('do')
    if (!name) return json({ error: 'no ?do=' }, 400)
    const namespace = url.searchParams.get('codec') === 'deflate' ? env.COMPRESSED : env.FIXTURE
    return namespace.get(namespace.idFromName(name)).fetch(req)
  },
}
