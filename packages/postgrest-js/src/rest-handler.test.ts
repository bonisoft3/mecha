import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { createRestHandler, applyScopeSession } from './rest-handler.js'

describe('createRestHandler', () => {
  let db: PGlite
  let handler: (req: Request) => Promise<Response>

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`
      CREATE TABLE "hello" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "message" TEXT NOT NULL
      )
    `)
    handler = createRestHandler(db)
  })

  afterAll(async () => {
    await db.close()
  })

  it('handles POST (insert)', async () => {
    const req = new Request('http://localhost/hello', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ id: '1', message: 'test' }),
    })
    const res = await handler(req)
    expect(res.status).toBe(201)

    const body = await res.json()
    expect(body[0].id).toBe('1')
    expect(body[0].message).toBe('test')
  })

  it('handles POST with ignore-duplicates', async () => {
    const req = new Request('http://localhost/hello', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'return=representation,resolution=ignore-duplicates',
      },
      body: JSON.stringify({ id: '1', message: 'duplicate' }),
    })
    const res = await handler(req)
    // Should not error — duplicate silently absorbed
    expect(res.status).toBeLessThan(300)
  })

  it('handles GET (select all)', async () => {
    const req = new Request('http://localhost/hello', { method: 'GET' })
    const res = await handler(req)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toBeInstanceOf(Array)
    expect(body.length).toBeGreaterThanOrEqual(1)
  })

  it('handles GET with eq filter', async () => {
    const req = new Request('http://localhost/hello?id=eq.1', { method: 'GET' })
    const res = await handler(req)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].message).toBe('test')
  })

  it('handles GET with select', async () => {
    const req = new Request('http://localhost/hello?select=id', { method: 'GET' })
    const res = await handler(req)
    const body = await res.json()
    expect(body[0]).toHaveProperty('id')
    expect(body[0]).not.toHaveProperty('message')
  })

  it('handles PATCH (update)', async () => {
    const req = new Request('http://localhost/hello?id=eq.1', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ message: 'updated' }),
    })
    const res = await handler(req)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body[0].message).toBe('updated')
  })

  it('handles DELETE', async () => {
    // Insert a row to delete
    await db.query(`INSERT INTO "hello" ("id", "message") VALUES ('del-1', 'to-delete')`)

    const req = new Request('http://localhost/hello?id=eq.del-1', { method: 'DELETE' })
    const res = await handler(req)
    expect(res.status).toBe(204)

    const rows = await db.query(`SELECT * FROM "hello" WHERE "id" = 'del-1'`)
    expect(rows.rows).toHaveLength(0)
  })

  // The client confirms a write by the transaction that made it, and counts
  // what it changed from the representation: a delete of a row already gone
  // changed nothing, so it has nothing to confirm.
  it('names the transaction of a write, and only of a write', async () => {
    const post = await handler(new Request('http://localhost/hello', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ id: 'tx-1', message: 'named' }),
    }))
    const xmin = await db.query<{ xmin: string }>(`SELECT xmin::text AS xmin FROM "hello" WHERE "id" = 'tx-1'`)
    expect(post.headers.get('x-txid')).toBe(xmin.rows[0].xmin)

    const read = await handler(new Request('http://localhost/hello?id=eq.tx-1', { method: 'GET' }))
    expect(read.headers.get('x-txid')).toBeNull()

    const remove = () => handler(new Request('http://localhost/hello?id=eq.tx-1', {
      method: 'DELETE',
      headers: { 'Prefer': 'return=representation' },
    }))
    const removed = await remove()
    expect(removed.status).toBe(200)
    expect(await removed.json()).toEqual([{ id: 'tx-1', message: 'named' }])
    expect(Number(removed.headers.get('x-txid'))).toBeGreaterThan(Number(xmin.rows[0].xmin))
    const again = await remove()
    expect(await again.json()).toEqual([])
  })

  it('returns 404 for unknown table', async () => {
    const req = new Request('http://localhost/nonexistent', { method: 'GET' })
    const res = await handler(req)
    expect(res.status).toBe(404)
  })

  // Ordering
  it('handles GET with order', async () => {
    await db.query(`INSERT INTO "hello" ("id", "message") VALUES ('ord-1', 'aaa')`)
    await db.query(`INSERT INTO "hello" ("id", "message") VALUES ('ord-2', 'zzz')`)

    const req = new Request('http://localhost/hello?id=in.(ord-1,ord-2)&order=message.desc', { method: 'GET' })
    const res = await handler(req)
    const body = await res.json()
    expect(body[0].message).toBe('zzz')
    expect(body[1].message).toBe('aaa')
  })

  it('handles GET with order + nullslast', async () => {
    const req = new Request('http://localhost/hello?order=message.asc.nullslast', { method: 'GET' })
    const res = await handler(req)
    expect(res.status).toBe(200)
  })

  // Pagination
  it('handles GET with limit and offset', async () => {
    const req = new Request('http://localhost/hello?order=id.asc&limit=1&offset=1', { method: 'GET' })
    const res = await handler(req)
    const body = await res.json()
    expect(body).toHaveLength(1)
  })

  // Upsert (merge-duplicates)
  it('handles POST with merge-duplicates (upsert)', async () => {
    // First insert
    await handler(new Request('http://localhost/hello', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ id: 'upsert-1', message: 'original' }),
    }))

    // Upsert — should update the existing row
    const res = await handler(new Request('http://localhost/hello', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'return=representation,resolution=merge-duplicates',
      },
      body: JSON.stringify({ id: 'upsert-1', message: 'updated' }),
    }))
    const body = await res.json()
    expect(body[0].message).toBe('updated')
  })

  // Bulk insert
  it('handles POST with array body (bulk insert)', async () => {
    const res = await handler(new Request('http://localhost/hello', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify([
        { id: 'bulk-1', message: 'first' },
        { id: 'bulk-2', message: 'second' },
      ]),
    }))
    const body = await res.json()
    expect(body).toHaveLength(2)
  })

  // Count
  it('handles GET with Prefer count=exact', async () => {
    const req = new Request('http://localhost/hello?limit=2', {
      method: 'GET',
      headers: { 'Prefer': 'count=exact' },
    })
    const res = await handler(req)
    const range = res.headers.get('Content-Range')
    expect(range).toBeTruthy()
    expect(range).toMatch(/\d+-\d+\/\d+/)
  })

  // Security: SQL injection via invalid column names
  it('rejects invalid column names in filters', async () => {
    const req = new Request('http://localhost/hello?id"--=eq.1', { method: 'GET' })
    const res = await handler(req)
    expect(res.status).toBe(400)
  })

  it('rejects invalid column names in select', async () => {
    const req = new Request('http://localhost/hello?select=id"--', { method: 'GET' })
    const res = await handler(req)
    expect(res.status).toBe(400)
  })

  it('rejects invalid column names in order', async () => {
    const req = new Request('http://localhost/hello?order=id"--;DROP%20TABLE%20hello;--.asc', { method: 'GET' })
    const res = await handler(req)
    expect(res.status).toBe(400)
  })

  it('rejects invalid table names', async () => {
    const req = new Request('http://localhost/hello";DROP%20TABLE%20hello;--', { method: 'GET' })
    const res = await handler(req)
    // 400 (invalid identifier) or 404 (not found after safe lookup) — both are acceptable
    expect(res.status === 400 || res.status === 404).toBe(true)
  })

  // Edge case: empty array POST body
  it('handles POST with empty array body', async () => {
    const req = new Request('http://localhost/hello', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    })
    const res = await handler(req)
    expect(res.status).toBe(201)
  })
})

