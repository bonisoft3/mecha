// mecha's browser platform as one cluster behind one fetch handler, for the one
// user a single-file page has: PGlite runs the RLS bootstrap and the migrations,
// the user is minted at boot and every request is theirs, PostgREST answers
// /crud, and a shape server speaks Electric's protocol over a log the tables'
// triggers feed. Its bare imports are pinned in cluster.deno.json, which a
// bundler takes into its own map.
// Routes: /auth/guest, /auth/shape, /auth/whoami, /crud/*, /electric/v1/shape.
// A shape is served whole from offset -1, or from `offset=now` with only the
// changes after it, and then by subset snapshots its client asks for: what the
// stack's Electric answers a collection synced on demand.
import type { PGlite } from '@electric-sql/pglite'
import { createRestHandler } from '@mecha/postgrest-js'
import { encodeBase64Url } from 'jsr:@std/encoding@1.0.7/base64url'
import {
  isSubsetWhere,
  SHAPE_FIXED_PARAMS,
  shapeWhere,
  SUBSET_LIMIT,
  SUBSET_ORDER,
  SUBSET_PARAMS,
  subsetParams,
  subsetPositions,
} from '../../services/auth/jwt.ts'
import { browserTier } from './fence.ts'

export interface ClusterConfig {
  db: PGlite
  /** rls.sql first, then the app's migrations in order. */
  sql: string[]
  /** Server tables that carry shapes. */
  tables: string[]
  schema?: Record<string, { durability?: string }>
  /** Where a request's failure is written before it is answered as a 500. */
  log: (line: string) => void
  /** Where a failure no request can answer is raised: a change whose row
   * could not be read back, after which every read of its table is a 410. */
  fail: (error: Error) => void
}

export interface Cluster {
  handle: (req: Request) => Promise<Response>
}

/** Entries kept per table; a client further behind than this refetches. */
export const RETAINED = 1000

type Row = Record<string, unknown>
/** A change, numbered when its notification arrives and filled once its row
 * is read back; `message` is null until then. */
