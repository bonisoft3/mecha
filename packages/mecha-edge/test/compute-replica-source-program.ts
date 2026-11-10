import type { BatchState } from '../../compute-snapshot/src/index.ts'

export const computations = [{ name: 'probe', version: 'v1', reads: ['replica_source'], to: ['replica_result'], coalesceMs: 0 }]
export const machine = { execute(input: any) {
  if (input.initialize) return { kind: 'accepted', state: { phase: 'idle', name: input.payload.name, requested: input.payload.revision, completed: 0, wake: 0, claimed: 0, required: [], due: 0, coalesce: 0, attempts: 25 } as BatchState }
  const state = { ...input.state }
  switch (input.event.kind) {
    case 'invalidate': state.requested++; break
    case 'schedule': state.phase = 'active'; state.due = 0; break
    case 'claim': state.claimed = state.requested; break
    case 'complete': state.completed = state.claimed; state.claimed = 0; state.phase = 'idle'; break
    case 'supersede': state.claimed = 0; state.phase = 'idle'; break
    default: throw new Error('unexpected machine event')
  }
  return { kind: 'accepted', state }
} }
