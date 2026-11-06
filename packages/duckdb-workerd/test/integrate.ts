import assert from 'node:assert/strict'
import { wranglerTools } from '../../pglite-workerd/wrangler-tools.ts'
import './prepare.ts'

function freePort(): number {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 })
  const port = (listener.addr as Deno.NetAddr).port
  listener.close()
  return port
}

const { wrangler, env } = await wranglerTools(new URL('../', import.meta.url))
const port = freePort()
const stateDirectory = await Deno.makeTempDir({ prefix: 'duckdb-workerd-state-' })
const process = new Deno.Command(wrangler, {
  args: ['dev', '--config', new URL('../.build/wrangler.json', import.meta.url).pathname,
    '--port', String(port), '--inspector-port', String(freePort()), '--persist-to', stateDirectory],
  env, stdout: 'piped', stderr: 'inherit',
}).spawn()
const reader = process.stdout.pipeThrough(new TextDecoderStream()).getReader()
const timer = setTimeout(() => process.kill('SIGTERM'), 60_000)
try {
  let output = ''
  while (!output.includes('Ready on')) {
    const next = await reader.read()
    if (next.done) throw new Error(`Wrangler exited before becoming ready:\n${output}`)
    output += next.value
  }
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`http://127.0.0.1:${port}`, { headers: { accept: 'text/plain' } })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    assert.equal(JSON.parse(text).passed, true)
  }
  const diskResponse = await fetch(`http://127.0.0.1:${port}/disk`)
  const diskText = await diskResponse.text()
  assert.equal(diskResponse.status, 200, diskText)
  assert.equal(JSON.parse(diskText).passed, true)
  console.log(diskText)
  const crashId = crypto.randomUUID()
  const crashUrl = `http://127.0.0.1:${port}/crash/${crashId}`
  const write = await fetch(`${crashUrl}/write`)
  assert.equal(write.status, 200, await write.clone().text())
  const beforeCrash = await write.json()
  const aborted = await fetch(`${crashUrl}/abort`)
  assert.equal(aborted.status, 500)
  await aborted.text()
  const read = await fetch(`${crashUrl}/read`)
  assert.equal(read.status, 200, await read.clone().text())
  const afterCrash = await read.json()
  assert.notEqual(afterCrash.instance, beforeCrash.instance)
  assert.deepEqual(beforeCrash.rows, [{ value: 42 }])
  assert.deepEqual(afterCrash.rows, beforeCrash.rows)
  assert.ok(beforeCrash.files.some((file: { path: string; size: number }) => file.path.endsWith('.wal') && file.size > 0))
  console.log(JSON.stringify({ crashRecovery: true, before: beforeCrash, after: afterCrash }))
  const append = await fetch(`${crashUrl}/write`)
  assert.equal(append.status, 200, await append.clone().text())
  assert.deepEqual((await append.json()).rows, [{ value: 42 }, { value: 42 }])
  const abortedAgain = await fetch(`${crashUrl}/abort`)
  assert.equal(abortedAgain.status, 500)
  await abortedAgain.text()
  const readAgain = await fetch(`${crashUrl}/read`)
  assert.equal(readAgain.status, 200, await readAgain.clone().text())
  const afterAppendCrash = await readAgain.json()
  assert.notEqual(afterAppendCrash.instance, afterCrash.instance)
  assert.deepEqual(afterAppendCrash.rows, [{ value: 42 }, { value: 42 }])
  const rotationUrl = `http://127.0.0.1:${port}/crash/${crypto.randomUUID()}`
  const rotationRequest = async (action: string) => {
    const response = await fetch(`${rotationUrl}/${action}`)
    const body = await response.text()
    if (action === 'abort') { assert.equal(response.status, 500); return }
    assert.equal(response.status, 200, body)
    return JSON.parse(body)
  }
  const rotated = await rotationRequest('rotation-write')
  assert.ok(rotated.checkpoints >= 2)
  assert.deepEqual(rotated.rows, [{ n: 1024, total: 523776 }])
  await rotationRequest('abort')
  const recoveredRotation = await rotationRequest('rotation-append')
  assert.notEqual(recoveredRotation.instance, rotated.instance)
  assert.deepEqual(recoveredRotation.rows, [{ n: 1025, total: 524800 }])
  await rotationRequest('abort')
  const finalRotation = await rotationRequest('rotation-read')
  assert.notEqual(finalRotation.instance, recoveredRotation.instance)
  assert.deepEqual(finalRotation.rows, recoveredRotation.rows)
  assert.ok(Math.max(rotated.heap, recoveredRotation.heap, finalRotation.heap) < 64 * 1024 * 1024)
  console.log(JSON.stringify({ rawAppendRecovery: true, after: afterAppendCrash,
    repeatedCheckpointRecovery: true, rotated, recovered: recoveredRotation, final: finalRotation }))

  const executionUrl = `http://127.0.0.1:${port}/crash/${crypto.randomUUID()}`
  const executionRequest = async (action: string) => {
    const response = await fetch(`${executionUrl}/${action}`)
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  const first = await executionRequest('execution-first')
  assert.deepEqual(first.state, { revision: 1, checkpoint: { phase: 1 }, done: false })
  assert.equal((await fetch(`${executionUrl}/abort`)).status, 500)
  const second = await executionRequest('execution-second')
  assert.notEqual(second.instance, first.instance)
  assert.deepEqual(second.before, first.state)
  assert.deepEqual(second.state, { revision: 2, checkpoint: null, done: true })
  assert.deepEqual(second.duplicate, second.state)
  assert.equal((await fetch(`${executionUrl}/abort`)).status, 500)
  const third = await executionRequest('execution-read')
  assert.notEqual(third.instance, second.instance)
  assert.deepEqual(third.state, second.state)
  assert.deepEqual(third.output.rows, [{ id: 'one', value: 2 }, { id: 'two', value: 3 }])
  assert.deepEqual(third.manifest, { sink: { rows: 2 } })
  assert.deepEqual(third.scratch, [{ value: 3 }])
  console.log(JSON.stringify({ executionCrashRecovery: true, first, second, third }))
  console.log('PASS: workerd, concurrent instances, prepared statements, JSON/ICU, runtime restoration, external access disabled')
} finally {
  clearTimeout(timer)
  process.kill('SIGTERM')
  await reader.cancel()
  await process.status
  await Deno.remove(stateDirectory, { recursive: true })
}
