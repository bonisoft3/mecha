import { postgresRows, type TypeField, type TypeTable } from '../../../services/compute/portable-contract.ts'
import { validateSnapshot, type Snapshot } from '../../../services/compute/snapshot-data.ts'
import type { Output } from '../../compute-snapshot/src/index.ts'

export interface SnapshotProgram {
  version: string
  reads: string[]
  queries: Record<string, string>
  queryStages?: import("../../../services/compute/query-stages.ts").StagedQueries
  spec: {
    name: string
    file: string
    to: string[]
    endowments?: string[]
    types?: TypeTable
    queryTypes?: Record<string, TypeField[]>
    sinkTypes?: Record<string, TypeField[]>
  }
}

export function strictJson(value: unknown): string {
  const result = JSON.stringify(value, (_key, v) => {
    if (v === undefined || typeof v === 'bigint' || typeof v === 'function' || typeof v === 'symbol' ||
      (typeof v === 'number' && !Number.isFinite(v))) throw new TypeError('computation returned a non-JSON value')
    return v
  })
  if (result === undefined) throw new TypeError('computation returned no value')
  return result
}

export function programFor(programs: readonly SnapshotProgram[], snapshot: Snapshot) {
  validateSnapshot(snapshot)
  const program = programs.find(p => p.spec.name === snapshot.name)
  if (!program || program.version !== snapshot.version) throw new Error('snapshot computation artifact version differs')
  return program
}

export const identity = ({ id, name, version, revision }: Snapshot) => ({ id, name, version, revision })

export function validateIdentity(snapshot: Snapshot, result: Record<string, unknown>) {
  for (const [field, value] of Object.entries(identity(snapshot))) {
    if (result[field] !== value) throw new Error('compute response belongs to a different capture')
  }
}

export function outputFor(program: SnapshotProgram, value: unknown): Output {
  strictJson(value)
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...program.spec.to].sort().join()) throw new Error('computation output sinks differ from the declaration')
  const result: Output = {}
  for (const table of program.spec.to) {
    const rows = (value as Output)[table]
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error(`invalid sink rows: ${table}`)
    const fields = program.spec.sinkTypes?.[table]
    const ids = new Set<string>()
    let columns: string | undefined
    const normalizedRows = fields ? postgresRows({ fields, types: program.spec.types! }, rows) : rows
    result[table] = normalizedRows.map(normalized => {
      if (typeof normalized.id !== 'string' || ids.has(normalized.id)) throw new Error(`duplicate or invalid sink id: ${table}`)
      ids.add(normalized.id)
      const names = Object.keys(normalized).sort().join()
      columns ??= names
      if (names !== columns) throw new Error(`sink columns differ: ${table}`)
      return normalized
    })
  }
  strictJson(result)
  return result
}
