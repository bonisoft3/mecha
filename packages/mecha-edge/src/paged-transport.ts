import { withComputeTimeout, type ComputeService } from './compute.ts'
import type { ComputeCapture } from './compute.ts'
import { EXECUTION_BYTES, type ExecutionStep } from './paged-execution.ts'
import type { SnapshotChunk, SnapshotManifest } from '../../compute-snapshot/src/index.ts'
import { strictJson, type SnapshotProgram } from './snapshot-program.ts'

export interface PagedRequest {
  capture: ComputeCapture
  action: string
  manifest?: SnapshotManifest
  chunk?: SnapshotChunk
  query?: string
  orderBy?: string
  sql?: string
  revision?: number
  step?: ExecutionStep
  sink?: string
  after?: number
}

export async function pagedRequest<T = unknown>(service: ComputeService, request: PagedRequest): Promise<T> {
  const body = strictJson(request)
  if (new TextEncoder().encode(body).length > EXECUTION_BYTES + 65536) throw new Error('paged request exceeds byte limit')
  return await withComputeTimeout(async signal => {
    const response = await service.fetch(`https://compute/paged?key=${encodeURIComponent(JSON.stringify([request.capture.generation, request.capture.identity.id]))}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal })
    if (!response.ok) throw new Error(`paged computation ${response.status}: ${await response.text()}`)
    return await response.json() as T
  })
}

export function pagedProgram(programs: readonly SnapshotProgram[], capture: ComputeCapture) {
  const identity = capture?.identity
  if (typeof capture?.generation !== 'string' || !capture.generation || !identity ||
    !['id','name','version'].every(field => typeof identity[field as keyof typeof identity] === 'string' && identity[field as keyof typeof identity]) ||
    !Number.isSafeInteger(identity.revision) || identity.revision < 1) throw new Error('invalid paged capture')
  const program = programs.find(p => p.spec.name === identity.name && p.version === identity.version)
  if (!program) throw new Error('paged computation artifact differs')
  return program
}
