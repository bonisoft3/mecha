import assert from 'node:assert/strict'
import { lanes, type Lane } from './lanes.ts'

// Holds the connection while waiters queue, then answers the order they ran in.
async function order(queued: Lane[]) {
  const serialize = lanes()
  let release!: () => void
  const held = serialize(() => new Promise<void>(resolve => { release = resolve }), 'api')
  await Promise.resolve()
  await Promise.resolve()
  const ran: string[] = []
  const all = queued.map((lane, i) => serialize(async () => { ran.push(`${lane}${i}`) }, lane))
  release()
  await held
  await Promise.all(all)
  return ran
}

Deno.test('a write overtakes every render and prefetch queued ahead of it', async () => {
  // It waited behind them in one lane, and the screen waited for it: 8 and 15 seconds in production.
  assert.deepEqual(await order(['low', 'render', 'render', 'api']), ['api3', 'render1', 'render2', 'low0'])
})

Deno.test('a stream of API turns cannot starve a render or a prefetch', async () => {
  const ran = await order(['render', 'low', ...Array(10).fill('api')])
  assert.ok(ran.indexOf('render0') < 6)
  assert.ok(ran.indexOf('low1') < 7)
})

Deno.test('a stream of renders cannot starve a prefetch', async () => {
  const ran = await order(['low', ...Array(8).fill('render')])
  assert.ok(ran.indexOf('low0') <= 4)
})

Deno.test('a turn that fails frees the connection for the next', async () => {
  const serialize = lanes()
  const failed = serialize(() => Promise.reject(new Error('refused')), 'api')
  const next = serialize(async () => 'ran', 'api')
  assert.equal(await failed.catch(e => e.message), 'refused')
  assert.equal(await next, 'ran')
})
