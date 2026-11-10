import { strictJson } from './json.ts'

export interface ExecutionQueryPage { after: number; next: number; done: boolean; rows: Record<string, unknown>[] }
export const EXECUTION_QUERY_BYTES = 1024 * 1024
export const EXECUTION_QUERY_ROWS = 4096
export const EXECUTION_BYTES = 8 * 1024 * 1024
export const EXECUTION_OUTPUT_BYTES = 256 * 1024
export const EXECUTION_OUTPUT_ROWS = 128

const scratchName = '[a-z_][a-z0-9_]{0,62}'
const scratchLiteral = "(?:NULL|TRUE|FALSE|[-+]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][-+]?[0-9]+)?|'(?:[^']|'')*')"
const scratchColumn = `${scratchName}\\s+[a-z_][a-z0-9_]*(?:\\s*\\(\\s*[0-9]+(?:\\s*,\\s*[0-9]+)?\\s*\\))?(?:\\[\\])*`
const scratchValues = `${scratchLiteral}(?:\\s*,\\s*${scratchLiteral})*`
const scratchPredicate = `${scratchName}\\s*(?:=\\s*${scratchLiteral}|IN\\s*\\(\\s*${scratchValues}\\s*\\))`

export function scratchStatement(sql: string) {
  const match = /^\s*(CREATE\s+TABLE|INSERT\s+INTO|DELETE\s+FROM|DROP\s+TABLE)\s+([a-z_][a-z0-9_]{0,62})(?=\s|\(|;|$)/i.exec(sql)
  if (!match) throw new Error('execution statements must target an unqualified scratch table')
  const operation = match[1].toUpperCase().replace(/\s+/g, ' ')
  const name = match[2].toLowerCase()
  const tail = sql.slice(match[0].length)
  if (/^(?:duckdb_|duckstream_|execution_)/.test(name) || /\bnextval\b|\bU\s*&/i.test(sql)) throw new Error('execution statement uses reserved storage')
  const supported = operation === 'CREATE TABLE' ? /^\s+AS\s+(?:SELECT|WITH)\b/i.test(tail) || new RegExp(`^\\s*\\(\\s*${scratchColumn}(?:\\s*,\\s*${scratchColumn})*\\s*\\)\\s*;?\\s*$`, 'i').test(tail)
    : operation === 'INSERT INTO' ? new RegExp(`^\\s+VALUES\\s*\\(\\s*${scratchValues}\\s*\\)(?:\\s*,\\s*\\(\\s*${scratchValues}\\s*\\))*\\s*;?\\s*$`, 'i').test(tail)
    : operation === 'DELETE FROM' ? new RegExp(`^\\s+WHERE\\s+${scratchPredicate}(?:\\s+AND\\s+${scratchPredicate})*\\s*;?\\s*$`, 'i').test(tail)
    : /^\s*;?\s*$/.test(tail)
  if (!supported) throw new Error('unsupported execution scratch statement')
  return { operation, name, sql: `${operation} main."${name}"${tail}`, select: operation === 'CREATE TABLE' ? /^\s+AS\s+([\s\S]+)$/i.exec(tail)?.[1] : undefined }
}

export function validateQueryAst(parsed: { error: boolean; statements?: unknown[]; error_message?: string }): void {
  if (parsed.error || parsed.statements?.length !== 1) throw new Error(`query requires one SELECT statement: ${parsed.error_message ?? 'multiple statements'}`)
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'function_name' && typeof child === 'string' &&
        ['nextval', 'query', 'query_table', 'json_execute_serialized_sql'].includes(child.toLowerCase())) {
        throw new Error(`query function is not permitted: ${child}`)
      }
      visit(child)
    }
  }
  visit(parsed.statements)
}

export interface WasmQueryInput { path: string[]; sql: string; orderBy: string }
export const WASM_QUERY_INPUT_BYTES = 24 * 1024 * 1024

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
