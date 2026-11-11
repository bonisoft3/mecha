import type { SnapshotChunk, SnapshotIdentity, SnapshotManifest, SnapshotTableWal } from '../../compute-snapshot/src/index.ts'
import { computeFailureKey, type ComputeCapture } from './compute.ts'
import type { ComputeService } from './compute.ts'
import type { ExecutionOutput, ExecutionState } from './paged-execution.ts'
import { pagedRequest } from './paged-transport.ts'
import { strictJson } from './snapshot-program.ts'

export interface PagedDatabase {
  computeManifest(capture: ComputeCapture): Promise<SnapshotManifest>
  computeChunk(capture: ComputeCapture, source: string, after: number): Promise<SnapshotChunk>
  computeWal?(capture: ComputeCapture, source: string, afterLsn: number): Promise<(SnapshotTableWal & SnapshotIdentity & { table: string }) | null>
  computeOutputChunk(capture: ComputeCapture, attempt: string, sink: string, ordinal: number, rows: Record<string, unknown>[]): Promise<void>
  computeSealOutput(capture: ComputeCapture, attempt: string, manifest: Record<string, { chunks: number; rows: number }>): Promise<void>
  computePublishStaged(capture: ComputeCapture, attempt: string): Promise<void>
  computePublication(capture: ComputeCapture): Promise<'pending' | 'published' | 'obsolete'>
}
interface Progress {
  owner?: string
  capture: ComputeCapture
  manifest?: SnapshotManifest
  outputs: Record<string, { after: number; chunks: number; rows: number; done: boolean }>
}
interface Storage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<unknown>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
}
interface RemoteStatus {
  manifest: SnapshotManifest
  sources: { name: string; position: number }[]
  walSources?: { name: string; fromLsn: number; targetLsn: number }[]
  queries: string[]
  declaredQueries: string[]
  sinks: string[]
  execution: ExecutionState
}
const keyFor = (capture: ComputeCapture, owner: string) => `paged:${JSON.stringify([owner, capture.generation, capture.identity.id])}`

export async function retainedPaged(storage: Storage, owner?: string) {
  return [...await storage.list<Progress>({ prefix: 'paged:' })]
    .filter(([, progress]) => !owner || progress.owner !== owner)
    .map(([key, progress]) => ({ key, owner: progress.owner ?? null, capture: progress.capture }))
}

export async function reclaimPaged(db: PagedDatabase, service: ComputeService, storage: Storage, owner?: string) {
  const reclaimed: ComputeCapture[] = []
  for (const [key, progress] of await storage.list<Progress>({ prefix: 'paged:' })) {
    if (!owner || progress.owner !== owner) continue
    if (await db.computePublication(progress.capture) === 'pending') continue
    await pagedRequest(service, { capture: progress.capture, action: 'cleanup' })
    await storage.delete(computeFailureKey(progress.capture))
    await storage.delete(key)
    reclaimed.push(progress.capture)
  }
  return reclaimed
}

