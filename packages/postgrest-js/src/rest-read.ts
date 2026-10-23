import type { PGlite } from '@electric-sql/pglite'
import { validateIdentifier } from './validate.js'

type Queryable = Pick<PGlite, 'query'>

export type ReadSchema = Record<string, { fields?: { name: string; ref?: string }[] }>

export class ReadQueryError extends Error {}

type Aggregate = 'sum' | 'avg' | 'min' | 'max' | 'count'

interface Selection {
  name: string
  key: string
  hint?: string
  inner: boolean
  children?: Selection[]
  aggregate?: Aggregate
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

export interface MetadataCache {
  tables: Set<string>
  relations: Map<string, Relation[]>
  asJson: Map<string, Map<string, (p: string) => string>>
}

const caches = new WeakMap<object, MetadataCache>()
const DDL_STATEMENT = /\b(?:CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i

export function clearMetadataCache(cache: MetadataCache): void {
  cache.tables.clear()
  cache.relations.clear()
  cache.asJson.clear()
}

function hookDdlInvalidation(
  target: { exec?: (...args: unknown[]) => unknown; query?: (...args: unknown[]) => unknown; transaction?: (fn: (tx: unknown) => unknown) => unknown },
  cache: MetadataCache,
): void {
  if (typeof target.exec === 'function') {
    const origExec = target.exec.bind(target)
    target.exec = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && DDL_STATEMENT.test(args[0])) clearMetadataCache(cache)
      return origExec(...args)
    }
  }
  if (typeof target.query === 'function') {
    const origQuery = target.query.bind(target)
    target.query = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && DDL_STATEMENT.test(args[0])) clearMetadataCache(cache)
      return origQuery(...args)
    }
  }
  if (typeof target.transaction === 'function') {
    const origTx = target.transaction.bind(target)
    target.transaction = (fn: (tx: unknown) => unknown) =>
      origTx((tx: unknown) => {
        if (tx && typeof tx === 'object') hookDdlInvalidation(tx as typeof target, cache)
        return fn(tx)
      })
  }
}

export function metadataCache(owner: object): MetadataCache {
  let cache = caches.get(owner)
  if (!cache) {
    cache = { tables: new Set(), relations: new Map(), asJson: new Map() }
    caches.set(owner, cache)
    hookDdlInvalidation(owner as { exec?: (...args: unknown[]) => unknown; query?: (...args: unknown[]) => unknown; transaction?: (fn: (tx: unknown) => unknown) => unknown }, cache)
  }
  return cache
}

async function queryRelations(db: Queryable, table: string, refs: Record<string, string | undefined>): Promise<Relation[]> {
  // Views have no pg_constraint rows. Their app-declared references still
  // join under the caller's role, against the target's actual primary key.
  const hasRefs = Object.keys(refs).length > 0
  const declaredSql = hasRefs ? `
    UNION ALL
    SELECT 'foreign-key' AS kind, ref.key AS name, target.relname AS target,
           ARRAY[source_col.attname::text] AS columns, ARRAY[target_col.attname::text] AS referenced
      FROM pg_catalog.pg_class source
      JOIN pg_catalog.pg_namespace source_ns ON source_ns.oid = source.relnamespace
      CROSS JOIN jsonb_each_text($2::jsonb) ref
      JOIN pg_catalog.pg_attribute source_col ON source_col.attrelid = source.oid
        AND source_col.attname = ref.key AND NOT source_col.attisdropped
      JOIN pg_catalog.pg_class target ON target.relname = ref.value
      JOIN pg_catalog.pg_namespace target_ns ON target_ns.oid = target.relnamespace
      JOIN pg_catalog.pg_constraint pk ON pk.conrelid = target.oid AND pk.contype = 'p' AND cardinality(pk.conkey) = 1
      JOIN pg_catalog.pg_attribute target_col ON target_col.attrelid = target.oid AND target_col.attnum = pk.conkey[1]
     WHERE source_ns.nspname = 'public' AND target_ns.nspname = 'public'
       AND source.relname = $1 AND source.relkind IN ('v', 'm')` : ''
  const result = await db.query<Relation>(`
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
     GROUP BY c.oid, c.conname, target.relname${declaredSql}
    UNION ALL
    SELECT 'computed' AS kind, p.proname AS name, target.relname AS target,
           NULL::text[] AS columns, NULL::text[] AS referenced
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
       AND p.provolatile IN ('s', 'i') AND NOT p.prosecdef`, hasRefs ? [table, JSON.stringify(refs)] : [table])
  return result.rows
}

