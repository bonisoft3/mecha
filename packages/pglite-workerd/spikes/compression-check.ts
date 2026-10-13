import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { icuDataDir } from '@electric-sql/pglite-icu-full'

import { queries } from './archive-queries.ts'

const [mode, target, referenceFile, tokenFile] = Deno.args
if (!target || !referenceFile || (mode !== 'reference' && mode !== 'remote') || (mode === 'remote' && !tokenFile)) {
  throw new Error('compression-check.ts reference <pgdata-copy> <reference-json> | remote <probe-origin> <reference-json> <token-file>')
}
if (mode === 'reference') {
  const db = await PGlite.create({ dataDir: target, icuDataDir: await icuDataDir() })
  const expected: Record<string, unknown> = {}
  try {
    await db.exec('BEGIN READ ONLY')
    for (const [name, sql] of Object.entries(queries)) expected[name] = (await db.query(sql)).rows
    await db.exec('COMMIT')
  } finally { await db.close() }
  await Deno.writeTextFile(referenceFile, JSON.stringify(expected))
  console.log(JSON.stringify({ reference: referenceFile, queries: Object.keys(expected) }))
} else {
  const expected = JSON.parse(await Deno.readTextFile(referenceFile))
  const headers = { authorization: `Bearer ${(await Deno.readTextFile(tokenFile)).trim()}`, 'content-type': 'application/json' }
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${target}${path}`, { ...init, headers })
    assert.ok(res.ok, `${path}: ${res.status} ${res.ok ? '' : await res.text()}`)
    return res.json()
  }
  assert.equal((await fetch(`${target}/stats`)).status, 401)
  const before = await call('/stats')
  const runs = []
  for (const phase of ['cold', 'warm', 'recovered']) {
    if (phase === 'recovered') {
      const res = await fetch(`${target}/abort`, { method: 'POST', headers })
      assert.ok(res.status >= 500)
      await res.body?.cancel()
    }
    for (const [name, sql] of Object.entries(queries)) {
      const started = performance.now()
      const result = await call('/sql', { method: 'POST', body: JSON.stringify({ sql }) })
      assert.deepEqual(result.rows, expected[name], `${phase}: ${name}`)
      runs.push({ phase, name, roundTripMs: performance.now() - started, rows: result.rows.length })
    }
  }
  console.log(JSON.stringify({ before, after: await call('/stats'), runs }, null, 2))
}
