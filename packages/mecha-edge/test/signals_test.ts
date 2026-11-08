import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { load } from '../../pglite-workerd/load.ts'
import { seed } from './seed.ts'

// The object's part of a signal: it calls the function pronto emits and turns its
// codes into the statuses PostgREST gives the container door. The function here is
// a stand-in with the emitted one's signature; its logic is pronto's to test.
Deno.test({ name: 'a signal reaches the cluster\'s function, and its refusals are statuses', sanitizeResources: false, sanitizeOps: false, async fn() {
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-signals-' })
  await seed(`${tmp}/pgdata`)
  const db = await PGlite.create({ dataDir: `${tmp}/pgdata` })
  try {
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS airlock;
      CREATE TABLE signal_seen (name text, path_id text, body json);
      CREATE FUNCTION airlock.signal(name text, path_id text, body json) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN
        IF name = 'busy' THEN RAISE EXCEPTION 'in flight' USING ERRCODE = 'PT503'; END IF;
        IF name = 'absent' THEN RAISE EXCEPTION 'no signal' USING ERRCODE = 'PT404'; END IF;
        INSERT INTO signal_seen VALUES (name, path_id, body);
        RETURN 'ignored';
      END $$;
      CHECKPOINT`)
  } finally {
    await db.close()
  }
  const worker = await startWorker(new URL('signals-wrangler.jsonc', import.meta.url), `${tmp}/state`)
  try {
    const post = async (path: string, body = '{}') => {
      const res = await fetch(`${worker.origin}${path}`, { method: 'POST', body })
      return { status: res.status, body: await res.json() }
    }
    assert.equal((await post('/signal/stripe')).status, 503, 'the data directory is still loading')
    await load(`${tmp}/pgdata`, (route, init) => fetch(`${worker.origin}/import/${route}`, {
      ...init, headers: { authorization: 'Bearer test-import' },
    }), { log: () => {} })
    assert.deepEqual(await post('/signal/stripe', '{"a":1}'), { status: 200, body: { signal: 'ignored' } })
    assert.deepEqual(await post('/signal/vendor/order-1'), { status: 200, body: { signal: 'ignored' } })
    assert.equal((await post('/signal/busy')).status, 503)
    assert.equal((await post('/signal/absent')).status, 404)
    assert.equal((await post('/signal/stripe', 'not json')).status, 400)
    assert.equal((await post('/signal/stripe', 'x'.repeat(1024 * 1024 + 1))).status, 413)
    // The bound is in bytes: half as many two-byte characters passed a count of characters.
    assert.equal((await post('/signal/stripe', 'é'.repeat(600 * 1024))).status, 413)
    // A body with no stated length is refused before the object buffers it.
    const unsized = await fetch(`${worker.origin}/signal/stripe`, { method: 'POST', body: ReadableStream.from([new TextEncoder().encode('{}')]) })
    assert.equal(unsized.status, 411)
    await unsized.body?.cancel()
    const get = await fetch(`${worker.origin}/signal/stripe`)
    await get.body?.cancel()
    assert.equal(get.status, 405)
  } finally {
    await worker.stop()
  }
} })