describe('scalar aggregate reads', () => {
  let db: PGlite
  let handler: (req: Request) => Promise<Response>
  const read = (select: string, filter = '') => handler(new Request(
    `http://localhost/appearances?select=${encodeURIComponent(select)}${filter}`,
    { headers: { Prefer: 'count=exact' } },
  ))

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`
      CREATE TABLE owners (id text PRIMARY KEY, name text NOT NULL);
      CREATE TABLE appearances (id integer PRIMARY KEY, owner_id text REFERENCES owners, minutes integer, included boolean NOT NULL);
      INSERT INTO owners VALUES ('a', 'Alpha'), ('b', 'Beta'), ('c', 'Gamma');
      INSERT INTO appearances VALUES
        (1, 'a', 10, true), (2, 'a', NULL, true), (3, 'a', 0, true), (4, 'a', 900, false),
        (5, 'b', 30, true), (6, 'b', 40, true), (7, 'c', NULL, true);
    `)
    handler = createRestHandler(db)
  })

  afterAll(async () => {
    await db.close()
  })

  it('filters source rows before calculating grouped totals and both kinds of count', async () => {
    const response = await read('id:owner_id,total:minutes.sum(),minutes.count(),rows:count(),minutes.avg(),minutes.min(),minutes.max()', '&owner_id=eq.a&included=is.true')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{ id: 'a', total: 10, count: 2, rows: 3, avg: 5, min: 0, max: 10 }])
  })

  it('distinguishes row count from non-null column count using aliases', async () => {
    const response = await read('id:owner_id,total:minutes.sum(),present:minutes.count(),rows:count()', '&owner_id=eq.a&included=is.true')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{ id: 'a', total: 10, present: 2, rows: 3 }])
  })

  it('groups by every selected scalar column and paginates the resulting groups', async () => {
    const response = await read('id:owner_id,included,total:minutes.sum(),count()', '&included=is.true&order=owner_id.asc&limit=1&offset=1')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Range')).toBe('1-1/3')
    expect(await response.json()).toEqual([{ id: 'b', included: true, total: 70, count: 2 }])
  })

  it('preserves SQL null aggregates, zero totals and empty ungrouped counts', async () => {
    const empty = await read('total:minutes.sum(),count()', '&owner_id=eq.missing')
    expect(await empty.json()).toEqual([{ total: null, count: 0 }])
    const zero = await read('minutes.sum(),minutes.avg(),minutes.min(),minutes.max(),count()', '&minutes=eq.0')
    expect(await zero.json()).toEqual([{ sum: 0, avg: 0, min: 0, max: 0, count: 1 }])
    const nulls = await read('total:minutes.sum(),average:minutes.avg(),present:minutes.count(),rows:count()', '&owner_id=eq.c')
    expect(await nulls.json()).toEqual([{ total: null, average: null, present: 0, rows: 1 }])
    const emptyGroups = await read('id:owner_id,total:minutes.sum(),count()', '&owner_id=eq.missing')
    expect(await emptyGroups.json()).toEqual([])
  })

  it.each([
    'minutes.sum();DROP TABLE appearances', 'bad"alias:minutes.sum()', 'minutes.stddev()',
    '*.sum()', '*,minutes.sum()', 'minutes.sum(),owner:owner_id(name)', 'owner:owner_id(count())',
    'minutes.sum(),minutes.sum()',
  ])('rejects unsupported or unsafe aggregate selection %s', async (select) => {
    expect((await read(select)).status).toBe(400)
  })

  it('rejects aggregate ordering instead of compiling a nonexistent source column', async () => {
    expect((await read('id:owner_id,total:minutes.sum()', '&order=total.desc')).status).toBe(400)
  })

  it('retains scalar aliases, wildcard rows, to-one embedding and embedded filters', async () => {
    const response = await read('*,owner:owner_id(name)', '&id=eq.1&owner.name=eq.Alpha')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([{ id: 1, owner_id: 'a', minutes: 10, included: true, owner: { name: 'Alpha' } }])
  })
})

