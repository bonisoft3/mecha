import type { Output, Snapshot, SnapshotIdentity } from '../../compute-snapshot/src/index.ts'
import { validateIdentity } from './snapshot-program.ts'

export interface ComputeCapture { generation: string; identity: SnapshotIdentity }
export const computeFailureKey = (capture: ComputeCapture) => `failure:${JSON.stringify([capture.generation, capture.identity.name])}`

export interface ComputeService {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>
}

export async function withComputeTimeout<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Compute request timed out', 'TimeoutError')), 300_000)
  try { return await work(controller.signal) }
  finally { clearTimeout(timer) }
}

/** A private service binding carries captures; the caller alone can publish its answer. */
export function serviceExecutor(service: ComputeService) {
  return (snapshot: Snapshot): Promise<Output> => withComputeTimeout(async signal => {
    const response = await service.fetch('https://compute/execute', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot),
      signal,
    })
    if (!response.ok) throw new Error(`compute execution ${response.status}: ${await response.text()}`)
    const result = await response.json() as Record<string, unknown> & { sinks: Output }
    validateIdentity(snapshot, result)
    return result.sinks
  })
}
