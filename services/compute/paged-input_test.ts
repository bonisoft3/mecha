import assert from 'node:assert/strict'
import { encodeWasmQueryInput, WASM_QUERY_INPUT_BYTES } from '../../packages/mecha-edge/src/paged-compute.ts'

const query = { path: ['request', 'games'], sql: 'SELECT ordinal,value FROM games', orderBy: 'ordinal' }
Deno.test('WASM query input substitutes only its declared array and preserves UTF8 and envelope order', async () => {
  const input = { op: 'eval', request: { games: [], ratings: [{ id: 1 }], note: '雪"\\' }, other: [] }
  let calls = 0
  const bytes = await encodeWasmQueryInput(input, query, after => {
    calls++
    return Promise.resolve(after === -1 ? { after, next: 0, done: false, rows: [{ value: 'é雪' }] }
      : { after, next: 2, done: true, rows: [{ value: null }, { value: 4 / 3 }] })
  })
  assert.equal(calls, 2)
  assert.equal(new TextDecoder().decode(bytes), JSON.stringify({ ...input, request: { ...input.request, games: [{ value: 'é雪' }, { value: null }, { value: 4 / 3 }] } }))
  assert.equal(bytes.buffer.byteLength, WASM_QUERY_INPUT_BYTES)
  assert.deepEqual(input.request.games, [])
})

Deno.test('WASM query input rejects invalid paths, stalled pages and overflow before execution', async () => {
  const empty = { request: { games: [] } }
  const never = () => Promise.reject(new Error('must not read'))
  for (const input of [{}, { request: { games: [1] } }, { request: { games: null } }]) {
    await assert.rejects(() => encodeWasmQueryInput(input, query, never), /path/)
  }
  await assert.rejects(() => encodeWasmQueryInput(empty, { ...query, path: [] }, never), /invalid/)
  await assert.rejects(() => encodeWasmQueryInput(empty, query, after => Promise.resolve({ after, next: after, done: false, rows: [] })), /invalid WASM query page/)
  await assert.rejects(() => encodeWasmQueryInput(empty, query, after => Promise.resolve({ after, next: after + 1, done: false, rows: [{ value: 'x'.repeat(1024 * 1024 - 100) }] })), /input exceeds byte limit/)
  const result = await encodeWasmQueryInput(empty, query, after => Promise.resolve({ after, next: after, done: true, rows: [] }))
  assert.equal(new TextDecoder().decode(result), JSON.stringify(empty))
})
