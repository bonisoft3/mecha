import { StaticCage, type StaticFactory } from '../../../services/compute/static-cage.ts'
import { runWasm } from '../../../services/compute/wasi.ts'
import type { ComputeService } from './compute.ts'
import type { ComputeCapture } from './compute.ts'
import { EXECUTION_BYTES, type ExecutionState, type ExecutionStep, type ExecutionQueryPage } from './paged-execution.ts'
import { strictJson, type SnapshotProgram } from './snapshot-program.ts'
import { pagedRequest, pagedProgram } from './paged-transport.ts'

export interface PagedProgram extends SnapshotProgram {
  steps: StaticFactory
  wasm: Record<string, WebAssembly.Module>
}

export interface WasmQueryInput { path: string[]; sql: string; orderBy: string }
export const WASM_QUERY_INPUT_BYTES = 24 * 1024 * 1024
const WASM_OUTPUT_BYTES = 16 * 1024 * 1024

/** Only the bounded row page crosses JS; the complete request lives in one byte buffer. */
export async function encodeWasmQueryInput(input: unknown, query: WasmQueryInput,
  read: (after: number) => Promise<ExecutionQueryPage>): Promise<Uint8Array> {
  if (!query || !Array.isArray(query.path) || !query.path.length || query.path.some(key => typeof key !== 'string' || !key.length) ||
    typeof query.sql !== 'string' || !query.sql.trim() || typeof query.orderBy !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/i.test(query.orderBy)) throw new Error('invalid WASM query input')
  const encoder = new TextEncoder()
  const envelope = strictJson(input)
  if (encoder.encode(envelope).length > EXECUTION_BYTES) throw new Error('WASM input envelope exceeds byte limit')
  const root = JSON.parse(envelope)
  let target = root
  for (const key of query.path) {
    if (!target || typeof target !== 'object' || Array.isArray(target) || !Object.hasOwn(target, key)) throw new Error('WASM query path is missing')
    target = target[key]
  }
  if (!Array.isArray(target) || target.length) throw new Error('WASM query path must contain an empty array')
  const buffer = new Uint8Array(WASM_QUERY_INPUT_BYTES)
  let position = 0
  const append = (text: string) => {
    const { read, written } = encoder.encodeInto(text, buffer.subarray(position))
    if (read !== text.length) throw new Error('WASM query input exceeds byte limit')
    position += written
  }
  const encode = async (value: unknown): Promise<void> => {
    if (value === target) {
      append('[')
      let after = -1, first = true
      for (;;) {
        const page = await read(after)
        if (page.after !== after || typeof page.done !== 'boolean' || !Array.isArray(page.rows) ||
          !Number.isSafeInteger(page.next) || page.next < after ||
          (page.rows.length ? page.next <= after : page.next !== after || !page.done)) throw new Error('invalid WASM query page')
        for (const row of page.rows) {
          if (!first) append(',')
          append(strictJson(row))
          first = false
        }
        after = page.next
        if (page.done) break
      }
      append(']')
    } else if (Array.isArray(value)) {
      append('[')
      for (let i = 0; i < value.length; i++) { if (i) append(','); await encode(value[i]) }
      append(']')
    } else if (value !== null && typeof value === 'object') {
      append('{')
      let first = true
      for (const [key, child] of Object.entries(value)) {
        if (!first) append(',')
        append(JSON.stringify(key) + ':')
        await encode(child)
        first = false
      }
      append('}')
    } else {
      if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error('WASM input requires lossless JSON')
      append(strictJson(value))
    }
  }
  await encode(root)
  return buffer.subarray(0, position)
}

export async function pagedComputeStep(programs: readonly PagedProgram[], queries: ComputeService, capture: ComputeCapture) {
  const program = pagedProgram(programs, capture) as PagedProgram
  const { execution } = await pagedRequest(queries, { capture, action: 'status' }) as { execution: ExecutionState }
  if (execution.done) return execution
  const cage = new StaticCage(program.spec.file, program.steps, program.spec.endowments ?? [])
  try {
    await cage.load()
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(program.spec.name)))
    const run = (name: string, bytes: Uint8Array) => {
      const out = runWasm(program.wasm[name], bytes, name)
      if (out.length > WASM_OUTPUT_BYTES) throw new Error('WASM output exceeds byte limit')
      return harden(JSON.parse(new TextDecoder().decode(out)))
    }
    const host = {
      seed: new DataView(digest.buffer).getUint32(0, false),
      query: async (sql: string) => harden(await pagedRequest(queries, { capture, action: 'query', sql })),
      wasm: async (name: string, input: unknown) => {
        if (!Object.hasOwn(program.wasm, name)) throw new Error('undeclared WASM module')
        const bytes = new TextEncoder().encode(strictJson(input))
        if (bytes.length > EXECUTION_BYTES) throw new Error('WASM input exceeds byte limit')
        return await Promise.resolve(run(name, bytes))
      },
      wasmFromQuery: async (name: string, input: unknown, query: WasmQueryInput) => {
        if (!Object.hasOwn(program.wasm, name)) throw new Error('undeclared WASM module')
        const sql = query?.sql, orderBy = query?.orderBy
        const bytes = await encodeWasmQueryInput(input, query, after => pagedRequest<ExecutionQueryPage>(queries, {
          capture, action: 'query-page', revision: execution.revision, sql, orderBy, after,
        }))
        return run(name, bytes)
      },
    }
    const step = await cage.advance(host, execution.checkpoint) as ExecutionStep
    return await pagedRequest(queries, { capture, action: 'commit', revision: execution.revision, step })
  } finally { cage.close() }
}
