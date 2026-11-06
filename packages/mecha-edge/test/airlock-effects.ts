import type { EdgeEffects } from '../src/dispatch.ts'

// The stub origin the test serves; each run's answer is chosen by its input.
export const STUB_PORT = 18766
const declaration = (attempts: number) => ({
  table: 'effect_row', field: 'status', state: 'running', onDone: 'done', onError: 'failed',
  row: ['id'], key: ['id'], idempotent: true, attempts, handler: 'effects/stub.js',
})
const issue = async (input: unknown, sink: { fetch(path: unknown, init?: unknown): Promise<{ status: number; body: unknown }> }) => {
  const { id, mode } = input as { id: string; mode: string }
  const res = await sink.fetch(`/answer/${mode}/${id}`, { method: 'POST', body: input })
  if (res.status >= 300) throw new Error(`the stub answered ${res.status}`)
  return { done: res.body }
}
export const effects: EdgeEffects = {
  stub: { declaration: declaration(3), target: { kind: 'origin', url: `http://127.0.0.1:${STUB_PORT}` }, issue },
  once: { declaration: declaration(1), target: { kind: 'origin', url: `http://127.0.0.1:${STUB_PORT}` }, issue },
  bridged: {
    declaration: { ...declaration(3), idempotent: false, reentry: 'repeat', bridge: { name: 'fixture', targets: [], simulated: true } },
    target: { kind: 'bridge', bridge: 'fixture' },
    issue: () => { throw new Error('a bridge not deployed here is never issued') },
  },
}
