import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { checkFormat, decodeBlock, encodeBlock, type StorageFormat } from '../src/storage-block.ts'

Deno.test('compressed blocks preserve random bytes and reject damaged or oversized streams', () => {
  const format: StorageFormat = { version: 1, blockSize: 8192, codec: 'deflate' }
  const random = crypto.getRandomValues(new Uint8Array(8192))
  const raw = encodeBlock(random, format)
  assert.equal(raw[0], 0)
  assert.deepEqual(decodeBlock(raw, format), random)
  const repeated = new Uint8Array(8192).fill(42)
  const packed = encodeBlock(repeated, format)
  assert.equal(packed[0], 1)
  assert.deepEqual(new Uint8Array(decodeBlock(packed, format)), repeated)
  packed[packed.length - 1] ^= 1
  assert.throws(() => decodeBlock(packed, format))
  const oversized = deflateSync(new Uint8Array(8193))
  assert.throws(() => decodeBlock(new Uint8Array([1, ...oversized]), format))
  assert.throws(() => decodeBlock(new Uint8Array(8194), format), /exceeds/)
  assert.throws(() => decodeBlock(new Uint8Array(), format), /encoding/)
  assert.throws(() => checkFormat({ ...format, blockSize: 12288 }), /unsupported/)
  assert.throws(() => checkFormat({ ...format, version: 2 } as unknown as StorageFormat), /unsupported/)
})
