import type { PGlite } from '@electric-sql/pglite'
import { validateIdentifier } from './validate.js'

type Queryable = Pick<PGlite, 'query'>

export class ReadQueryError extends Error {}

interface Selection {
  name: string
  key: string
  hint?: string
  inner: boolean
  children?: Selection[]
}

interface ForeignKey {
  kind: 'foreign-key'
  name: string
  target: string
  columns: string[]
  referenced: string[]
}

interface ComputedRelation {
  kind: 'computed'
  name: string
  target: string
}

type Relation = ForeignKey | ComputedRelation

interface Node {
  table: string
  alias: string
  selections: Selection[]
  children: Map<string, { node: Node; relation: Relation; inner: boolean }>
  filters: Filter[]
}

interface Filter {
  column: string
  operator: string
  value: string
  negate: boolean
}

const operators: Record<string, string> = {
  eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE',
}

const quote = (value: string) => `"${validateIdentifier(value)}"`

function splitList(raw: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let escaped = false
  let start = 0
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '(') depth++
    else if (c === ')') {
      if (--depth < 0) throw new ReadQueryError('Unbalanced query parentheses')
    } else if (c === ',' && depth === 0) {
      parts.push(raw.slice(start, i).trim())
      start = i + 1
    }
  }
  if (depth !== 0 || quoted) throw new ReadQueryError('Unbalanced query expression')
  parts.push(raw.slice(start).trim())
  if (parts.some((part) => !part)) throw new ReadQueryError('Empty query term')
  return parts
}

function parseSelect(raw: string, depth = 0): Selection[] {
  if (depth > 16) throw new ReadQueryError('Select nesting exceeds 16 levels')
  const keys = new Set<string>()
  return splitList(raw).map((term) => {
    if (term === '*') {
      if (keys.has('*')) throw new ReadQueryError('Duplicate wildcard')
      keys.add('*')
      return { name: '*', key: '*', inner: false }
    }
    const open = term.indexOf('(')
    const head = open < 0 ? term : term.slice(0, open)
    const match = /^([A-Za-z_][A-Za-z0-9_]*:)?([A-Za-z_][A-Za-z0-9_]*)(![A-Za-z_][A-Za-z0-9_]*)?(!inner)?$/.exec(head)
    if (!match) throw new ReadQueryError(`Unsupported select term: ${term}`)
    const name = match[2]
    const key = match[1]?.slice(0, -1) ?? name
    if (keys.has(key)) throw new ReadQueryError(`Duplicate select key: ${key}`)
    keys.add(key)
    let hint: string | undefined = match[3]?.slice(1)
    const inner = hint === 'inner' || !!match[4]
    if (hint === 'inner') hint = undefined
    if (open < 0) {
      if (hint || inner) throw new ReadQueryError(`Relation modifier on scalar: ${term}`)
      return { name, key, inner: false }
    }
    if (!term.endsWith(')')) throw new ReadQueryError(`Malformed relation: ${term}`)
    return { name, key, hint, inner, children: parseSelect(term.slice(open + 1, -1), depth + 1) }
  })
}

function parseFilter(column: string, raw: string): Filter {
  validateIdentifier(column)
  const negate = raw.startsWith('not.')
  const expression = negate ? raw.slice(4) : raw
  const dot = expression.indexOf('.')
  const operator = expression.slice(0, dot)
  if (dot < 0 || !(Object.hasOwn(operators, operator) || operator === 'is' || operator === 'in')) {
    throw new ReadQueryError(`Unsupported filter: ${column}=${raw}`)
  }
  return { column, operator, value: expression.slice(dot + 1), negate }
}