describe('scope session', () => {
  let db: PGlite

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`
      CREATE FUNCTION current_scopes() RETURNS text[] LANGUAGE sql STABLE AS $$
        SELECT coalesce(array(SELECT s FROM unnest(
          string_to_array(current_setting('app.scopes', true), ',')) AS s
          WHERE s <> ''), '{}'::text[]) $$;
      CREATE TABLE "posting" ("id" TEXT PRIMARY KEY, "scope_id" TEXT NOT NULL);
      INSERT INTO "posting" VALUES ('a', 'household:h1'), ('b', 'household:h2');
      ALTER TABLE "posting" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "posting" FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenancy ON "posting" AS RESTRICTIVE FOR ALL
        USING (scope_id = ANY((SELECT current_scopes())::text[]))
        WITH CHECK (scope_id = ANY((SELECT current_scopes())::text[]));
      CREATE POLICY wide ON "posting" FOR ALL USING (true) WITH CHECK (true);
      CREATE ROLE app_user NOLOGIN;
      GRANT USAGE ON SCHEMA public TO app_user;
      GRANT SELECT, INSERT, UPDATE, DELETE ON "posting" TO app_user;
    `)
  })

  afterAll(async () => {
    await db.close()
  })

  // PGlite connects as a superuser, and superusers bypass RLS entirely -- FORCE
  // does not reach them. Without the role switch every policy is inert and the
  // browser sees every scope while looking correct.
  it('is inert without the role switch, which is why one is needed', async () => {
    const bare = createRestHandler(db)
    const res = await bare(new Request('http://localhost/posting'))
    expect((await res.json()).length).toBe(2)
  })

  it('bounds reads to the scopes the resolver returned', async () => {
    const handler = createRestHandler(db, { scopes: () => ['household:h1'] })
    const res = await handler(new Request('http://localhost/posting'))
    const rows = await res.json()
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['a'])
  })

  it('refuses a write into a scope the subject does not hold', async () => {
    const handler = createRestHandler(db, { scopes: () => ['household:h1'] })
    const res = await handler(new Request('http://localhost/posting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'c', scope_id: 'household:h2' }),
    }))
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  // PGlite is one connection, so scopes applied to the session are applied to
  // every reader on it. Two requests in flight would then both run under
  // whichever identity applied last.
  it('keeps concurrent requests on their own scopes', async () => {
    const h1 = createRestHandler(db, { scopes: () => ['household:h1'] })
    const h2 = createRestHandler(db, { scopes: () => ['household:h2'] })
    const [r1, r2] = await Promise.all([
      h1(new Request('http://localhost/posting')),
      h2(new Request('http://localhost/posting')),
    ])
    expect((await r1.json()).map((r: { id: string }) => r.id)).toEqual(['a'])
    expect((await r2.json()).map((r: { id: string }) => r.id)).toEqual(['b'])
  })

  // The scope list is comma-joined into one GUC, so a comma inside a scope
  // arrives as two -- and splitting is the only direction that widens.
  it('refuses a scope containing the separator', async () => {
    const handler = createRestHandler(db, { scopes: () => ['household:h1,household:h2'] })
    const res = await handler(new Request('http://localhost/posting'))
    expect(res.status).toBeGreaterThanOrEqual(400)
  })

  // The point of scoping a request to its own transaction: the session belongs
  // to the app's direct collection reads, and a request must hand it back
  // exactly as it found it.
  it('leaves the session as it found it', async () => {
    await applyScopeSession(db, ['household:h2'])
    const handler = createRestHandler(db, { scopes: () => ['household:h1'] })
    await handler(new Request('http://localhost/posting'))
    const after = await db.query<{ id: string }>('SELECT id FROM posting')
    expect(after.rows.map((r) => r.id)).toEqual(['b'])
    await db.exec('RESET ROLE;')
  })

  it('does not carry a previous subject\'s scopes across a change', async () => {
    const h1 = createRestHandler(db, { scopes: () => ['household:h1'] })
    await h1(new Request('http://localhost/posting'))
    const h2 = createRestHandler(db, { scopes: () => ['household:h2'] })
    const rows = await (await h2(new Request('http://localhost/posting'))).json()
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['b'])
  })
})

