import assert from 'node:assert/strict'
import { load, type Send } from '../load.ts'

for (const retained of ['empty', 'root', 'complete', 'file', 'directory'] as const) {
  Deno.test(`an interrupted reset reconciles ${retained} storage before importing`, async () => {
    const directory = await Deno.makeTempDir()
    const bytes = new Uint8Array([1, 2, 3])
    await Deno.writeFile(`${directory}/data`, bytes)
    let complete = true, resets = 0, imported: Uint8Array | undefined
    let nodes: { path: string; dir: boolean; size: number }[] = []
    const send: Send = async (route, init) => {
      if (route === 'reset') {
        resets++
        complete = resets === 1 && retained === 'complete'
        nodes = resets > 1 || retained === 'empty' ? [] : retained === 'root'
          ? [{ path: '/', dir: true, size: 0 }]
          : [{ path: '/previous', dir: retained === 'directory', size: 0 }]
        if (resets === 1 && retained === 'root') throw new TypeError('connection closed after reset')
        if (resets === 1) return new Response('object aborted after reset', { status: 500 })
        return Response.json({ reset: true })
      }
      if (route === 'status') return Response.json({ complete })
      if (route === 'state') return Response.json(nodes)
      if (route.startsWith('chunk?')) {
        assert.equal(complete, false)
        assert.ok(nodes.every(node => node.path === '/'))
        imported = new Uint8Array(await new Response(init?.body).arrayBuffer())
        return Response.json({ ok: true })
      }
      if (route === 'hash') {
        assert.deepEqual(imported, bytes)
        const digest = await crypto.subtle.digest('SHA-256', bytes)
        return Response.json([[...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('')])
      }
      assert.equal(route, 'complete')
      complete = true
      return Response.json({ complete })
    }
    try {
      const result = await load(directory, send, { reset: true, log: () => {} })
      assert.ok('chunksVerified' in result)
      assert.equal(result.chunksVerified, 1)
      assert.equal(resets, retained === 'empty' || retained === 'root' ? 1 : 2)
      assert.equal(complete, true)
    } finally { await Deno.remove(directory, { recursive: true }) }
  })
}
