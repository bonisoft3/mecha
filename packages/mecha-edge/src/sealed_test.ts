import assert from 'node:assert/strict'
import { SealedValues, xidAfter } from './sealed.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// The interpreter enqueues an effect at the write's commit, so its claim can
// reach the object while the write's answer is still on its way: it waits for
// the write, then finds the value.
Deno.test('a claim that arrives before the write settles waits for it and finds its value', async () => {
  const sealed = new SealedValues(300_000)
  const settle = sealed.writing([{ at: ['row-1'], value: 'seal1.a' }])
  let found: string | undefined | null = null
  const claim = sealed.take('row-1').then((h) => (found = h?.value))
  await tick()
  assert.equal(found, null, 'the claim answered before the write settled')
  await settle(() => true)
  await claim
  assert.equal(found, 'seal1.a')
})

// A write that failed, or landed on no row the caller may write, keeps
// nothing, so its value never reaches another reader's effect.
Deno.test('a write that did not land keeps nothing, and a claim waiting on it finds none', async () => {
  const sealed = new SealedValues(300_000)
  const settle = sealed.writing([{ at: ['row-1', 'ROW-1'], value: 'seal1.a' }])
  const claim = sealed.take('row-1')
  await settle(() => false)
  assert.equal(await claim, undefined)
  assert.equal(await sealed.take('ROW-1'), undefined)
})

Deno.test('a value is kept under the spellings the write landed on alone', async () => {
  const sealed = new SealedValues(300_000)
  await sealed.writing([{ at: ['ABC', 'abc'], value: 'seal1.a' }])((at) => at === 'abc')
  assert.equal((await sealed.take('abc'))?.value, 'seal1.a')
  assert.equal(await sealed.take('ABC'), undefined)
})

// Two writes to one row reach the database in the order they were offered:
// the later one's value stands, whichever answer came back first.
Deno.test('writes to one row settle in the order they were offered', async () => {
  const sealed = new SealedValues(300_000)
  const first = sealed.writing([{ at: ['row-1'], value: 'seal1.first' }])
  const second = sealed.writing([{ at: ['row-1'], value: 'seal1.second' }])
  const claim = sealed.take('row-1')
  const late = second(() => true)
  await tick()
  await first(() => true)
  await late
  assert.equal((await claim)?.value, 'seal1.second')
})

Deno.test('a value past its time is gone', async () => {
  let now = 0
  const sealed = new SealedValues(1_000, () => now)
  await sealed.writing([{ at: ['row-1'], value: 'seal1.a' }])(() => true)
  now = 999
  assert.equal((await sealed.take('row-1'))?.value, 'seal1.a')
  now = 1_000
  assert.equal(await sealed.take('row-1'), undefined)
})

// Two writes to one row can commit in the order other than the one they were
// offered in: the value of the later commit stands.
Deno.test('of two writes to one row, the later commit holds, whichever was offered first', async () => {
  const sealed = new SealedValues(300_000)
  const first = sealed.writing([{ at: ['row-1'], value: 'seal1.first' }])
  const second = sealed.writing([{ at: ['row-1'], value: 'seal1.second' }])
  // The second offered committed first (transaction 7), the first after (8).
  await Promise.all([second(() => true, 7), first(() => true, 8)])
  assert.equal((await sealed.take('row-1'))?.value, 'seal1.first')
  const third = sealed.writing([{ at: ['row-1'], value: 'seal1.third' }])
  await third(() => true, 9)
  assert.equal((await sealed.take('row-1'))?.value, 'seal1.third')
})

Deno.test('a transaction past the 32-bit wraparound is the later one', async () => {
  assert.equal(xidAfter(3, 4294967295), true)
  assert.equal(xidAfter(4294967295, 3), false)
  assert.equal(xidAfter(9, 8), true)
  const sealed = new SealedValues(300_000)
  await sealed.writing([{ at: ['row-1'], value: 'seal1.before' }])(() => true, 4294967295)
  await sealed.writing([{ at: ['row-1'], value: 'seal1.after' }])(() => true, 3)
  assert.equal((await sealed.take('row-1'))?.value, 'seal1.after')
})
