import assert from 'node:assert/strict'
import { BlockDecoder } from '../src/block-decoder.ts'
import { encodeBlock, type StorageFormat } from '../src/storage-block.ts'

Deno.test('decoded blocks track authoritative bytes through writes and rollback within a bounded budget', () => {
  const format: StorageFormat = { version: 1, blockSize: 131072, codec: 'deflate' }
  const cache = new BlockDecoder(format, 300000)
  const a = new Uint8Array(format.blockSize).fill(65)
  const b = new Uint8Array(format.blockSize).fill(66)
  const encoded = encodeBlock(a, format)
  assert.deepEqual(new Uint8Array(cache.decode('1:0', encoded)), a)
  assert.deepEqual(new Uint8Array(cache.decode('1:0', encodeBlock(b, format))), b)
  assert.deepEqual(new Uint8Array(cache.decode('1:0', encoded)), a)
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(new Uint8Array(cache.decode(`2:${i}`, encoded)), a)
    assert.ok(cache.residentBytes <= cache.budget)
  }
  cache.decode('3:0', encoded)
  encoded[encoded.length - 1] ^= 1
  assert.throws(() => cache.decode('3:0', encoded))
  assert.ok(cache.residentBytes <= cache.budget)
})
