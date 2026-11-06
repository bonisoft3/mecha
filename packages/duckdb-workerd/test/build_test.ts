import assert from 'node:assert/strict'
import { replaceChecked, verifyBytes } from '../build.ts'

Deno.test('loader patch guards reject missing and duplicate upstream structures', () => {
  assert.equal(replaceChecked('aa bb aa', 'aa', 'cc', 2), 'cc bb cc')
  assert.throws(() => replaceChecked('aa', 'aa', 'cc', 2), /expected 2 occurrences, got 1/)
  assert.throws(() => replaceChecked('aa aa aa', /aa/g, 'cc', 2), /expected 2 occurrences, got 3/)
})

Deno.test('upstream assets must match their pinned bytes', async () => {
  const bytes = new TextEncoder().encode('abc')
  assert.equal(await verifyBytes(bytes, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'), bytes)
  await assert.rejects(() => verifyBytes(bytes, '0'.repeat(64)), /checksum mismatch/)
})
