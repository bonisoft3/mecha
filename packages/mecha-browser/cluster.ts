// mecha's browser platform as one cluster behind one fetch handler, for the one
// user a single-file page has: PGlite runs the RLS bootstrap and the migrations,
// the user is minted at boot and every request is theirs, PostgREST answers
// /crud, and a shape server speaks Electric's protocol over a log the tables'
// triggers feed. Its bare imports are pinned in cluster.deno.json, which a
// bundler takes into its own map.
// Routes: /auth/guest, /auth/shape, /auth/whoami, /crud/*, /electric/v1/shape.
import type { PGlite } from '@electric-sql/pglite'
import { createRestHandler } from '@mecha/postgrest-js'
import { encodeBase64Url } from 'jsr:@std/encoding@1.0.7/base64url'
import { shapeWhere } from '../../services/auth/jwt.ts'
import { browserTier } from './fence.ts'

export interface ClusterConfig {
  db: PGlite
  /** rls.sql first, then the app's migrations in order. */
  sql: string[]
  /** Server tables that carry shapes. */
  tables: string[]
  /** Where a request's failure is written before it is answered as a 500. */
  log: (line: string) => void
}

export interface Cluster {
  handle: (req: Request) => Promise<Response>
}

/** Entries kept per table; a client further behind than this refetches. */
export const RETAINED = 1000

type Row = Record<string, unknown>
interface Entry { offset: number; message: unknown; scope: string | null }
interface Log {
  handle: string
  tail: number
  entries: Entry[]
  waiters: Set<() => void>
  schema: Record<string, { type: string; pk_index?: number; not_null?: boolean }>
  /** The primary key's columns, in the key's order. */
  pk: string[]
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// The shell reads a token's payload for the user it names, and nothing here
// checks a signature, so a token is its claims, unsigned.
const enc = new TextEncoder()
const token = (claims: Row) => `${encodeBase64Url(enc.encode('{"alg":"none","typ":"JWT"}'))}.${encodeBase64Url(enc.encode(JSON.stringify(claims)))}.`

const offsetOf = (n: number) => `${n}_0`
const parseOffset = (s: string) => (s === '-1' ? -1 : Number(s.split('_')[0]))
const ident = (s: string) => `"${s.replaceAll('"', '""')}"`
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`

export async function createCluster(cfg: ClusterConfig): Promise<Cluster> {
  const { db, log } = cfg
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
    logs.set(table, { handle: `${table}-${bootId}`, tail: 0, entries: [], waiters: new Set(), schema, pk })
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

  const rowMessage = (table: string, operation: string, row: Row, txid?: number) => {
    const l = logs.get(table)!
    const headers: Record<string, unknown> = { operation, relation: ['public', table] }
    const tx = txid ?? (operation !== 'delete' && row.txid != null ? Number(row.txid) : undefined)
    if (tx !== undefined) headers.txids = [tx]
    return { key: `"public"."${table}"/${l.pk.map((c) => `"${String(row[c])}"`).join('/')}`, value: row, headers }
  }

  // The row is read back by its key, in the order the notifications came; a
  // row already gone by then is left to the delete that follows it.
  await db.listen('shape', (payload: string) => {
    const { table, op, key, scope, txid } = JSON.parse(payload) as { table: string; op: string; key: Row; scope: string | null; txid: number }
    const l = logs.get(table)
    if (!l) return
    void serialize(async () => {
      let row = key
      if (op !== 'DELETE') {
        const where = l.pk.map((c, i) => `${ident(c)} = $${i + 1}`).join(' AND ')
        const r = await db.query<{ r: Row }>(`SELECT row_to_json(t) AS r FROM ${ident(table)} t WHERE ${where}`, l.pk.map((c) => key[c]))
        if (r.rows.length === 0) return
        row = r.rows[0].r
      }
      const operation = op === 'INSERT' ? 'insert' : op === 'UPDATE' ? 'update' : 'delete'
      const offset = ++l.tail
      const base = rowMessage(table, operation, row, Number(txid))
      const message = { ...base, headers: { ...base.headers, lsn: String(offset), op_position: 0, last: true } }
      l.entries.push({ offset, message, scope })
      if (l.entries.length > RETAINED) l.entries.splice(0, l.entries.length - RETAINED)
      for (const w of l.waiters) w()
      l.waiters.clear()
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
    const l = logs.get(table)
    if (!l) return json(400, { error: `${table} is not a shape table` })
    const reach = await serialize(scopes)
    const base: Record<string, string> = { 'electric-handle': l.handle, 'cache-control': 'no-store', 'content-type': 'application/json' }

    if (offset === '-1') {
      const rows = await serialize(() => db.query<{ r: Row }>(`SELECT row_to_json(t) AS r FROM ${ident(table)} t WHERE ${shapeWhere(reach)}`))
      const msgs: unknown[] = rows.rows.map((x) => rowMessage(table, 'insert', x.r))
      msgs.push({ headers: { control: 'up-to-date', global_last_seen_lsn: String(l.tail) } })
      return new Response(JSON.stringify(msgs), {
        headers: { ...base, 'electric-offset': offsetOf(l.tail), 'electric-schema': JSON.stringify(l.schema), 'electric-up-to-date': 'true' },
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
    const pending = () => l.entries.filter((e) => e.offset > after && e.scope !== null && reach.includes(e.scope))
    let entries = pending()
    if (entries.length === 0 && live) {
      await waitFor(l, 20_000, req.signal)
      entries = pending()
    }
    const headers: Record<string, string> = {
      ...base,
      'electric-offset': offsetOf(entries.length ? entries[entries.length - 1].offset : l.tail),
      'electric-cursor': String(Date.now()),
      'electric-up-to-date': 'true',
    }
    if (!live) headers['electric-schema'] = JSON.stringify(l.schema)
    if (entries.length === 0) return new Response(null, { status: 204, headers })
    const msgs: unknown[] = entries.map((e) => e.message)
    msgs.push({ headers: { control: 'up-to-date', global_last_seen_lsn: String(l.tail) } })
    return new Response(JSON.stringify(msgs), { headers })
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
