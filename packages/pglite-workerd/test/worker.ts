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
import { DataDirectory, type PhysicalSnapshot, type SnapshotNodes, type SnapshotBlocks } from '../src/data-directory.ts'
import type { StorageFormat } from '../src/storage-block.ts'
import { filesystemCases } from './filesystem-cases.ts'
import { recompressionCases, recompressionCrash } from './recompression-cases.ts'
import { physicalSnapshotCases } from './physical-snapshot-cases.ts'
import { compressionCases, compressionCrash, compressionTarget } from './compression-cases.ts'
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

  physicalManifest(id: string) { return this.#dir.snapshotManifest(id) }
  physicalNodes(id: string, after: string) { return this.#dir.snapshotNodes(id, after) }
  physicalBlocks(id: string, path: string, after: number) { return this.#dir.snapshotBlocks(id, path, after) }
  physicalStatus() { return this.#dir.snapshotImportStatus() }
  physicalBegin(manifest: PhysicalSnapshot) { return this.#dir.beginSnapshotImport(manifest) }
  physicalImportNodes(page: SnapshotNodes) { return this.#dir.importSnapshotNodes(page) }
  physicalImportBlocks(page: SnapshotBlocks) { return this.#dir.importSnapshotBlocks(page) }
  physicalFinish(id: string) { return this.#dir.finishSnapshotImport(id) }
  physicalGeneration() { return this.#dir.generation }

  override async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path === '/compression-cases') { compressionCases(this.ctx.storage); return json({ ok: true }) }
    if (path === '/compression-stage' || path === '/compression-recover') { compressionCrash(this.ctx.storage, path === '/compression-recover'); return json({ ok: true }) }
    if (path === '/compression-status') return json(this.#dir.storageStatus())
    if (path === '/compression-begin') return json(this.#dir.beginCompression(this.#dir.generation, compressionTarget))
    if (path === '/compression-advance') return json(this.#dir.advanceCompression(this.#dir.generation))
    if (path === '/physical-snapshot-cases') { await physicalSnapshotCases(this.ctx.storage); return json({ ok: true }) }
    if (path === '/recompression-cases') { await recompressionCases(this.ctx.storage); return json({ ok: true }) }
    if (path === '/recompression-stage' || path === '/recompression-recover') { await recompressionCrash(this.ctx.storage, path === '/recompression-recover'); return json({ ok: true }) }
    if (path === '/filesystem-cases') { filesystemCases(this.ctx.storage.sql); return json({ ok: true }) }
    if (path.startsWith('/import/')) return this.#dir.importing(path.slice('/import/'.length), req)
    if (path === '/state') return json({ bornAt: this.#bornAt, open: this.#db !== null, timers: [...timers.values()] })
    if (path === '/abort') this.ctx.abort('aborted by /abort')
    this.#db ??= this.#dir.open({ pgliteWasm, initdbWasm, pgliteData, icu })
    const db = await this.#db
    if (path === '/freeze-physical') return json(await this.#dir.freeze(await req.text()))
    if (path === '/release-physical') { this.#dir.releaseSnapshot(await req.text()); return json({ ok: true }) }
    if (path === '/freeze-transaction') {
      let refused = false
      await db.transaction(async () => {
        try { await this.#dir.freeze('open-transaction') } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('open PostgreSQL transaction')) throw error
          refused = true
        }
      })
      return json({ refused, manifest: this.#dir.snapshotManifest('open-transaction') })
    }
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
    if (url.pathname === '/transfer-physical') return (async () => {
      const source = namespace.get(namespace.idFromName(name))
      const target = namespace.get(namespace.idFromName(url.searchParams.get('target')!))
      const manifest = await source.physicalManifest(await req.text())
      if (!manifest) throw new Error('missing snapshot')
      let status = await target.physicalStatus() ?? await target.physicalBegin(manifest)
      while (!status.nodesDone) status = await target.physicalImportNodes(await source.physicalNodes(manifest.id, status.nodesAfter))
      while (status.nextFile) status = await target.physicalImportBlocks(await source.physicalBlocks(manifest.id, status.nextFile.path, status.nextFile.after))
      if (!status.complete) status = await target.physicalFinish(manifest.id)
      return json({ complete: status.complete, sourceGeneration: status.manifest.sourceGeneration, targetGeneration: await target.physicalGeneration() })
    })()
    return namespace.get(namespace.idFromName(name)).fetch(req)
  },
}
