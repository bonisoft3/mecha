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
  factory?: StaticFactory
  steps?: StaticFactory
  wasm: Record<string, WebAssembly.Module>
}

const WASM_OUTPUT_BYTES = 16 * 1024 * 1024

export async function pagedComputeStep(programs: readonly PagedProgram[], queries: ComputeService, capture: ComputeCapture) {
  const program = pagedProgram(programs, capture) as PagedProgram
  const { execution } = await pagedRequest(queries, { capture, action: 'status' }) as { execution: ExecutionState }
  if (execution.done) return execution
  if (!program.steps) {
    if (!program.factory) throw new Error('missing computation factory')
    const inputs: Record<string, unknown[]> = {}
    for (const query of Object.keys(program.queries)) {
      const rows: unknown[] = []
      let after = 0
      for (;;) {
        const page = await pagedRequest<{ after: number; next: number; rows: unknown[]; done: boolean }>(queries, {
          capture, action: 'read', query, after,
        })
        if (!page.rows.length && !page.done) throw new Error('query result read made no progress')
        rows.push(...page.rows)
        if (page.done) break
        after = page.next
      }
      inputs[query] = rows
    }
    const cage = new StaticCage(program.spec.file, program.factory, program.spec.endowments ?? [])
    try {
      const admitted = await cage.load()
      if (strictJson(admitted.reads) !== strictJson(program.reads) || strictJson(admitted.queries) !== strictJson(program.queries) || strictJson(admitted.queryStages ?? null) !== strictJson(program.queryStages ?? null)) throw new Error('packaged computation admission changed')
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(program.spec.name)))
      const seed = new DataView(digest.buffer).getUint32(0, false)
      let { jobs } = await cage.ask({ inputs, seed })
      const ran: string[] = []
      const outputs: unknown[] = []
      for (;;) {
        if (!Array.isArray(jobs) || jobs.some(job => !job || typeof job.wasm !== 'string' || !Object.hasOwn(program.wasm, job.wasm) || !('input' in job))) throw new Error('computation returned an undeclared WASM job')
        const planned = jobs.map(job => strictJson(job))
        if (ran.some((job, i) => job !== planned[i])) throw new Error('computation changed previously answered jobs')
        if (planned.length === ran.length) break
        for (let i = ran.length; i < jobs.length; i++) {
          const out = runWasm(program.wasm[jobs[i].wasm], new TextEncoder().encode(strictJson(jobs[i].input)), jobs[i].wasm)
          if (out.length > WASM_OUTPUT_BYTES) throw new Error('WASM output exceeds byte limit')
          outputs.push(JSON.parse(new TextDecoder().decode(out)))
          ran.push(planned[i])
        }
        ;({ jobs } = await cage.ask({ outputs, plan: true }))
      }
      const { out } = await cage.ask({ outputs })
      if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('computation returned invalid output')
      const step: ExecutionStep = { checkpoint: null, writes: out as Record<string, Record<string, unknown>[]>, done: true }
      return await pagedRequest(queries, { capture, action: 'commit', revision: execution.revision, step })
    } finally { cage.close() }
  }
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
