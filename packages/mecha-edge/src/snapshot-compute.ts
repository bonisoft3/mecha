import { StaticCage, type StaticFactory } from '../../../services/compute/static-cage.ts'
import { runWasm } from '../../../services/compute/wasi.ts'
import type { Snapshot } from '../../../services/compute/snapshot-data.ts'
import { identity, outputFor, programFor, strictJson, validateIdentity, type SnapshotProgram } from './snapshot-program.ts'
import type { ComputeService } from './compute.ts'

export interface StaticProgram extends SnapshotProgram {
  factory: StaticFactory
  wasm: Record<string, WebAssembly.Module>
}

export async function computeSnapshot(programs: readonly StaticProgram[], queries: ComputeService, snapshot: Snapshot) {
  const program = programFor(programs, snapshot) as StaticProgram
  const response = await queries.fetch('https://queries/execute', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot),
  })
  if (!response.ok) throw new Error(`snapshot queries ${response.status}: ${await response.text()}`)
  const answer = await response.json() as Record<string, unknown> & { inputs: Record<string, unknown[]> }
  validateIdentity(snapshot, answer)
  if (!answer.inputs || Object.keys(answer.inputs).sort().join() !== Object.keys(program.queries).sort().join() ||
    Object.values(answer.inputs).some(rows => !Array.isArray(rows))) throw new Error('snapshot query inputs differ from the declaration')
  const cage = new StaticCage(program.spec.file, program.factory, program.spec.endowments ?? [])
  try {
    const admitted = await cage.load()
    if (strictJson(admitted.reads) !== strictJson(program.reads) || strictJson(admitted.queries) !== strictJson(program.queries) || strictJson(admitted.queryStages ?? null) !== strictJson(program.queryStages ?? null)) throw new Error('packaged computation admission changed')
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(program.spec.name)))
    const seed = new DataView(digest.buffer).getUint32(0, false)
    let { jobs } = await cage.ask({ inputs: answer.inputs, seed })
    const ran: string[] = []
    const outputs: unknown[] = []
    for (;;) {
      if (!Array.isArray(jobs) || jobs.some(job => !job || typeof job.wasm !== 'string' || !Object.hasOwn(program.wasm, job.wasm) || !('input' in job))) throw new Error('computation returned an undeclared WASM job')
      const planned = jobs.map(job => strictJson(job))
      if (ran.some((job, i) => job !== planned[i])) throw new Error('computation changed previously answered jobs')
      if (planned.length === ran.length) break
      for (let i = ran.length; i < jobs.length; i++) {
        const out = runWasm(program.wasm[jobs[i].wasm], new TextEncoder().encode(strictJson(jobs[i].input)), jobs[i].wasm)
        outputs.push(JSON.parse(new TextDecoder().decode(out)))
        ran.push(planned[i])
      }
      ;({ jobs } = await cage.ask({ outputs, plan: true }))
    }
    const { out } = await cage.ask({ outputs })
    return { ...identity(snapshot), sinks: outputFor(program, out) }
  } finally { cage.close() }
}
