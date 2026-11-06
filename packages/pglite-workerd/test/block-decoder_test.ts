import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { inflateSync } from 'node:zlib'
import { BlockDecoder } from '../src/block-decoder.ts'
import { encodeBlock, type StorageFormat } from '../src/storage-block.ts'

Deno.test('cached 8 KiB inflations retain only the backing bytes charged to the budget', () => {
  const format: StorageFormat = { version: 1, blockSize: 8192, codec: 'deflate' }
  const source = new Uint8Array(format.blockSize).fill(65)
  const encoded = encodeBlock(source, format)
  const inflated = inflateSync(encoded.subarray(1), { maxOutputLength: format.blockSize })
  assert.ok(inflated.buffer.byteLength > inflated.byteLength)
  const pooled = Buffer.allocUnsafe(16384).subarray(128, 128 + encoded.length)
  pooled.set(encoded)
  const entryBytes = source.byteLength + encoded.byteLength
  const cache = new BlockDecoder(format, entryBytes * 2)
  const first = cache.decode('1:0', pooled)
  const second = cache.decode('1:1', pooled)
  for (const decoded of [first, second]) {
    assert.deepEqual(new Uint8Array(decoded), source)
    assert.equal(decoded.byteOffset, 0)
    assert.equal(decoded.buffer.byteLength, decoded.byteLength)
  }
  assert.equal(cache.residentBytes, first.buffer.byteLength + second.buffer.byteLength + 2 * encoded.byteLength)
  assert.equal(cache.decode('1:1', encoded), second)
  pooled.fill(0)
  assert.equal(cache.decode('1:0', encoded), first)
  cache.decode('1:2', encoded)
  assert.equal(cache.residentBytes, cache.budget)
  assert.equal(cache.decode('1:0', encoded), first)
  assert.notEqual(cache.decode('1:1', encoded), second)
})

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
