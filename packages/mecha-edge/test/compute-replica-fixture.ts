import { DurableObject } from 'cloudflare:workers'
import { DataDirectory } from '../../pglite-workerd/src/data-directory.ts'
import { computeReader, physicalSnapshotId, readerName } from '../src/compute-reader.ts'
import type { ComputeCapture } from '../src/compute.ts'
import pgliteWasm from '../../pglite-workerd/dist/pglite.wasm'
import initdbWasm from '../../pglite-workerd/dist/initdb.wasm'
import pgliteData from '../../pglite-workerd/dist/pglite.data'
import icu from '../../pglite-workerd/dist/icu-root.tgz'

const assets = { pgliteWasm, initdbWasm, pgliteData, icu }
export const computations = [{ name: 'probe', version: 'v1', reads: ['left_input', 'right_input'], to: ['result'] }]
const machine = { execute() { throw new Error('reader must use the captured batch state') } }
export class Reader extends computeReader(assets, computations, machine) {}

export class Source extends DurableObject {
  dir = new DataDirectory(this.ctx.storage, undefined, error => { this.ctx.abort(String(error)); throw error })
  db: ReturnType<DataDirectory['open']> | undefined
  open() { return this.db ??= this.dir.open(assets) }
  async capture(revision: number): Promise<ComputeCapture> {
    const db = await this.open()
    const identity = { id: `capture-${revision}`, name: 'probe', version: 'v1', revision }
    await db.transaction(async tx => {
      await tx.query('UPDATE left_input SET value=$1', [revision])
      await tx.query('UPDATE right_input SET value=$1', [revision])
      await tx.query(`UPDATE compute_snapshot_private.batches SET state=jsonb_set(jsonb_set(state,'{claimed}',$1::jsonb),'{requested}',$1::jsonb)`, [String(revision)])
      await tx.query('INSERT INTO compute_snapshot_private.captures(id,name,version,revision) VALUES($1,$2,$3,$4)', [identity.id, identity.name, identity.version, revision])
    })
    const capture = { generation: this.dir.generation, identity }
    await this.dir.freeze(physicalSnapshotId(capture))
    return capture
  }
  async step(capture: ComputeCapture) {
    const reader = this.env.READER.get(this.env.READER.idFromName(readerName(capture)))
    const state = await reader.status(capture)
    if (state.restoring) return { done: false, bytes: 0 }
    const status = state.transfer
    let page
    if (!status) page = { kind: 'manifest', value: this.dir.snapshotManifest(physicalSnapshotId(capture)) }
    else if (!status.nodesDone) page = { kind: 'nodes', value: this.dir.snapshotNodes(physicalSnapshotId(capture), status.nodesAfter, status.baseId ?? undefined) }
    else if (status.preparing) return { done: await reader.advance(capture), bytes: 0 }
    else if (status.nextFile) page = { kind: 'blocks', value: this.dir.snapshotBlocks(physicalSnapshotId(capture), status.nextFile.path, status.nextFile.after, status.baseId ?? undefined) }
    return { done: await reader.advance(capture, page), blockPage: page?.kind === 'blocks', bytes: page?.kind === 'blocks' ? page.value.blocks.reduce((n, b) => n + (b.data?.byteLength ?? 0), 0) : 0 }
  }
  async fetch(req: Request) {
    const path = new URL(req.url).pathname
    if (path.startsWith('/import/')) return this.dir.importing(path.slice(8), req)
    const body = await req.json() as { capture: ComputeCapture; revision: number }
    if (path === '/capture') return Response.json(await this.capture(body.revision))
    if (path === '/step') return Response.json(await this.step(body.capture))
    const reader = this.env.READER.get(this.env.READER.idFromName(readerName(body.capture)))
    if (path === '/release') { await reader.release(body.capture); return Response.json({ ok: true }) }
    if (path === '/snapshot') return Response.json(await (await reader.snapshot(body.capture)).json())
    throw new Error('unknown fixture route')
  }
}
export default { fetch(req, env) { return env.SOURCE.get(env.SOURCE.idFromName('source')).fetch(req) } }