function filterSql(filter: Filter, column: string, params: unknown[]): string {
  const bind = (value: unknown) => {
    params.push(value)
    return `$${params.length}`
  }
  let sql: string
  if (filter.operator === 'is') {
    if (!/^(null|true|false|unknown)$/i.test(filter.value)) throw new ReadQueryError(`Invalid is value: ${filter.value}`)
    sql = `${column} IS ${filter.value.toUpperCase()}`
  } else if (filter.operator === 'in') {
    if (!filter.value.startsWith('(') || !filter.value.endsWith(')')) throw new ReadQueryError('in requires a parenthesized list')
    const raw = filter.value.slice(1, -1)
    if (!raw) sql = 'FALSE'
    else {
      const values = splitList(raw).map((value) => {
        if (value.startsWith('"')) {
          if (!/^"(?:[^"\\]|\\.)*"$/.test(value)) throw new ReadQueryError('Invalid quoted in value')
          return value.slice(1, -1).replace(/\\(.)/g, '$1')
        }
        if (/[()"]/.test(value)) throw new ReadQueryError('Invalid in value')
        return value
      })
      sql = `${column} IN (${values.map(bind).join(', ')})`
    }
  } else {
    const value = filter.operator === 'like' || filter.operator === 'ilike' ? filter.value.replace(/\*/g, '%') : filter.value
    sql = `${column} ${operators[filter.operator]} ${bind(value)}`
  }
  return filter.negate ? `NOT (${sql})` : sql
}

const controls = new Set(['select', 'order', 'limit', 'offset'])

export function writeWhere(search: URLSearchParams, params: unknown[]): string {
  const clauses: string[] = []
  for (const [key, value] of search) {
    if (controls.has(key)) continue
    clauses.push(filterSql(parseFilter(key, value), quote(key), params))
  }
  return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
}

function pagination(search: URLSearchParams, key: string): number | null {
  const values = search.getAll(key)
  if (!values.length) return null
  const value = Number(values[0])
  if (values.length !== 1 || !/^\d+$/.test(values[0]) || !Number.isSafeInteger(value)) throw new ReadQueryError(`Invalid ${key}`)
  return value
}

export async function planRead(db: Queryable, table: string, search: URLSearchParams): Promise<{
  sql: string
  countSql: string
  params: unknown[]
  offset: number
}> {
  for (const key of ['select', 'order']) {
    if (search.getAll(key).length > 1) throw new ReadQueryError(`Duplicate ${key}`)
  }
  const metadata = new Map<string, Relation[]>()
  let nextAlias = 0
  async function resolve(table: string, selections: Selection[]): Promise<Node> {
    const node: Node = { table, alias: `r${nextAlias++}`, selections, children: new Map(), filters: [] }
    for (const selection of selections) {
      if (!selection.children) continue
      let relations = metadata.get(table)
      if (!relations) {
        const result = await db.query<ForeignKey>(`
          SELECT 'foreign-key' AS kind, c.conname AS name, target.relname AS target,
                 array_agg(source_col.attname::text ORDER BY cols.ordinality) AS columns,
                 array_agg(target_col.attname::text ORDER BY cols.ordinality) AS referenced
            FROM pg_catalog.pg_constraint c
            JOIN pg_catalog.pg_class source ON source.oid = c.conrelid
            JOIN pg_catalog.pg_namespace source_ns ON source_ns.oid = source.relnamespace
            JOIN pg_catalog.pg_class target ON target.oid = c.confrelid
            JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target.relnamespace
            CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS cols(source_num, target_num, ordinality)
            JOIN pg_catalog.pg_attribute source_col ON source_col.attrelid = source.oid AND source_col.attnum = cols.source_num
            JOIN pg_catalog.pg_attribute target_col ON target_col.attrelid = target.oid AND target_col.attnum = cols.target_num
           WHERE c.contype = 'f' AND source_ns.nspname = 'public' AND target_ns.nspname = 'public' AND source.relname = $1
           GROUP BY c.oid, c.conname, target.relname`, [table])
        const computed = await db.query<ComputedRelation>(`
          SELECT 'computed' AS kind, p.proname AS name, target.relname AS target
            FROM pg_catalog.pg_proc p
            JOIN pg_catalog.pg_namespace function_ns ON function_ns.oid = p.pronamespace
            JOIN pg_catalog.pg_class source ON source.reltype = p.proargtypes[0]
            JOIN pg_catalog.pg_namespace source_ns ON source_ns.oid = source.relnamespace
            JOIN pg_catalog.pg_class target ON target.reltype = p.prorettype
            JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target.relnamespace
           WHERE function_ns.nspname = 'public' AND source_ns.nspname = 'public'
             AND target_ns.nspname = 'public' AND source.relname = $1
             AND target.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND p.prokind = 'f' AND p.pronargs = 1 AND p.pronargdefaults = 0
             AND p.proargmodes IS NULL AND p.proretset AND p.prorows = 1
             AND p.provolatile IN ('s', 'i') AND NOT p.prosecdef`, [table])
        relations = [...result.rows, ...computed.rows]
        metadata.set(table, relations)
      }
      const computed = relations.filter((relation) => relation.kind === 'computed' && relation.name === selection.name && !selection.hint)
      const candidates = computed.length ? computed : relations.filter((fk) => {
        if (fk.kind !== 'foreign-key') return false
        const matches = fk.target === selection.name || fk.name === selection.name || (fk.columns.length === 1 && fk.columns[0] === selection.name)
        return matches && (!selection.hint || fk.name === selection.hint || (fk.columns.length === 1 && fk.columns[0] === selection.hint))
      })
      if (candidates.length !== 1) throw new ReadQueryError(`${candidates.length ? 'Ambiguous' : 'Unknown'} to-one relation: ${table}.${selection.name}`)
      const relation = candidates[0]
      node.children.set(selection.key, { node: await resolve(relation.target, selection.children), relation, inner: selection.inner })
    }
    return node
  }
  const root = await resolve(table, parseSelect(search.get('select') ?? '*'))
  for (const [key, value] of search) {
    if (controls.has(key)) continue
    const path = key.split('.')
    let node = root
    for (const part of path.slice(0, -1)) {
      validateIdentifier(part)
      const child = node.children.get(part)
      if (!child) throw new ReadQueryError(`Filter relation is not selected: ${key}`)
      node = child.node
    }
    node.filters.push(parseFilter(path[path.length - 1], value))
  }
  const params: unknown[] = []
  function compile(node: Node): { json: string; conditions: string[] } {
    const conditions = node.filters.map((filter) => filterSql(filter, `${quote(node.alias)}.${quote(filter.column)}`, params))
    const fields: string[] = []
    for (const selection of node.selections) {
      if (selection.name === '*') continue
      let value: string
      const child = node.children.get(selection.key)
      if (child) {
        const nested = compile(child.node)
        const relation = child.relation
        const join = relation.kind === 'foreign-key'
          ? relation.columns.map((col, i) => `${quote(child.node.alias)}.${quote(relation.referenced[i])} = ${quote(node.alias)}.${quote(col)}`)
          : []
        const source = relation.kind === 'computed'
          ? `public.${quote(relation.name)}(${quote(node.alias)}.*)`
          : `public.${quote(child.node.table)}`
        const predicates = [...join, ...nested.conditions]
        const from = `FROM ${source} AS ${quote(child.node.alias)}${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''}`
        value = `(SELECT ${nested.json} ${from})`
        if (child.inner) conditions.push(`EXISTS (SELECT 1 ${from})`)
      } else value = `${quote(node.alias)}.${quote(selection.name)}`
      fields.push(`'${selection.key}', ${value}`)
    }
    const base = node.selections.some((s) => s.name === '*') ? `to_jsonb(${quote(node.alias)})` : `'{}'::jsonb`
    return { json: fields.length ? `${base} || jsonb_build_object(${fields.join(', ')})` : base, conditions }
  }
  const compiled = compile(root)
  const from = `FROM public.${quote(root.table)} AS ${quote(root.alias)}`
  const where = compiled.conditions.length ? ` WHERE ${compiled.conditions.join(' AND ')}` : ''
  const base = `SELECT ${compiled.json} AS data ${from}${where}`
  const terms = search.get('order')
  const order = terms === null ? '' : ' ORDER BY ' + splitList(terms).map((term) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.(asc|desc))?(?:\.(nullsfirst|nullslast))?$/i.exec(term)
    if (!match) throw new ReadQueryError(`Unsupported order: ${term}`)
    return `${quote(root.alias)}.${quote(match[1])} ${(match[2] ?? 'asc').toUpperCase()}${match[3] ? (match[3].toLowerCase() === 'nullsfirst' ? ' NULLS FIRST' : ' NULLS LAST') : ''}`
  }).join(', ')
  const limit = pagination(search, 'limit')
  const offset = pagination(search, 'offset')
  return {
    sql: base + order + (limit === null ? '' : ` LIMIT ${limit}`) + (offset === null ? '' : ` OFFSET ${offset}`),
    countSql: `SELECT COUNT(*) AS count FROM (${base}) AS counted`, params, offset: offset ?? 0,
  }
}
