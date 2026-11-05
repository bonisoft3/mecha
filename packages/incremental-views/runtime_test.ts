import assert from 'node:assert/strict'
import { PGlite } from 'npm:@electric-sql/pglite@0.5.8'
import { pg_ivm } from 'npm:@electric-sql/pglite-pg_ivm@0.0.9'
import { loadIncrementalViews } from './runtime.ts'

Deno.test('pg_ivm 1.13 maintains joins, grouped counts and maxima transactionally on PGlite 0.5.8', async () => {
  const db = await loadIncrementalViews(await PGlite.create({ extensions: { pg_ivm } }))
  try {
    await db.exec(await Deno.readTextFile(new URL('./proof.sql', import.meta.url)))
    assert.deepEqual((await db.query("SELECT extversion FROM pg_extension WHERE extname='pg_ivm'")).rows, [{ extversion: '1.13' }])
    const archive = await db.dumpDataDir()
    const restored = await loadIncrementalViews(await PGlite.create({ loadDataDir: archive, extensions: { pg_ivm } }))
    try {
      await restored.exec("UPDATE ivm_art SET status='drawn' WHERE id='c:2'")
      assert.deepEqual((await restored.query("SELECT drawn::integer, failed::integer FROM ivm_counts WHERE set_id='other'")).rows, [{ drawn: 1, failed: 0 }])
    } finally { await restored.close() }
  } finally { await db.close() }
})

Deno.test('missing pg_ivm capability refuses database opening', async () => {
  const db = await PGlite.create()
  try { await assert.rejects(() => loadIncrementalViews(db), /pg_ivm/) }
  finally { await db.close() }
})

Deno.test('an incompatible installed pg_ivm version refuses database opening', async () => {
  const db = await PGlite.create({ extensions: { pg_ivm } })
  try {
    await db.exec("CREATE EXTENSION pg_ivm; UPDATE pg_extension SET extversion='1.12' WHERE extname='pg_ivm'")
    await assert.rejects(() => loadIncrementalViews(db), /mecha requires pg_ivm 1\.13/)
  } finally { await db.close() }
})
