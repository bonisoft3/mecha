import assert from 'node:assert/strict'
import { queries } from './archive-queries.ts'

const [origin, referenceFile, tokenFile] = Deno.args
if (!tokenFile) throw new Error('query-memory-check.ts <probe-origin> <reference-json> <token-file>')
const expected = JSON.parse(await Deno.readTextFile(referenceFile))
const headers = { authorization: `Bearer ${(await Deno.readTextFile(tokenFile)).trim()}` }
const runs = []
for (const workMem of ['1MB', '8MB', '8MB', '1MB']) {
  const started = performance.now()
  const res = await fetch(origin + '/sql', { method: 'POST', headers, body: JSON.stringify({ sql: queries.players, workMem }) })
  assert.ok(res.ok, await res.clone().text())
  const result = await res.json()
  assert.deepEqual(result.rows, expected.players)
  runs.push({ workMem, roundTripMs: performance.now() - started })
}
const res = await fetch(origin + '/sql', { method: 'POST', headers, body: JSON.stringify({ sql: 'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ' + queries.players, workMem: '8MB' }) })
assert.ok(res.ok, await res.clone().text())
const plan = (await res.json()).rows[0]['QUERY PLAN'][0]
console.log(JSON.stringify({ runs, plan }, null, 2))
