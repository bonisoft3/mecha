// The page's shape server against the protocol Electric's client parses: a
// value is Postgres's text for it. Sent typed, a boolean `true` met the
// client's `v === "true" || v === "t"` and read as false, so a page filtering
// on `featured=is.true` showed nothing.
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { createCluster } from './cluster.ts'

const rls = await Deno.readTextFile(new URL('../../services/database/rls/rls.sql', import.meta.url))
const schema = `
  CREATE TABLE app_user (id uuid PRIMARY KEY, handle text NOT NULL);
  CREATE TABLE flag (
    id uuid PRIMARY KEY, featured boolean NOT NULL, n int, tags text[], meta jsonb, note text,
    scope_id text GENERATED ALWAYS AS ('public:') STORED NOT NULL
  );
  INSERT INTO flag (id, featured, n, tags, meta) VALUES ('00000000-0000-4000-8000-000000000001', true, 3, '{a,b}', '{"k": 1}');
`

Deno.test('a shape answers every value as Postgres text, in its snapshot and in its log', async () => {
  const db = await PGlite.create()
  const cluster = await createCluster({ db, sql: [rls, schema], tables: ['flag'], log: console.error })
  const shape = (q: string) => cluster.handle(new Request(`http://cluster.local/electric/v1/shape?table=flag&${q}`))

  const first = await shape('offset=-1')
  const snapshot = (await first.json()) as { value?: Record<string, unknown> }[]
  assert.deepEqual(snapshot[0].value, {
    id: '00000000-0000-4000-8000-000000000001', featured: 'true', n: '3', tags: '{a,b}', meta: '{"k": 1}', note: null, scope_id: 'public:',
  })

  await db.query(`UPDATE flag SET featured = false, n = NULL`)
  // The notification is read back in a queued task.
  await new Promise((r) => setTimeout(r, 50))
  const next = await shape(`offset=${first.headers.get('electric-offset')}&handle=${first.headers.get('electric-handle')}`)
  const log = (await next.json()) as { value?: Record<string, unknown> }[]
  assert.equal(log[0].value?.featured, 'false')
  assert.equal(log[0].value?.n, null)
  await db.close()
})
