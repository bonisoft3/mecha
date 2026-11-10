import { encodeWasmQueryInput, type WasmQueryInput } from '../../compute-snapshot/src/bounded.ts'
export { encodeWasmQueryInput, WASM_QUERY_INPUT_BYTES, type WasmQueryInput } from '../../compute-snapshot/src/bounded.ts'
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

const WASM_OUTPUT_BYTES = 16 * 1024 * 1024

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
