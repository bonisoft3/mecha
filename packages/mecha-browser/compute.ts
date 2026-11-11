import * as duckdb from 'npm:@duckdb/duckdb-wasm@1.33.1-dev57.0/dist/duckdb-browser.mjs'
import { types, typedSql, type TypeTable, type TypeField } from '../../services/compute/portable-contract.ts'
import { snapshotStatements, snapshotWalStatements } from '../../services/compute/snapshot-data.ts'
import type { Snapshot, Output } from '../compute-snapshot/src/index.ts'

export interface BrowserProgram {
  compiled: object
  reads: string[]
  queries: Record<string, string>
  version: string
  spec: {
    name: string
    file: string
    to: string[]
    endowments?: string[]
    types?: TypeTable
    queryTypes?: Record<string, TypeField[]>
    sinkTypes?: Record<string, TypeField[]>
  }
  wasm: Record<string, string>
}
export interface BrowserCompute {
  programs: BrowserProgram[]
  assets: { icu: string; json: string; duckdb: string; wasm: string; cage: string; job: string }
}
const bytes = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
const objectUrl = async (value: string, type: string) => URL.createObjectURL(new Blob([await new Response(new Blob([bytes(value)]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()], { type }))
const json = (value: unknown) => JSON.stringify(value, (_key, v) => {
  if (v === undefined || typeof v === 'bigint' || typeof v === 'function' || typeof v === 'symbol' ||
    (typeof v === 'number' && !Number.isFinite(v))) throw new TypeError('computation returned a non-JSON value')
  return v
})
function ask(worker: Worker, message: unknown): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data)
    worker.onerror = (event) => { event.preventDefault(); reject(new Error(event.message)) }
    worker.postMessage(message)
  })
}

