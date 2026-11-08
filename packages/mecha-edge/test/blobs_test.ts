import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { signJwt } from '../../../services/auth/jwt.ts'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { load } from '../../pglite-workerd/load.ts'
import { seed } from './seed.ts'

// The edge had no way to write a blob but the release's own token. Its door asks the
// emitted functions, stand-ins here with the same signatures: pronto's
// blob-claims.integration.test.ts proves their logic in postgres.
Deno.test({ name: 'a session writes only the blob keys it claimed, and the store holds the same bytes', sanitizeResources: false, sanitizeOps: false, async fn() {
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-blobs-' })
  await seed(`${tmp}/pgdata`)
  const db = await PGlite.create({ dataDir: `${tmp}/pgdata` })
  try {
    await db.exec(`
      CREATE SCHEMA blob_plane;
      CREATE TABLE blob_plane.claim (key text PRIMARY KEY, owner uuid NOT NULL);
      CREATE FUNCTION blob_plane.claim_key(who uuid, wanted text) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        IF wanted = 'over.jpg' THEN RAISE EXCEPTION 'too many' USING ERRCODE = 'PT429'; END IF;
        INSERT INTO blob_plane.claim VALUES (wanted, who) ON CONFLICT (key) DO NOTHING;
      END $$;
      CREATE FUNCTION blob_plane.may_write(who uuid, wanted text) RETURNS boolean LANGUAGE sql AS
        $$ SELECT EXISTS (SELECT 1 FROM blob_plane.claim WHERE key = wanted AND owner = who) $$;
      CHECKPOINT`)
  } finally {
    await db.close()
  }
  const worker = await startWorker(new URL('blobs-wrangler.jsonc', import.meta.url), `${tmp}/state`)
  try {
    await load(`${tmp}/pgdata`, (route, init) => fetch(`${worker.origin}/import/${route}`, {
      ...init, headers: { authorization: 'Bearer test-import' },
    }), { log: () => {} })
    const session = async (sub: string) => ({ authorization: `Bearer ${await signJwt('test-secret', { role: 'app_user', sub, guest: true, exp: Math.floor(Date.now() / 1000) + 600 })}` })
    const one = await session('00000000-0000-0000-0000-000000000001')
    const two = await session('00000000-0000-0000-0000-000000000002')
    const status = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${worker.origin}${path}`, init)
      await res.body?.cancel()
      return res.status
    }
    const bytes = new Uint8Array(65536).map((_, i) => i % 251)
    assert.equal(await status('/blob-claim/a.jpg', { method: 'POST' }), 401)
    assert.equal(await status('/blobs/mecha-objects/a.jpg', { method: 'PUT', body: bytes }), 401)
    assert.equal(await status('/blob-claim/a.jpg', { method: 'POST', headers: one }), 200)
    assert.equal(await status('/blobs/mecha-objects/a.jpg', { method: 'PUT', body: bytes, headers: two }), 403)
    assert.equal(await status('/blob-claim/over.jpg', { method: 'POST', headers: one }), 429)
    // A malformed escape is the client's error, not an unhandled URIError.
    assert.equal(await status('/blob-claim/%ZZ.jpg', { method: 'POST', headers: one }), 400)
    assert.equal(await status('/blobs/mecha-objects/%E0%A4%A', { method: 'PUT', body: bytes, headers: one }), 400)
    assert.equal(await status('/blobs/mecha-objects/a.jpg', { method: 'PUT', body: new Uint8Array(16 * 1024 * 1024 + 1), headers: one }), 413)
    assert.equal(await status('/blobs/mecha-objects/a.jpg', { method: 'PUT', body: bytes, headers: { ...one, 'content-type': 'image/jpeg' } }), 200)
    const read = await fetch(`${worker.origin}/read/a.jpg`)
    assert.deepEqual(new Uint8Array(await read.arrayBuffer()), bytes)
  } finally {
    await worker.stop()
    await Deno.remove(tmp, { recursive: true })
  }
} })
