import { Buffer } from 'node:buffer'
import { decodeBlock, type StorageFormat } from './storage-block.ts'

interface Entry { encoded: Uint8Array; decoded: Uint8Array }

/** SQLite remains authoritative, including across rolled-back storage writes.
 * Matching encoded bytes avoids invalidation state outside its transaction. */
export class BlockDecoder {
  readonly #entries = new Map<string, Entry>()
  #bytes = 0

  constructor(readonly format: StorageFormat, readonly budget = 4 * 1024 * 1024) {}

  get residentBytes(): number { return this.#bytes }

  decode(key: string, encoded: Uint8Array): Uint8Array {
    if (this.format.codec !== 'deflate' || encoded[0] !== 1) return decodeBlock(encoded, this.format)
    const previous = this.#entries.get(key)
    if (previous) {
      this.#entries.delete(key)
      this.#bytes -= previous.encoded.byteLength + previous.decoded.byteLength
      if (Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength).equals(previous.encoded)) {
        this.#entries.set(key, previous)
        this.#bytes += previous.encoded.byteLength + previous.decoded.byteLength
        return previous.decoded
      }
    }
    const decoded = decodeBlock(encoded, this.format)
    const bytes = encoded.byteLength + decoded.byteLength
    if (bytes <= this.budget) {
      while (this.#bytes + bytes > this.budget) {
        const [oldKey, old] = this.#entries.entries().next().value!
        this.#entries.delete(oldKey)
        this.#bytes -= old.encoded.byteLength + old.decoded.byteLength
      }
      this.#entries.set(key, { encoded: encoded.slice(), decoded })
      this.#bytes += bytes
    }
    return decoded
  }
}