export async function browserCompute(config: BrowserCompute) {
  const urls = {
    icu: await objectUrl(config.assets.icu, 'application/wasm'),
    json: await objectUrl(config.assets.json, 'application/wasm'),
    duckdb: await objectUrl(config.assets.duckdb, 'text/javascript'),
    wasm: await objectUrl(config.assets.wasm, 'application/wasm'),
    cage: await objectUrl(config.assets.cage, 'text/javascript'),
    job: await objectUrl(config.assets.job, 'text/javascript'),
  }
  const trustedTypes = (globalThis as unknown as { trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(value: string): string }): { createScriptURL(value: string): string } } }).trustedTypes
  const policy = trustedTypes?.createPolicy('mecha-compute', { createScriptURL(value) {
    if (!Object.values(urls).includes(value)) throw new TypeError('undeclared computation worker URL')
    return value
  } })
  const workerUrl = (value: string) => policy?.createScriptURL(value) ?? value
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), new Worker(workerUrl(urls.duckdb)))
  await db.instantiate(urls.wasm)
  const setup = await db.connect()
  try {
    // DuckDB derives its extension entrypoint from the path; fetch ignores this fragment.
    await setup.query(`LOAD '${urls.json}#/json.duckdb_extension.wasm'`)
    await setup.query(`LOAD '${urls.icu}#/icu.duckdb_extension.wasm'`)
    await setup.query("SET autoinstall_known_extensions = false; SET autoload_known_extensions = false; SET TimeZone = 'UTC'; CREATE SCHEMA IF NOT EXISTS duckpipe_replica")
  }
  finally { await setup.close() }
  const programs = new Map(config.programs.map((p) => [p.spec.name, p]))
  const replicaState = new Map<string, { colSig: string; lsn: number; rowSig: string }>()
  let chain: Promise<unknown> = Promise.resolve()
  const execute = (snapshot: Snapshot): Promise<Output> => {
    const work = chain.then(() => run(snapshot))
    chain = work.then(() => undefined, () => undefined)
    return work
  }
  async function run(snapshot: Snapshot): Promise<Output> {
    const p = programs.get(snapshot.name)
    if (!p || p.version !== snapshot.version) throw new Error('snapshot computation version differs from the page')
    const conn = await db.connect()
    const cage = new Worker(workerUrl(urls.cage), { type: 'module' })
    const job = new Worker(workerUrl(urls.job), { type: 'module' })
    let inTx = false
    try {
      const plans = snapshotStatements(snapshot.tables, p.reads, p.spec.types)
      for (const [index, name] of p.reads.entries()) {
        const plan = plans[index]
        const table = snapshot.tables[name]
        const colSig = JSON.stringify({ cols: table.columns, types: p.spec.types ?? null })
        const rowSig = plan.values[0]
        const tableWal = snapshot.wal?.[name]
        const prior = replicaState.get(name)
        if (prior && prior.colSig === colSig && tableWal && tableWal.fromLsn === prior.lsn && tableWal.targetLsn >= prior.lsn) {
          for (const step of snapshotWalStatements(name, tableWal, p.spec.types, 'duckpipe_replica')) {
            if (step.values.length) {
              const statement = await conn.prepare(step.sql)
              try { await statement.query(...step.values) }
              finally { await statement.close() }
            } else {
              await conn.query(step.sql)
            }
          }
          replicaState.set(name, { colSig, lsn: tableWal.targetLsn, rowSig })
        } else if (prior && prior.colSig === colSig && prior.rowSig === rowSig) {
          replicaState.set(name, { colSig, lsn: tableWal?.targetLsn ?? prior.lsn, rowSig })
        } else {
          await conn.query(`DROP TABLE IF EXISTS "duckpipe_replica"."${name}"`)
          await conn.query(plan.create.replace(`CREATE TABLE "${name}"`, `CREATE TABLE "duckpipe_replica"."${name}"`))
          const statement = await conn.prepare(plan.insert.replace(`INTO "${name}"`, `INTO "duckpipe_replica"."${name}"`))
          try { await statement.query(...plan.values) }
          finally { await statement.close() }
          replicaState.set(name, { colSig, lsn: tableWal?.targetLsn ?? 0, rowSig })
        }
      }
      await conn.query('BEGIN TRANSACTION')
      inTx = true
      for (const name of p.reads) {
        await conn.query(`CREATE TEMP VIEW "${name}" AS SELECT * FROM "duckpipe_replica"."${name}"`)
      }
      const bound = p.spec.types ? types(p.spec.types) : undefined
      const inputs: Record<string, unknown[]> = {}
      for (const [name, sql] of Object.entries(p.queries)) {
        const fields = p.spec.queryTypes?.[name]
        const query = fields ? typedSql(bound!.canonicalType, sql, fields) : sql
        const rows = (await conn.query(`SELECT to_json(r)::VARCHAR AS value FROM (${query}) r`)).toArray().map((row: any) => {
          const value = JSON.parse(row.value, (_key: string, v: unknown) => {
            if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v)) throw new Error('untyped query integer exceeds exact JSON range')
            return v
          })
          return fields ? bound!.normalizeRow(fields, value, 'duckdb') : value
        })
        inputs[name] = rows
      }
      const admitted = await ask(cage, { source: p.compiled, file: p.spec.file, endowments: p.spec.endowments ?? [] })
      if (json(admitted.reads) !== json(p.reads) || json(admitted.queries) !== json(p.queries)) throw new Error('packaged computation admission changed')
      const modules = Object.fromEntries(await Promise.all(Object.entries(p.wasm).map(async ([name, value]) => [name, await WebAssembly.compile(bytes(value))])))
      job.postMessage({ modules })
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.spec.name)))
      const seed = new DataView(digest.buffer).getUint32(0, false)
      let { jobs } = await ask(cage, { inputs, seed })
      const ran: string[] = []
      const outputs: unknown[] = []
      for (;;) {
        if (!Array.isArray(jobs) || jobs.some((j) => !j || typeof j.wasm !== 'string' || !(j.wasm in modules) || !('input' in j))) throw new Error('computation returned an undeclared WASM job')
        const planned = jobs.map((j) => json(j))
        if (ran.some((j, i) => j !== planned[i])) throw new Error('computation changed previously answered jobs')
        if (planned.length === ran.length) break
        for (let i = ran.length; i < jobs.length; i++) {
          const answer = await ask(job, { wasm: jobs[i].wasm, input: json(jobs[i].input) })
          outputs.push(JSON.parse(answer.json))
          ran.push(planned[i])
        }
        ;({ jobs } = await ask(cage, { outputs, plan: true }))
      }
      const { out } = await ask(cage, { outputs })
      json(out)
      if (!out || Object.keys(out).sort().join() !== [...p.spec.to].sort().join()) throw new Error('computation output sinks differ from the declaration')
      for (const [table, fields] of Object.entries(p.spec.sinkTypes ?? {})) {
        out[table] = out[table].map((row: Record<string, unknown>) => {
          const normalized = bound!.normalizeRow(fields, row, 'canonical')
          for (const field of fields) if (field.type === 'bytes' && normalized[field.name] !== null) {
            normalized[field.name] = '\\x' + [...bytes(normalized[field.name] as string)].map((b) => b.toString(16).padStart(2, '0')).join('')
          }
          return normalized
        })
      }
      return out
    } finally {
      cage.terminate()
      job.terminate()
      // Every execution owns temporary tables in a private connection transaction.
      if (inTx) await conn.query('ROLLBACK')
      await conn.close()
    }
  }
  return { execute, close: async () => { await chain; await db.terminate(); for (const url of Object.values(urls)) URL.revokeObjectURL(url) } }
}
