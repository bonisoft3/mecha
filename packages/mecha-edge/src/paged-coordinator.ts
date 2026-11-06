import type { SnapshotChunk, SnapshotManifest } from '../../compute-snapshot/src/index.ts'
import { computeFailureKey, type ComputeCapture } from './compute.ts'
import type { ComputeService } from './compute.ts'
import type { ExecutionOutput, ExecutionState } from './paged-execution.ts'
import { pagedRequest } from './paged-transport.ts'

export interface PagedDatabase {
  computeManifest(capture: ComputeCapture): Promise<SnapshotManifest>
  computeChunk(capture: ComputeCapture, source: string, after: number): Promise<SnapshotChunk>
  computeOutputChunk(capture: ComputeCapture, attempt: string, sink: string, ordinal: number, rows: Record<string, unknown>[]): Promise<void>
  computeSealOutput(capture: ComputeCapture, attempt: string, manifest: Record<string, { chunks: number; rows: number }>): Promise<void>
  computePublishStaged(capture: ComputeCapture, attempt: string): Promise<void>
  computePublication(capture: ComputeCapture): Promise<'pending' | 'published' | 'obsolete'>
}
interface Progress {
  owner?: string
  capture: ComputeCapture
  outputs: Record<string, { after: number; chunks: number; rows: number; done: boolean }>
}
interface Storage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<unknown>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
}
interface RemoteStatus {
  sources: { name: string; position: number }[]
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
export async function advancePaged(db: PagedDatabase, service: ComputeService, storage: Storage, capture: ComputeCapture, owner: string): Promise<'transfer' | 'query' | 'compute' | 'published'> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(owner)) throw new Error('invalid paged compute owner')
  const key = keyFor(capture, owner)
  let progress = await storage.get<Progress>(key)
  if (!progress) {
    progress = { owner, capture, outputs: {} }
    await storage.put(key, progress)
  }
  const manifest = await db.computeManifest(capture)
  const status = await pagedRequest<RemoteStatus>(service, { capture, action: 'initialize', manifest })
  const source = status.sources.find(source => source.position < manifest.tables[source.name].rows)
  if (source) {
    const chunk = await db.computeChunk(capture, source.name, source.position)
    await pagedRequest(service, { capture, action: 'append', chunk })
    return 'transfer'
  }
  const query = status.declaredQueries.find(name => !status.queries.includes(name))
  if (query !== undefined) {
    await pagedRequest(service, { capture, action: 'materialize', query })
    return 'query'
  }
  if (!status.execution.done) {
    await pagedRequest(service, { capture, action: 'step' })
    return 'compute'
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
