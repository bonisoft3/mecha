import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { BloblangRuntime } from './runtime.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('BloblangRuntime', () => {
  let runtime: BloblangRuntime

  beforeAll(async () => {
    const wasmPath = resolve(__dirname, 'blobl.wasm')
    const wasmExecPath = resolve(__dirname, 'wasm_exec.js')
    runtime = await BloblangRuntime.create({
      wasmBinary: readFileSync(wasmPath),
      wasmExecJs: readFileSync(wasmExecPath, 'utf-8'),
    })
  })

  afterAll(() => {
    runtime?.destroy()
  })

  it('executes a simple mapping', async () => {
    const result = await runtime.execute(
      'root.greeting = this.name + " world"',
      { name: 'hello' }
    )
    expect(result).toEqual({ greeting: 'hello world' })
  })

  it('executes the mecha enrichment pattern', async () => {
    const mapping = `root = if this.processed_at == null {
  { "processed_at": now(), "source": "mecha-browser" }
} else {
  deleted()
}`
    const result = await runtime.execute(mapping, { id: '1', processed_at: null })
    expect(result).toHaveProperty('processed_at')
    expect(result.source).toBe('mecha-browser')
  })

  it('returns deleted() for already-enriched rows', async () => {
    const mapping = `root = if this.processed_at == null {
  { "processed_at": now(), "source": "mecha-browser" }
} else {
  deleted()
}`
    await expect(
      runtime.execute(mapping, { id: '1', processed_at: '2026-01-01' })
    ).rejects.toThrow()
  })

  it('throws on invalid mapping', async () => {
    await expect(
      runtime.execute('root = !!!invalid!!!', { a: 1 })
    ).rejects.toThrow('parse')
  })
})