/** Each acknowledgement follows a durable write; losing it only repeats that step. */
export async function advancePaged(db: PagedDatabase, service: ComputeService, storage: Storage, capture: ComputeCapture, owner: string, session?: { executing: boolean; transfer?: { key: string; status: RemoteStatus } }): Promise<'transfer' | 'query' | 'compute' | 'published'> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner)) throw new Error('invalid paged compute owner')
  const step = async () => {
    if (session) session.executing = false
    const execution = await pagedRequest<ExecutionState>(service, { capture, action: 'step' })
    if (typeof execution?.done !== 'boolean') throw new Error('invalid paged execution state')
    if (session) session.executing = !execution.done
    return 'compute' as const
  }
  if (session?.executing) return await step()
  const key = keyFor(capture, owner)
  let progress = await storage.get<Progress>(key)
  if (!progress) {
    progress = { owner, capture, outputs: {} }
    await storage.put(key, progress)
  }
  let manifest = progress.manifest
  const transfer = session?.transfer
  if (session) delete session.transfer
  let status: RemoteStatus
  if (!manifest) {
    manifest = await db.computeManifest(capture)
    for (const field of ['id', 'name', 'version', 'revision'] as const) {
      if (manifest[field] !== capture.identity[field]) throw new Error('paged manifest belongs to another capture')
    }
    status = await pagedRequest<RemoteStatus>(service, { capture, action: 'initialize', manifest })
    if (strictJson(status.manifest) !== strictJson(manifest)) throw new Error('paged manifest differs from capture')
    progress.manifest = manifest
    await storage.put(key, progress)
  } else {
    try {
      status = transfer?.key === key ? transfer.status : await pagedRequest<RemoteStatus>(service, { capture, action: 'status' })
    } catch (error) {
      if (!/compute object belongs to another capture|capture is not initialized/.test(String(error))) throw error
      status = await pagedRequest<RemoteStatus>(service, { capture, action: 'initialize', manifest })
    }
    if (strictJson(status.manifest) !== strictJson(manifest)) throw new Error('paged manifest differs from capture')
  }
  for (const field of ['id', 'name', 'version', 'revision'] as const) {
    if (manifest[field] !== capture.identity[field]) throw new Error('paged manifest belongs to another capture')
  }
  const walSource = status.walSources?.[0]
  if (walSource) {
    const wal = db.computeWal ? await db.computeWal(capture, walSource.name, walSource.fromLsn) : null
    let applied = false
    if (wal) {
      try {
        const acknowledgement = await pagedRequest<{ next: number }>(service, { capture, action: 'apply-wal', wal })
        if (acknowledgement.next !== manifest.tables[walSource.name].rows) throw new Error('capture WAL acknowledgement differs')
        const source = status.sources.find(item => item.name === walSource.name)
        if (source) source.position = acknowledgement.next
        status.walSources = status.walSources?.filter(item => item.name !== walSource.name)
        applied = true
      } catch (error) {
        if (!/replica row count mismatch|capture WAL/.test(String(error))) throw error
      }
    }
    if (!applied) {
      const acknowledgement = await pagedRequest<{ next: number }>(service, { capture, action: 'reset-source', table: walSource.name })
      if (acknowledgement.next !== 0) throw new Error('capture reset acknowledgement differs')
      const source = status.sources.find(item => item.name === walSource.name)
      if (source) source.position = 0
      status.walSources = status.walSources?.filter(item => item.name !== walSource.name)
    }
    if (session && ((status.walSources?.length ?? 0) > 0 || status.sources.some(source => source.position < manifest.tables[source.name].rows))) {
      session.transfer = { key, status }
    }
    return 'transfer'
  }
  const source = status.sources.find(source => source.position < manifest.tables[source.name].rows)
  if (source) {
    const chunk = await db.computeChunk(capture, source.name, source.position)
    const acknowledgement = await pagedRequest<{ next: number }>(service, { capture, action: 'append', chunk })
    if (acknowledgement.next !== chunk.next) throw new Error('capture append acknowledgement differs')
    source.position = acknowledgement.next
    // An interrupted call discards this alarm-local cache; the next alarm reads durable progress.
    if (session && status.sources.some(source => source.position < manifest.tables[source.name].rows)) {
      session.transfer = { key, status }
    }
    return 'transfer'
  }
  const query = status.declaredQueries.find(name => !status.queries.includes(name))
  if (query !== undefined) {
    await pagedRequest(service, { capture, action: 'materialize', query })
    return 'query'
  }
  if (!status.execution.done) {
    return await step()
  }
  for (const sink of status.sinks) {
    const output = progress.outputs[sink] ?? { after: 0, chunks: 0, rows: 0, done: false }
    if (output.done) continue
    const chunk = await pagedRequest<ExecutionOutput>(service, { capture, action: 'output', sink, after: output.after })
    if (!chunk.rows.length && !chunk.done) throw new Error('output transfer made no progress')
    if (chunk.rows.length) await db.computeOutputChunk(capture, owner, sink, output.chunks, chunk.rows)
    progress.outputs[sink] = {
      after: chunk.next, chunks: output.chunks + (chunk.rows.length ? 1 : 0), rows: output.rows + chunk.rows.length, done: chunk.done,
    }
    await storage.put(key, progress)
    return 'transfer'
  }
  await db.computeSealOutput(capture, owner, Object.fromEntries(status.sinks.map(sink => {
    const output = progress.outputs[sink]
    if (!output?.done) throw new Error('output transfer is incomplete')
    return [sink, { chunks: output.chunks, rows: output.rows }]
  })))
  await db.computePublishStaged(capture, owner)
  await reclaimPaged(db, service, storage, owner)
  return 'published'
}