interface Entry { offset: number; message: unknown | null; scope: string | null }
interface Log {
  handle: string
  tail: number
  /** The last offset every entry up to which is filled: how far a client may
   * read the log, and the position a response reports. Entries fill in the
   * order they were numbered, through the one serialized connection, so the
   * `tail - filled` newest are the unfilled ones. */
  filled: number
  entries: Entry[]
  waiters: Set<() => void>
  schema: Record<string, { type: string; pk_index?: number; not_null?: boolean }>
  /** The primary key's columns, in the key's order. */
  pk: string[]
  /** Why a change could not be filled: the log holds a hole no read can step
   * over, so every read of the table is refused until the page reloads. */
  broken?: Error
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** A subset refused as Electric refuses one, a 400 whose `errors.subset` names
 * the parameter: the store takes it for a predicate the program stated wrong,
 * and any other 4xx for one a retry may answer. */
const refuse = (param: string, message: string) => json(400, { message: 'Invalid request', errors: { subset: { [param]: [message] } } })

// The shell reads a token's payload for the user it names, and nothing here
// checks a signature, so a token is its claims, unsigned.
const enc = new TextEncoder()
const token = (claims: Row) => `${encodeBase64Url(enc.encode('{"alg":"none","typ":"JWT"}'))}.${encodeBase64Url(enc.encode(JSON.stringify(claims)))}.`

const offsetOf = (n: number) => `${n}_0`

// A subset is spliced into SQL run as PGlite's superuser, so what reaches the
// splice is the grammar the stack's gate admits (jwt.ts): Electric refuses the
// rest itself, and here the grammar has to, or a parenthesis closed early would
// OR a predicate onto the shape's reach, and a subquery or a function would
// read any table.
const parseOffset = (s: string) => (s === '-1' ? -1 : Number(s.split('_')[0]))
const ident = (s: string) => `"${s.replaceAll('"', '""')}"`
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`

export async function createCluster(cfg: ClusterConfig): Promise<Cluster> {
  const { db, log, fail } = cfg
  for (const sql of cfg.sql) await db.exec(browserTier(sql))

  // PGlite is one connection: requests are serialised so no two interleave,
  // and the user's claims are set once, session-wide, for RLS to read.
  let chain: Promise<unknown> = Promise.resolve()
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn)
    chain = p.catch(() => {})
    return p
  }
  const id = crypto.randomUUID()
  const user = { id, handle: `guest-${id.slice(0, 8)}`, guest: true }
  await db.query('INSERT INTO app_user (id, handle) VALUES ($1, $2)', [user.id, user.handle])
  await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: user.id, role: 'app_user', guest: user.guest })])
  const scopes = async () => (await db.query<{ s: string[] }>('SELECT subject_scopes($1) AS s', [user.id])).rows[0].s

  const logs = new Map<string, Log>()
  const bootId = crypto.randomUUID().slice(0, 8)
  for (const table of cfg.tables) {
    // Physical server tables can invalidate live joins. A request-only view
    // has no independent changes, primary key, or notification trigger.
    if (cfg.schema?.[table]?.durability === 'server') {
      const relation = await db.query<{ relkind: string }>(
        'SELECT relkind FROM pg_class WHERE oid = $1::regclass', [table],
      )
      if (relation.rows[0]?.relkind === 'v') continue
    }
    const cols = await db.query<{ column_name: string; udt_name: string; is_nullable: string }>(
      `SELECT column_name, udt_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table],
    )
    const pks = await db.query<{ attname: string }>(
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`,
      [table],
    )
    // A shape keys every row by its primary key; a table without one has no
    // rows a client could tell apart.
    if (pks.rows.length === 0) throw new Error(`${table} carries a shape and has no primary key`)
    const pk = pks.rows.map((p) => p.attname)
    const schema: Log['schema'] = {}
    for (const c of cols.rows) {
      const at = pk.indexOf(c.column_name)
      schema[c.column_name] = { type: c.udt_name, ...(at >= 0 ? { pk_index: at } : {}), ...(c.is_nullable === 'NO' ? { not_null: true } : {}) }
    }
    logs.set(table, { handle: `${table}-${bootId}`, tail: 0, filled: 0, entries: [], waiters: new Set(), schema, pk })
  }

  // The notification carries the key and the scope, not the row: pg_notify
  // caps a payload at eight kilobytes and a row need not fit. The transaction's
  // own id rides along, since a deleted row's column holds the transaction that
  // last wrote it and the client confirms a delete by the one that removed it.
  await db.exec(`CREATE OR REPLACE FUNCTION shape_notify() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE r jsonb; k jsonb := '{}'::jsonb; c text;
    BEGIN
      IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
      FOREACH c IN ARRAY TG_ARGV LOOP k := k || jsonb_build_object(c, r -> c); END LOOP;
      PERFORM pg_notify('shape', json_build_object('table', TG_TABLE_NAME, 'op', TG_OP, 'key', k, 'scope', r -> 'scope_id', 'txid', txid_current())::text);
      RETURN NULL;
    END $$;`)
  for (const [table, l] of logs) {
    await db.exec(`DROP TRIGGER IF EXISTS shape_notify ON ${ident(table)};
      CREATE TRIGGER shape_notify AFTER INSERT OR UPDATE OR DELETE ON ${ident(table)} FOR EACH ROW EXECUTE FUNCTION shape_notify(${l.pk.map(literal).join(', ')});`)
  }

  // A row as Electric sends it: each value Postgres's text for it, which the
  // client parses by the column's type.
  const asText = (table: string) => {
    const cols = Object.keys(logs.get(table)!.schema)
    return `json_object(ARRAY[${cols.map(literal).join(', ')}]::text[], ARRAY[${cols.map((c) => `t.${ident(c)}::text`).join(', ')}]::text[])`
  }

  /** `txid` is the change's transaction, or null for a row no change carries
   * (a snapshot's, which a client would judge as a change it already holds);
   * left out, it is the row's own. */
  const rowMessage = (table: string, operation: string, row: Row, txid?: number | null) => {
    const l = logs.get(table)!
    const headers: Record<string, unknown> = { operation, relation: ['public', table] }
    const tx = txid === undefined ? (operation !== 'delete' && row.txid != null ? Number(row.txid) : undefined) : txid ?? undefined
    if (tx !== undefined) headers.txids = [tx]
    return { key: `"public"."${table}"/${l.pk.map((c) => `"${String(row[c])}"`).join('/')}`, value: row, headers }
  }

  // A change is numbered as its notification arrives, which is before any
  // request queued after the write runs: a subset snapshot taken then counts it
  // as seen. Its row is read back by its key, in the order the notifications
  // came; a row already gone by then is left to the delete that follows it.
  await db.listen('shape', (payload: string) => {
    const { table, op, key, scope, txid } = JSON.parse(payload) as { table: string; op: string; key: Row; scope: string | null; txid: number }
    const l = logs.get(table)
    if (!l) return
    const entry: Entry = { offset: ++l.tail, message: null, scope }
    l.entries.push(entry)
    serialize(async () => {
      let row: Row = Object.fromEntries(Object.entries(key).map(([c, v]) => [c, v === null ? null : String(v)]))
      if (op !== 'DELETE') {
        const where = l.pk.map((c, i) => `${ident(c)} = $${i + 1}`).join(' AND ')
        const r = await db.query<{ r: Row }>(`SELECT ${asText(table)} AS r FROM ${ident(table)} t WHERE ${where}`, l.pk.map((c) => key[c]))
        if (r.rows.length === 0) {
          l.entries.splice(l.entries.length - (l.tail - l.filled), 1)
          l.filled = entry.offset
          for (const w of l.waiters) w()
          l.waiters.clear()
          return
        }
        row = r.rows[0].r
      }
      const operation = op === 'INSERT' ? 'insert' : op === 'UPDATE' ? 'update' : 'delete'
      const base = rowMessage(table, operation, row, Number(txid))
      entry.message = { ...base, headers: { ...base.headers, lsn: String(entry.offset), op_position: 0, last: true } }
      l.filled = entry.offset
      const trim = l.entries.length - (l.tail - l.filled) - RETAINED
      if (trim > 0) l.entries.splice(0, trim)
      for (const w of l.waiters) w()
      l.waiters.clear()
    }).catch((e) => {
      const first = l.broken === undefined
      l.broken ??= e instanceof Error ? e : new Error(String(e))
      for (const w of l.waiters) w()
      l.waiters.clear()
      if (first) fail(new Error(`cluster lost a change to ${table}: ${l.broken.message}`, { cause: l.broken }))
    })
  })

  const rest = createRestHandler(db, { role: 'app_user', scopes })
  async function crud(req: Request): Promise<Response> {
    const u = new URL(req.url)
    u.pathname = u.pathname.replace(/^\/crud/, '')
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer()
    const inner = new Request(u, { method: req.method, headers: req.headers, body })
    return serialize(() => rest(inner))
  }

  // The shell asks for a guest and later for a shape token: the one user
  // answers both, and a shape's predicate is what their scopes reach now.
  const session = () => json(200, { token: token({ sub: user.id, handle: user.handle, guest: user.guest }), user })
  async function shapeToken(req: Request): Promise<Response> {
    const body = (await req.json()) as { table?: string; key?: unknown }
    if (!body.table || !logs.has(body.table)) return json(400, { error: 'table required' })
    if (body.key !== undefined) return json(400, { error: 'keyed shapes are not served here' })
    const where = shapeWhere(await serialize(scopes))
    // The client caches a shape token until expires_in; nothing here expires.
    return json(200, { token: token({ typ: 'shape', table: body.table, where }), table: body.table, where, expires_in: 86_400 })
  }

  /** Until the log moves, the time runs out, or the request is abandoned. */
  function waitFor(l: Log, ms: number, signal: AbortSignal | null): Promise<void> {
    if (signal?.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); l.waiters.delete(done); signal?.removeEventListener('abort', done); resolve() }
      const t = setTimeout(done, ms)
      l.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  async function shape(req: Request): Promise<Response> {
    const p = new URL(req.url).searchParams
    const table = p.get('table') ?? ''
    const offset = p.get('offset') ?? '-1'
    const handle = p.get('handle')
    const live = p.get('live') === 'true'
    const changesOnly = p.get('log') === 'changes_only'
    const l = logs.get(table)
    if (!l) return json(400, { error: `${table} is not a shape table` })
    // A 410, which Electric's client does not retry as it does a 500: its
    // stream stops, and a subset's read fails.
    const lost = () => l.broken && json(410, { error: `${table}'s log lost a change whose row could not be read back: ${l.broken.message}` })
    const gone = lost()
    if (gone) return gone
    // Every update here carries its whole row, which is what `full` asks for.
    for (const [k, v] of Object.entries(SHAPE_FIXED_PARAMS)) {
      if (p.has(k) && p.get(k) !== v) return json(400, { error: `${k}=${p.get(k)} is not served here` })
    }
    const subset = [...p.keys()].filter((k) => k.startsWith('subset__'))
    const unknown = subset.find((k) => !SUBSET_PARAMS.has(k))
    if (unknown !== undefined) return refuse(unknown.slice('subset__'.length), `${unknown} is not served here`)
    // Electric reads a repeated parameter's last value and the stack's gate
    // refuses it, so neither is read at its first here.
    const repeated = subset.find((k, i) => subset.indexOf(k) !== i)
    if (repeated !== undefined) return refuse(repeated.slice('subset__'.length), `${repeated} repeated`)
    const reach = await serialize(scopes)
    const base: Record<string, string> = { 'electric-handle': l.handle, 'cache-control': 'no-store', 'content-type': 'application/json' }
    const upToDate = () => ({ headers: { control: 'up-to-date', global_last_seen_lsn: String(l.filled) } })

    if (subset.length > 0) return await snapshot(table, l, p, reach, base)
    // From now, or from the start with no snapshot: no rows, only the position.
    if (offset === 'now' || (offset === '-1' && changesOnly)) {
      return new Response(JSON.stringify([upToDate()]), {
        headers: { ...base, 'electric-offset': offsetOf(l.filled), 'electric-schema': JSON.stringify(l.schema), 'electric-up-to-date': 'true' },
      })
    }
    if (offset === '-1') {
      const rows = await serialize(() => db.query<{ r: Row }>(`SELECT ${asText(table)} AS r FROM ${ident(table)} t WHERE ${shapeWhere(reach)}`))
      const msgs: unknown[] = rows.rows.map((x) => rowMessage(table, 'insert', x.r))
      msgs.push(upToDate())
      return new Response(JSON.stringify(msgs), {
        headers: { ...base, 'electric-offset': offsetOf(l.filled), 'electric-schema': JSON.stringify(l.schema), 'electric-up-to-date': 'true' },
      })
    }
    const after = parseOffset(offset)
    // A client behind the retained window has missed entries nothing can
    // replay; it starts over from a snapshot.
    const oldest = l.entries.length ? l.entries[0].offset : l.tail + 1
    if (handle !== l.handle || after < oldest - 1) {
      return new Response(JSON.stringify([{ headers: { control: 'must-refetch' } }]), { status: 409, headers: base })
    }
    // The snapshot's predicate names scopes, so a row in none is in no shape.
    const pending = () => {
      const upTo = l.filled
      return l.entries.filter((e) => e.offset > after && e.offset <= upTo && e.scope !== null && reach.includes(e.scope))
    }
    let entries = pending()
    if (entries.length === 0 && live) {
      await waitFor(l, 20_000, req.signal)
      const gone = lost()
      if (gone) return gone
      entries = pending()
    }
    const headers: Record<string, string> = {
      ...base,
      'electric-offset': offsetOf(entries.length ? entries[entries.length - 1].offset : l.filled),
      'electric-cursor': String(Date.now()),
      'electric-up-to-date': 'true',
    }
    if (!live) headers['electric-schema'] = JSON.stringify(l.schema)
    if (entries.length === 0) return new Response(null, { status: 204, headers })
    const msgs: unknown[] = entries.map((e) => e.message)
    msgs.push(upToDate())
    return new Response(JSON.stringify(msgs), { headers })
  }

  // A subset is the shape's rows its predicate also admits, read with the
  // visibility a client needs to merge it with the log: Postgres's snapshot,
  // whose transactions a change's txid is judged against, and the first log
  // position not in it: the client retires a snapshot when a change at its
  // `database_lsn` arrives, before judging that change against it.
  let marks = 0
  async function snapshot(table: string, l: Log, p: URLSearchParams, reach: string[], base: Record<string, string>): Promise<Response> {
    const bound = subsetParams(p.get('subset__params'))
    if (bound === undefined) return refuse('params', `subset__params=${p.get('subset__params')} is not an object of positions to strings`)
    const where = p.get('subset__where')
    const order = p.get('subset__order_by')
    const limit = p.get('subset__limit')
    if (limit !== null && !SUBSET_LIMIT.test(limit)) return refuse('limit', `subset__limit=${limit} is not a count`)
    if (where !== null && !isSubsetWhere(where)) return refuse('where', `subset__where=${where} is not a predicate a subset may state`)
    // Bound by position: the client leaves out a null it compiled, so $n is
    // the n-th value, and a position it skipped binds null.
    const arity = Math.max(0, ...subsetPositions(where ?? ''))
    const stray = [...bound.keys()].find((n) => n > arity)
    if (stray !== undefined) return refuse('params', `subset__params binds $${stray}, which subset__where does not use`)
    const params = Array.from({ length: arity }, (_, i) => bound.get(i + 1) ?? null)
    if (order !== null && !SUBSET_ORDER.test(order)) return refuse('order_by', `subset__order_by=${order} is not a list of columns`)
    // The client moves its stream to the position a subset answers, so the
    // position is the requester's own: one past it would skip the changes in
    // between to rows outside the subset. Only a stream with no position yet
    // takes the snapshot's.
    const from = p.get('offset')
    const own = from === null || from === 'now' || from === '-1' ? null : from
    if (own !== null && !/^[0-9]+_0$/.test(own)) return refuse('offset', `offset=${own} is not a position`)
    const sql = `SELECT ${asText(table)} AS r FROM ${ident(table)} t WHERE (${shapeWhere(reach)})` +
      (where === null ? '' : ` AND (${where})`) + (order === null ? '' : ` ORDER BY ${order}`) + (limit === null ? '' : ` LIMIT ${limit}`)
    const read = await serialize(async () => {
      const seen = (await db.query<{ xmin: string; xmax: string; xip: string[] }>(
        'SELECT pg_snapshot_xmin(s)::text AS xmin, pg_snapshot_xmax(s)::text AS xmax, ARRAY(SELECT pg_snapshot_xip(s)::text) AS xip FROM pg_current_snapshot() s',
      )).rows[0]
      // A predicate Postgres refuses (a column it lacks, a literal its column
      // cannot hold) is the client's error; a 500 would be retried as the
      // server's. Any other failure is the server's.
      try {
        return { rows: (await db.query<{ r: Row }>(sql, params)).rows, seen: { ...seen, lsn: l.tail } }
      } catch (e) {
        const code = (e as { code?: unknown }).code
        if (typeof code === 'string' && /^(42|22)/.test(code)) return { refused: (e as Error).message }
        throw e
      }
    })
    if (read.refused !== undefined) return refuse('where', read.refused)
    const { rows, seen } = read
    const mark = ++marks
    const metadata = { xmin: seen.xmin, xmax: seen.xmax, xip_list: seen.xip, snapshot_mark: mark, database_lsn: String(seen.lsn + 1) }
    const data = rows.map((x) => {
      const m = rowMessage(table, 'insert', x.r, null)
      m.headers.snapshot_mark = mark
      return m
    })
    return new Response(JSON.stringify({ metadata, data }), {
      headers: { ...base, 'electric-offset': own ?? offsetOf(l.filled), 'electric-schema': JSON.stringify(l.schema) },
    })
  }

  async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    try {
      if (req.method === 'POST' && path === '/auth/guest') return session()
      if (req.method === 'POST' && path === '/auth/shape') return await shapeToken(req)
      if (req.method === 'GET' && path === '/auth/whoami') return json(200, user)
      if (path.startsWith('/crud/')) return await crud(req)
      if (path === '/electric/v1/shape') return await shape(req)
      return json(404, { error: `no route for ${path}` })
    } catch (e) {
      log(`cluster error on ${req.method} ${path}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      return json(500, { error: e instanceof Error ? e.message : String(e) })
    }
  }

  return { handle }
}