function matchRelation(relations: Relation[], selection: Selection): Relation[] {
  const computed = relations.filter((relation) => relation.kind === 'computed' && relation.name === selection.name && !selection.hint)
  return computed.length ? computed : relations.filter((fk) => {
    if (fk.kind !== 'foreign-key') return false
    const matches = fk.target === selection.name || fk.name === selection.name || (fk.columns.length === 1 && fk.columns[0] === selection.name)
    return matches && (!selection.hint || fk.name === selection.hint || (fk.columns.length === 1 && fk.columns[0] === selection.hint))
  })
}

interface Node {
  table: string
  alias: string
  selections: Selection[]
  children: Map<string, { node: Node; relation: Relation; inner: boolean }>
  filters: Filter[]
}

type Comparison = {
  column: string
  operator: string
  value: string
  negate: boolean
}
/** PostgREST's `or=(a.eq.1,b.is.null)` and `and=(…)`, one level deep: the
 * ticker's monotonic watermark guard, which the edge clock sends here. */
type Logical = { logical: 'or' | 'and'; terms: Comparison[] }
type Filter = Comparison | Logical
const logicals = new Set(['or', 'and'])

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
  const selections = splitList(raw).map((term): Selection => {
    if (term === '*') {
      if (keys.has('*')) throw new ReadQueryError('Duplicate wildcard')
      keys.add('*')
      return { name: '*', key: '*', inner: false }
    }
    const aggregate = /^(?:([A-Za-z_][A-Za-z0-9_]*):)?(?:([A-Za-z_][A-Za-z0-9_]*)\.(sum|avg|min|max|count)|count)\(\)$/.exec(term)
    if (aggregate) {
      if (depth !== 0) throw new ReadQueryError('Embedded aggregates are unsupported')
      const operation = (aggregate[3] ?? 'count') as Aggregate
      const key = aggregate[1] ?? operation
      if (keys.has(key)) throw new ReadQueryError(`Duplicate select key: ${key}`)
      keys.add(key)
      return { name: aggregate[2] ?? '*', key, inner: false, aggregate: operation }
    }
    if (/^(?:[A-Za-z_][A-Za-z0-9_]*:)?\*\./.test(term)) throw new ReadQueryError('Wildcard aggregates are unsupported')
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
  if (selections.some((selection) => selection.aggregate)) {
    if (selections.some((selection) => selection.name === '*' && !selection.aggregate)) throw new ReadQueryError('Wildcard selection with aggregates is unsupported')
    if (selections.some((selection) => selection.children)) throw new ReadQueryError('Embedded resources with aggregates are unsupported')
  }
  return selections
}

function parseLogical(op: string, raw: string): Logical {
  if (!raw.startsWith('(') || !raw.endsWith(')')) throw new ReadQueryError(`${op} requires a parenthesized list`)
  const terms = splitList(raw.slice(1, -1)).map((term) => {
    const dot = term.indexOf('.')
    if (dot < 0 || /^(not\.)?(and|or)\(/.test(term)) throw new ReadQueryError(`Unsupported ${op} term: ${term}`)
    return parseFilter(term.slice(0, dot), term.slice(dot + 1))
  })
  return { logical: op as 'or' | 'and', terms }
}

function parseFilter(column: string, raw: string): Comparison {
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

function filterSql(filter: Filter, qualify: (column: string) => string, params: unknown[]): string {
  if ('logical' in filter) return `(${filter.terms.map((term) => filterSql(term, qualify, params)).join(filter.logical === 'or' ? ' OR ' : ' AND ')})`
  const column = qualify(filter.column)
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
  } else if (!filter.negate && (filter.operator === 'like' || filter.operator === 'ilike') && /^[*%]+$/.test(filter.value)) {
    // Unentered search inputs bind `*` into `like.*{q}*` / `ilike.*{q}*`; bound as
    // a parameter, they pull joins off their ordered index scan.
    sql = `${column} IS NOT NULL`
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
    clauses.push(filterSql(logicals.has(key) ? parseLogical(key, value) : parseFilter(key, value), quote, params))
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

export async function planRead(db: Queryable, table: string, search: URLSearchParams, schema?: ReadSchema, cacheOwner: object = db): Promise<{
  sql: string
  countSql: string
  params: unknown[]
  offset: number
  tables: string[]
  computed: boolean
}> {
  for (const key of ['select', 'order']) {
    if (search.getAll(key).length > 1) throw new ReadQueryError(`Duplicate ${key}`)
  }
  const cache = metadataCache(cacheOwner)
  const metadata = new Map<string, Relation[]>()
  const tables = new Set<string>()
  let hasComputed = false
  let nextAlias = 0
  async function resolve(table: string, selections: Selection[]): Promise<Node> {
    tables.add(table)
    const node: Node = { table, alias: `r${nextAlias++}`, selections, children: new Map(), filters: [] }
    for (const selection of selections) {
      if (!selection.children) continue
      const refs = Object.fromEntries((schema?.[table]?.fields ?? []).filter(field => field.ref).map(field => [field.name, field.ref]))
      const cacheKey = `${table}\0${JSON.stringify(refs)}`
      let relations = metadata.get(table) ?? cache.relations.get(cacheKey)
      if (!relations) {
        relations = await queryRelations(db, table, refs)
        metadata.set(table, relations)
      }
      const candidates = matchRelation(relations, selection)
      if (candidates.length !== 1) {
        throw new ReadQueryError(`${candidates.length ? 'Ambiguous' : 'Unknown'} to-one relation: ${table}.${selection.name}`)
      }
      cache.relations.set(cacheKey, relations)
      const relation = candidates[0]
      if (relation.kind === 'computed') hasComputed = true
      node.children.set(selection.key, { node: await resolve(relation.target, selection.children), relation, inner: selection.inner })
    }
    return node
  }
  const root = await resolve(table, parseSelect(search.get('select') ?? '*'))
  for (const [key, value] of search) {
    if (controls.has(key)) continue
    if (logicals.has(key)) {
      root.filters.push(parseLogical(key, value))
      continue
    }
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
    const conditions = node.filters.map((filter) => filterSql(filter, (column) => `${quote(node.alias)}.${quote(column)}`, params))
    const fields: string[] = []
    for (const selection of node.selections) {
      if (selection.name === '*' && !selection.aggregate) continue
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
      } else if (selection.aggregate) {
        const column = selection.name === '*' ? '*' : `${quote(node.alias)}.${quote(selection.name)}`
        value = `${selection.aggregate.toUpperCase()}(${column})`
      } else value = `${quote(node.alias)}.${quote(selection.name)}`
      fields.push(`'${selection.key}', ${value}`)
    }
    const base = node.selections.some((s) => s.name === '*' && !s.aggregate) ? `to_jsonb(${quote(node.alias)})` : `'{}'::jsonb`
    return { json: fields.length ? `${base} || jsonb_build_object(${fields.join(', ')})` : base, conditions }
  }
  const compiled = compile(root)
  const from = `FROM public.${quote(root.table)} AS ${quote(root.alias)}`
  const where = compiled.conditions.length ? ` WHERE ${compiled.conditions.join(' AND ')}` : ''
  const aggregated = root.selections.some((selection) => selection.aggregate)
  const grouped = new Set(root.selections.filter((selection) => !selection.aggregate).map((selection) => selection.name))
  const group = aggregated && grouped.size ? ` GROUP BY ${[...grouped].map((column) => `${quote(root.alias)}.${quote(column)}`).join(', ')}` : ''
  const base = `SELECT ${compiled.json} AS data ${from}${where}${group}`
  const terms = search.get('order')
  const order = terms === null ? '' : ' ORDER BY ' + splitList(terms).map((term) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.(asc|desc))?(?:\.(nullsfirst|nullslast))?$/i.exec(term)
    if (!match) throw new ReadQueryError(`Unsupported order: ${term}`)
    if (aggregated && !grouped.has(match[1])) throw new ReadQueryError(`Aggregate ordering requires a grouped column: ${term}`)
    return `${quote(root.alias)}.${quote(match[1])} ${(match[2] ?? 'asc').toUpperCase()}${match[3] ? (match[3].toLowerCase() === 'nullsfirst' ? ' NULLS FIRST' : ' NULLS LAST') : ''}`
  }).join(', ')
  const limit = pagination(search, 'limit')
  const offset = pagination(search, 'offset')
  return {
    sql: base + order + (limit === null ? '' : ` LIMIT ${limit}`) + (offset === null ? '' : ` OFFSET ${offset}`),
    countSql: `SELECT COUNT(*) AS count FROM (${base}) AS counted`, params, offset: offset ?? 0,
    tables: [...tables], computed: hasComputed,
  }
}
