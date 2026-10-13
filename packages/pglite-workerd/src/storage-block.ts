import { deflateSync, inflateSync } from 'node:zlib'

export interface StorageFormat {
  version: 1
  blockSize: number
  codec: 'raw' | 'deflate'
}

export const RAW_FORMAT: StorageFormat = { version: 1, blockSize: 8192, codec: 'raw' }

export function checkFormat(format: StorageFormat): void {
  const size = format.blockSize
  if (format.version !== 1 || !Number.isInteger(size) || size < 8192 || size > 131072 || (size & (size - 1)) !== 0 ||
      (format.codec !== 'raw' && format.codec !== 'deflate')) throw new Error('unsupported filesystem storage format')
}

export function encodeBlock(data: Uint8Array, format: StorageFormat): Uint8Array {
  if (data.length > format.blockSize) throw new Error('filesystem block exceeds its declared size')
  if (format.codec === 'raw') return data
  const compressed = deflateSync(data, { level: 1 })
  const useCompressed = compressed.length < data.length
  const payload = useCompressed ? compressed : data
  const result = new Uint8Array(payload.length + 1)
  result[0] = useCompressed ? 1 : 0
  result.set(payload, 1)
  return result
}

export function decodeBlock(data: Uint8Array, format: StorageFormat): Uint8Array {
  let result: Uint8Array
  if (format.codec === 'raw') result = data
  else if (data[0] === 0) result = data.subarray(1)
  else if (data[0] === 1) result = inflateSync(data.subarray(1), { maxOutputLength: format.blockSize })
  else throw new Error('invalid filesystem block encoding')
  if (result.length > format.blockSize) throw new Error('filesystem block exceeds its declared size')
  return result
}
