import { DurableObject } from 'cloudflare:workers'
import { edgeObject } from '../src/object.ts'
import { ComputeReaderOwners } from '../src/compute-reader-owners.ts'
import { readerName, physicalSnapshotId } from '../src/compute-reader.ts'
import { PhysicalSnapshots } from '../../pglite-workerd/src/physical-snapshot.ts'
import { computations, machine } from './compute-replica-source-program.ts'
import pgliteWasm from '../../pglite-workerd/dist/pglite.wasm'
import initdbWasm from '../../pglite-workerd/dist/initdb.wasm'
import pgliteData from '../../pglite-workerd/dist/pglite.data'
import icu from '../../pglite-workerd/dist/icu-root.tgz'

const assets = { pgliteWasm, initdbWasm, pgliteData, icu }
export class Coordinator extends DurableObject { async wake() {} }
const Base = edgeObject({ assets, tables: ['note', 'board'], clock: 'disabled', compute: { computations, machine, physicalSnapshots: true, reader: 'current' } })
export class Cluster extends Base {
  #transactions = 0
  #observing = false
  override async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path === '/test/transactions') {
      if (!this.#observing) {
        const db = await this.booted()
        const transaction = db.transaction.bind(db)
        db.transaction = ((...args: Parameters<typeof db.transaction>) => { this.#transactions++; return transaction(...args) }) as typeof db.transaction
        this.#observing = true
      }
      return Response.json(this.#transactions)
    }
    if (path === '/test/release-snapshot') {
      const snapshots = new PhysicalSnapshots(this.ctx.storage.sql, fn => this.ctx.storage.transactionSync(fn))
      snapshots.release(physicalSnapshotId(await req.json() as any))
      return Response.json(true)
    }
    if (path === '/test/write') { const db = await this.booted(); await db.exec("UPDATE replica_source SET value=value+1"); return Response.json(true) }
    if (path === '/test/ledger') {
      const owners = new ComputeReaderOwners(this.ctx.storage.sql)
      return Response.json({ owners: owners.list(), bases: owners.bases(), snapshots: this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE name='fs_snapshot'").toArray().length ? this.ctx.storage.sql.exec('SELECT id FROM fs_snapshot ORDER BY id').toArray().map(row => row.id) : [] })
    }
    if (path === '/test/foreign') {
      const capture = await req.json() as any
      const owners = new ComputeReaderOwners(this.ctx.storage.sql)
      owners.promote('foreign', capture)
      return Response.json(true)
    }
    return await super.fetch(req)
  }
}
export default { async fetch(req: Request, env: any) {
  const path = new URL(req.url).pathname
  const cluster = env.CLUSTER.get(env.CLUSTER.idFromName('cluster'))
  if (path.startsWith('/import/') || path.startsWith('/test/')) return cluster.fetch(req)
  if (path === '/claim') return Response.json(await cluster.computeClaim())
  const body = await req.json() as any
  if (path === '/reader-status') return Response.json(await env.COMPUTE_READER.get(env.COMPUTE_READER.idFromName(readerName(body))).status(body))
  if (path === '/prepare') return Response.json(await cluster.computePrepare(body))
  if (path === '/snapshot') return await cluster.computeSnapshot(body)
  if (path === '/seal') { await cluster.computeSealOutput(body, 'attempt', { replica_result: { chunks: 0, rows: 0 } }); return Response.json(true) }
  if (path === '/publish') { await cluster.computePublishStaged(body, 'attempt'); return Response.json(true) }
  throw new Error('unknown route')
} }
