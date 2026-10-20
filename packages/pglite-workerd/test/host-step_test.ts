// pgl_step, linked into the backend (modules/pgl_step, wasm.nu): a SQL
// function whose body is the host's, called from a query in the object. The
// worker sets the host step to an echo, so the answer says the call crossed
// into JavaScript and back with its arguments intact.
import assert from 'node:assert/strict'
import { startWorker } from '../wrangler-dev.ts'
import { seed } from './seed.ts'
import { load } from '../load.ts'

Deno.test({ name: 'a machine step runs in the host, called from SQL', sanitizeResources: false, sanitizeOps: false }, async () => {
  const tmp = await Deno.makeTempDir({ prefix: 'pglite-host-step-' })
  await seed(`${tmp}/empty`, false)
  const worker = await startWorker(new URL('wrangler.jsonc', import.meta.url), `${tmp}/state`)
  const rows = async (sql: string) => {
    const res = await fetch(`${worker.origin}/sql?do=host-step&codec=raw`, { method: 'POST', body: JSON.stringify({ sql }) })
    const text = await res.text()
    assert.equal(res.status, 200, text.slice(0, 400))
    return JSON.parse(text)
  }
  try {
    await load(`${tmp}/empty`, (route, init) => fetch(`${worker.origin}/import/${route}${route.includes('?') ? '&' : '?'}do=host-step&codec=raw`, init), { log: () => {} })
    await rows(`CREATE FUNCTION public.pgl_step(name text, input jsonb) RETURNS jsonb LANGUAGE c STRICT AS '$libdir/pgl_step', 'pgl_step'`)
    const [{ out }] = await rows(`SELECT public.pgl_step('truco_match', '{"state": {"phase": "waiting"}, "event": {"kind": "sit"}}') AS out`)
    assert.deepEqual(out, { machine: 'truco_match', input: { state: { phase: 'waiting' }, event: { kind: 'sit' } }, ran: 'host' })
    // A failure crosses back as a value and is raised as the step's error.
    const failed = await fetch(`${worker.origin}/sql?do=host-step&codec=raw`, { method: 'POST', body: JSON.stringify({ sql: `SELECT public.pgl_step('failing', '{"why": "a rule threw"}')` }) })
    const failure = await failed.text()
    assert.notEqual(failed.status, 200)
    assert.match(failure, /the host refused a rule threw/)
    assert.deepEqual(await rows(`SELECT 1 AS alive`), [{ alive: 1 }])
    const started = performance.now()
    const [{ n }] = await rows(`SELECT count(*)::int AS n FROM generate_series(1, 1000) g WHERE (public.pgl_step('m', jsonb_build_object('i', g)))->>'ran' = 'host'`)
    assert.equal(n, 1000)
    console.log(`1000 host steps in ${Math.round(performance.now() - started)} ms`)
  } finally {
    await worker.stop()
  }
})