// Regression: the handler bound a written value straight to its column, where
// PostgREST hands it to the column's domain representation (a cast from json
// by a function). A representation called on null input decides what a JSON
// null stores, so through the page's cluster a write disagreed with the stack's
// wherever one does, and an object failed to bind at all.
describe('a domain representation', () => {
  let db: PGlite
  let handler: (req: Request) => Promise<Response>
  const write = (method: string, path: string, body: unknown) =>
    handler(new Request(`http://localhost/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
  const stored = async (id: string) =>
    (await db.query<Record<string, string | null>>('SELECT req::text AS req, opt::text AS opt, n::text AS n FROM doc WHERE id = $1', [id])).rows[0]

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`
      CREATE DOMAIN public.loose_json AS json;
      CREATE FUNCTION public.loose_json_from_json(value json) RETURNS public.loose_json
        LANGUAGE sql IMMUTABLE CALLED ON NULL INPUT RETURN COALESCE(value, 'null'::json)::public.loose_json;
      CREATE CAST (json AS public.loose_json) WITH FUNCTION public.loose_json_from_json(json) AS IMPLICIT;
      CREATE DOMAIN public.text_int AS bigint;
      CREATE FUNCTION public.text_int_from_json(value json) RETURNS public.text_int
        LANGUAGE sql IMMUTABLE STRICT RETURN (value #>> '{}')::bigint::public.text_int;
      CREATE CAST (json AS public.text_int) WITH FUNCTION public.text_int_from_json(json) AS IMPLICIT;
      CREATE TABLE doc (id text PRIMARY KEY, req public.loose_json NOT NULL, opt public.loose_json, n public.text_int);
    `)
    handler = createRestHandler(db)
  })

  afterAll(async () => {
    await db.close()
  })

  it('takes a JSON null as its function does, and a value as the JSON it was sent', async () => {
    expect((await write('POST', 'doc', { id: 'a', req: null, opt: null, n: '12' })).status).toBe(201)
    expect(await stored('a')).toEqual({ req: 'null', opt: 'null', n: '12' })
    expect((await write('POST', 'doc', { id: 'b', req: { k: [1] }, n: null })).status).toBe(201)
    expect(await stored('b')).toEqual({ req: '{"k":[1]}', opt: null, n: null })
    expect((await write('PATCH', 'doc?id=eq.b', { req: null, opt: 'x' })).status).toBe(204)
    expect(await stored('b')).toEqual({ req: 'null', opt: '"x"', n: null })
  })
})

// Regression: a json column without a representation took the raw JS value,
// and PGlite's json serializer passes a string through as JSON text, so
// through the page's cluster {"meta":"x"} failed to parse, {"meta":"42"}
// stored the number 42 and {"meta":"[1]"} an array, where PostgREST stores
// each string as the JSON string it was sent.
describe('a json column', () => {
  let db: PGlite
  let handler: (req: Request) => Promise<Response>
  const write = (method: string, path: string, body: unknown) =>
    handler(new Request(`http://localhost/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
  const stored = async (id: string) =>
    (await db.query<{ j: string | null; same: boolean }>('SELECT j::text AS j, b IS NOT DISTINCT FROM j::jsonb AND d::text IS NOT DISTINCT FROM j::text AS same FROM doc WHERE id = $1', [id])).rows[0]
  const values: [string, unknown, string | null][] = [
    ['a string', 'x', '"x"'],
    ['a number-like string', '42', '"42"'],
    ['an array-like string', '[1]', '"[1]"'],
    ['a number', 42, '42'],
    ['an array', [1, 'a'], '[1,"a"]'],
    ['an object', { k: [1] }, '{"k":[1]}'],
    ['a null as SQL NULL', null, null],
  ]

  beforeAll(async () => {
    db = await PGlite.create()
    await db.exec(`CREATE DOMAIN plain_json AS json; CREATE TABLE doc (id text PRIMARY KEY, j json, b jsonb, d plain_json)`)
    handler = createRestHandler(db)
  })

  afterAll(async () => {
    await db.close()
  })

  it.each(values)('stores %s', async (_, value, text) => {
    const id = JSON.stringify(value)
    expect((await write('POST', 'doc', { id, j: value, b: value, d: value })).status).toBe(201)
    expect(await stored(id)).toEqual({ j: text, same: true })
    expect((await write('PATCH', `doc?id=eq.${encodeURIComponent(id)}`, { j: value, b: value, d: value })).status).toBe(204)
    expect(await stored(id)).toEqual({ j: text, same: true })
  })
})
