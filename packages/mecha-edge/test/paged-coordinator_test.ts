import assert from 'node:assert/strict'
import { advancePaged, reclaimPaged, type PagedDatabase } from '../src/paged-coordinator.ts'
import type { ComputeCapture, ComputeService } from '../src/compute.ts'
import type { SnapshotChunk, SnapshotManifest } from '../../compute-snapshot/src/index.ts'
import type { PagedRequest } from '../src/paged-transport.ts'

const defer = <T>(fn: () => T): Promise<T> => Promise.resolve().then(fn)

class MemoryStorage {
  constructor(readonly values = new Map<string, unknown>()) {}
  failOutputProgress = false
  failDelete = false
  get<T>(key: string): Promise<T | undefined> { return defer(() => { return structuredClone(this.values.get(key)) as T | undefined }) }
  put(key: string, value: unknown) { return defer(() => {
    this.values.set(key, structuredClone(value))
    if (this.failOutputProgress && key.startsWith('paged:') && Object.keys((value as { outputs: object }).outputs).length) {
      this.failOutputProgress = false
      throw new Error('lost progress acknowledgement')
    }
  }) }
  delete(key: string) { return defer(() => {
    if (this.failDelete && key.startsWith('paged:')) { this.failDelete = false; throw new Error('cleanup progress delete failed') }
    return this.values.delete(key)
  }) }
  list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> { return defer(() => {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value) as T]))
  }) }
  async getAlarm(): Promise<number | null> { return await this.get<number>('alarm') ?? null }
  async setAlarm(at: number) { await this.put('alarm', at) }
  async deleteAlarm() { await this.delete('alarm') }
  async transaction<T>(fn: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    const before = structuredClone(this.values)
    try { return await fn(this) }
    catch (error) { this.values.clear(); for (const [key, value] of before) this.values.set(key, value); throw error }
  }
}

const capture: ComputeCapture = { generation: 'generation-1', identity: { id: 'capture-1', name: 'totals', version: 'v1', revision: 1 } }
const keyOf = (value: ComputeCapture) => JSON.stringify([value.generation, value.identity.id])
const owner = 'compute-a'
const progressKey = (value: ComputeCapture, service = owner) => `paged:${JSON.stringify([service, value.generation, value.identity.id])}`
const output = [{ id: 'one', value: 3 }, { id: 'two', value: 4 }, { id: 'three', value: 5 }]
const positions = [2, 7, 19]
interface Remote {
  capture: ComputeCapture
  sources: Map<string, number>
  queries: string[]
  steps: number
  execution: { revision: number; checkpoint: unknown; done: boolean }
}

function fixture(sourceRows = 35, computeOwner = owner, values = new Map<string, unknown>()) {
  const storage = new MemoryStorage(values)
  const remotes = new Map<string, Remote>()
  const faults = new Set<string>()
  const events: string[] = []
  const staged = new Map<string, Map<number, Record<string, unknown>[]>>()
  let generation = capture.generation
  let publication: 'pending' | 'published' | 'obsolete' = 'pending'
  let publishes = 0, rejects = 0, uploadEffects = 0, uploadCalls = 0
  let sealed = false
  let sourceRetained = false
  let incompleteOutput = false
  const manifest: SnapshotManifest = { ...capture.identity, tables: {
    source: { columns: [{ name: 'id', type: 'text' }], rows: sourceRows },
    empty: { columns: [{ name: 'id', type: 'text' }], rows: 0 },
  } }
  const lost = (name: string) => { if (faults.delete(name)) throw new Error(`lost ${name} acknowledgement`) }
  const status = (remote: Remote) => ({
    manifest: structuredClone(manifest),
    sources: [...remote.sources].map(([name, position]) => ({ name, position })),
    queries: [...remote.queries], declaredQueries: ['projection', 'summary'], sinks: ['sink', 'empty_sink'],
    execution: structuredClone(remote.execution),
  })
  const current = (value: ComputeCapture) => {
    assert.deepEqual(value, capture)
    if (value.generation !== generation || publication !== 'pending') throw new Error('capture is no longer available')
  }
  const db: PagedDatabase & {
    computeReaderName(value: ComputeCapture): Promise<string | null>
    computePrepare(): Promise<boolean>
    computeClaim(): Promise<ComputeCapture | null>
    computeReject(value: ComputeCapture, error: string): Promise<void>
    computeWakeAt(): Promise<number | null>
  } = {
    computePrepare() { return Promise.resolve(true) },
    computeClaim() { return defer(() => {
      events.push('claim')
      if (publication !== 'pending' && sourceRetained) { lost('source-release'); sourceRetained = false }
      return publication === 'pending' && generation === capture.generation ? structuredClone(capture) : null
    }) },
    computeReaderName(value) { return defer(() => { current(value); return null }) },
    computeManifest(value) { return defer(() => { events.push('manifest'); current(value); return structuredClone(manifest) }) },
    computeChunk(value, source, after): Promise<SnapshotChunk> { return defer(() => {
      current(value)
      assert.equal(source, 'source')
      assert.ok(after < sourceRows)
      return { ...capture.identity, table: source, after, next: after + 1, done: after + 1 === sourceRows, rows: [{ id: `source-${after}` }] }
    }) },
    computeOutputChunk(value, attempt, sink, ordinal, rows) { return defer(() => {
      events.push(`upload:${sink}:${ordinal}`)
      current(value)
      assert.equal(attempt, computeOwner)
      assert.equal(sink, 'sink')
      assert.ok(rows.length <= 128)
      uploadCalls++
      const chunks = staged.get(sink) ?? new Map()
      if (chunks.has(ordinal)) assert.deepEqual(chunks.get(ordinal), rows)
      else { assert.equal(ordinal, chunks.size); chunks.set(ordinal, structuredClone(rows)); uploadEffects++ }
      staged.set(sink, chunks)
      lost('upload')
    }) },
    computeSealOutput(value, attempt, counts) { return defer(() => {
      events.push('seal'); current(value); assert.equal(attempt, computeOwner)
      assert.deepEqual(counts, { sink: { chunks: 3, rows: 3 }, empty_sink: { chunks: 0, rows: 0 } })
      assert.deepEqual([...staged.get('sink')!.values()].flat(), output)
      sealed = true
      lost('seal')
    }) },
    computePublishStaged(value, attempt) { return defer(() => {
      events.push('publish'); current(value); assert.equal(attempt, computeOwner); assert.ok(sealed)
      publication = 'published'; publishes++
      sourceRetained = true
      lost('source-release')
      sourceRetained = false
      lost('publish')
    }) },
    computePublication(value) { return defer(() => {
      events.push('publication')
      return value.generation === generation ? publication : 'obsolete'
    }) },
    computeReject(_value, error) { return defer(() => { events.push(`reject:${error}`); if (publication === 'pending') rejects++ }) },
    computeWakeAt() { return defer(() => { return publication === 'pending' && generation === capture.generation ? Date.now() : null }) },
  }
  const service: ComputeService = { fetch(input, init) { return defer(() => {
    const request = JSON.parse(String(init!.body)) as PagedRequest
    const key = keyOf(request.capture)
    assert.equal(new URL(String(input)).searchParams.get('key'), key)
    events.push(request.action)
    if (request.action === 'cleanup') {
      remotes.delete(key)
      lost(`cleanup:${key}`)
      lost('cleanup')
      return Response.json({ cleared: true })
    }
    let remote = remotes.get(key)
    if (request.action === 'initialize') {
      assert.deepEqual(request.manifest, manifest)
      if (!remote) {
        remote = { capture: structuredClone(request.capture), sources: new Map([['source', 0], ['empty', 0]]), queries: [], steps: 0,
          execution: { revision: 0, checkpoint: null, done: false } }
        remotes.set(key, remote)
      }
      lost('initialize')
      return Response.json(status(remote))
    }
    assert.ok(remote)
    assert.deepEqual(request.capture, remote.capture)
    switch (request.action) {
      case 'status': {
        lost('status')
        const answer = status(remote)
        if (faults.delete('wrong-manifest')) answer.manifest.version = 'wrong'
        return Response.json(answer)
      }
      case 'append': {
        const chunk = request.chunk!
        assert.equal(chunk.after, remote.sources.get(chunk.table))
        remote.sources.set(chunk.table, chunk.next)
        lost('append')
        return Response.json({ next: faults.delete('wrong-append-cursor') ? chunk.next + 1 : chunk.next })
      }
      case 'materialize':
        assert.equal(remote.sources.get('source'), sourceRows)
        assert.ok(['projection', 'summary'].includes(request.query!))
        if (!remote.queries.includes(request.query!)) remote.queries.push(request.query!)
        lost('materialize')
        return Response.json({ materialized: request.query })
      case 'step':
        assert.equal(remote.queries.length, 2)
        remote.steps++
        remote.execution = { revision: remote.steps, checkpoint: { phase: remote.steps }, done: remote.steps === 3 }
        lost('step')
        return Response.json(remote.execution)
      case 'output': {
        assert.ok(remote.execution.done)
        if (incompleteOutput) return Response.json({ after: request.after, next: request.after, rows: [], done: false })
        if (request.sink === 'empty_sink') return Response.json({ after: 0, next: 0, rows: [], done: true })
        const index = positions.findIndex(position => position > request.after!)
        assert.ok(index >= 0)
        return Response.json({ after: request.after, next: positions[index], rows: [output[index]], done: index === output.length - 1 })
      }
      default: throw new Error(`unexpected action ${request.action}`)
    }
  }) } }
  return {
    db, service, storage, remotes, faults, events, staged, owner: computeOwner,
    get publishes() { return publishes }, get rejects() { return rejects },
    get sourceRetained() { return sourceRetained },
    get uploadEffects() { return uploadEffects }, get uploadCalls() { return uploadCalls },
    replaceGeneration() { generation = 'generation-2' },
    incomplete(value: boolean) { incompleteOutput = value },
    obsolete() { publication = 'obsolete' },
  }
}

async function coordinatorFactory() {
  const url = new URL('../src/compute-coordinator.ts', import.meta.url)
  const source = (await Deno.readTextFile(url))
    .replace("import { DurableObject } from 'cloudflare:workers'", 'class DurableObject { constructor(ctx,env) { this.ctx=ctx;this.env=env } }')
    .replace(/from '(\.[^']+)'/g, (_match, relative: string) => `from '${new URL(relative, url).href}'`)
  return (await import(`data:application/typescript,${encodeURIComponent(source)}`)).computeCoordinator
}

const createCoordinator = await coordinatorFactory()
const actor = (f: ReturnType<typeof fixture>, storage = f.storage) => new (createCoordinator(undefined, ['totals'], f.owner))({ storage }, {
  CLUSTER: { idFromName: (name: string) => name, get: () => f.db }, COMPUTE: f.service,
})
async function finish(f: ReturnType<typeof fixture>) {
  for (let attempt = 0; attempt < 50; attempt++) {
    await actor(f, new MemoryStorage(f.storage.values)).alarm()
    if (f.publishes && !await f.storage.get(progressKey(capture, f.owner))) return
  }
  assert.fail('paged computation did not terminate')
}

Deno.test('paged alarms batch within the shared budget and resume every phase from durable remote state', async () => {
  const f = fixture(260)
  await actor(f).alarm()
  assert.equal(f.events.filter(event => event === 'append').length, 127)
  assert.equal(f.remotes.get(keyOf(capture))!.sources.get('source'), 127)
  await actor(f, new MemoryStorage(f.storage.values)).alarm()
  assert.equal(f.events.filter(event => event === 'append').length, 254)
  await finish(f)
  assert.equal(f.publishes, 1)
  assert.equal(f.uploadEffects, 3)
  assert.equal(f.events.filter(event => event === 'step').length, 3)
  assert.equal(f.events.filter(event => event === 'materialize').length, 2)
  assert.equal(f.remotes.size, 0)
  assert.equal(await f.storage.getAlarm(), null)
  assert.equal(await f.storage.get('failure'), undefined)
  assert.equal((await f.storage.list({ prefix: 'failure:' })).size, 0)
  assert.equal([...f.storage.values.keys()].some(key => /checkpoint|execution/.test(key)), false)
})

Deno.test('one alarm skips redundant status calls during execution and restart validates again', async () => {
  const f = fixture(0)
  const session = { executing: false }
  for (let i = 0; i < 5; i++) await advancePaged(f.db, f.service, f.storage, capture, owner, session)
  assert.equal(f.events.filter(event => event === 'step').length, 3)
  assert.equal(f.events.filter(event => event === 'status').length, 2)
  assert.equal(session.executing, false)
  const restarted = { executing: false }
  await advancePaged(f.db, f.service, f.storage, capture, owner, restarted)
  assert.equal(f.events.filter(event => event === 'status').length, 3)
  await finish(f)
  assert.equal(f.publishes, 1)
})

Deno.test('lost fast-step acknowledgement clears the shortcut and resumes from durable state', async () => {
  const f = fixture(0)
  const session = { executing: false }
  for (let i = 0; i < 3; i++) await advancePaged(f.db, f.service, f.storage, capture, owner, session)
  assert.equal(session.executing, true)
  f.faults.add('step')
  await assert.rejects(advancePaged(f.db, f.service, f.storage, capture, owner, session), /lost step acknowledgement/)
  assert.equal(session.executing, false)
  const count = f.events.filter(event => event === 'status').length
  await advancePaged(f.db, f.service, f.storage, capture, owner, session)
  assert.equal(f.events.filter(event => event === 'status').length, count + 1)
  assert.equal(f.events.filter(event => event === 'step').length, 3)
  await finish(f)
  assert.equal(f.publishes, 1)
})

for (const action of ['append', 'materialize', 'step', 'upload', 'seal']) {
  Deno.test(`lost ${action} acknowledgement resumes without repeating committed effects`, async () => {
    const f = fixture(2)
    f.faults.add(action)
    let failed = false
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await actor(f).alarm() }
      catch (error) { assert.match(String(error), new RegExp(`lost ${action} acknowledgement`)); failed = true; break }
    }
    assert.ok(failed)
    assert.equal(f.rejects, 1)
    assert.equal((await f.storage.list({ prefix: 'failure:' })).size, 1)
    await finish(f)
    assert.equal(f.publishes, 1)
    assert.equal(f.uploadEffects, 3)
    assert.equal(f.uploadCalls, action === 'upload' ? 4 : 3)
    assert.equal(f.events.filter(event => event === 'step').length, 3)
    assert.equal((await f.storage.list({ prefix: 'failure:' })).size, 0)
  })
}

for (const sibling of [false, true]) Deno.test(`publication acknowledgement loss reclaims before claiming or loading a deleted capture${sibling ? ' without delaying pending work' : ''}`, async () => {
  const f = fixture(1)
  let siblingWake: number | null = sibling ? Date.now() + 1_000 : null
  const wakeAt = f.db.computeWakeAt
  f.db.computeWakeAt = () => f.publishes ? Promise.resolve(siblingWake) : wakeAt()
  f.faults.add('publish')
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await actor(f).alarm() }
    catch (error) { assert.match(String(error), /lost publish acknowledgement/); break }
  }
  assert.equal(f.publishes, 1)
  assert.equal(f.rejects, 0)
  assert.equal(f.remotes.size, 1)
  assert.notEqual(await f.storage.getAlarm(), null)
  if (sibling) assert.equal(await f.storage.getAlarm(), siblingWake)
  assert.equal((await f.storage.list({ prefix: 'failure:' })).size, 0)
  siblingWake = null
  const at = f.events.length
  await actor(f, new MemoryStorage(f.storage.values)).alarm()
  assert.deepEqual(f.events.slice(at), ['publication', 'cleanup', 'claim'])
  assert.equal(f.publishes, 1)
  assert.equal(f.remotes.size, 0)
  assert.equal((await f.storage.list({ prefix: 'paged:' })).size, 0)
  assert.equal(await f.storage.getAlarm(), null)
})

for (const loss of ['cleanup', 'source-release', 'delete', 'progress']) {
  Deno.test(`lost ${loss} acknowledgement is retried after restart without republishing`, async () => {
    const f = fixture(1)
    if (loss === 'cleanup' || loss === 'source-release') f.faults.add(loss)
    if (loss === 'delete') f.storage.failDelete = true
    if (loss === 'progress') f.storage.failOutputProgress = true
    let failed = false
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await actor(f).alarm() }
      catch (error) { assert.match(String(error), /lost|delete failed/); failed = true; break }
    }
    assert.ok(failed)
    assert.equal((await f.storage.list({ prefix: 'paged:' })).size, 1)
    assert.notEqual(await f.storage.getAlarm(), null)
    if (loss !== 'progress') {
      assert.equal(f.rejects, 0)
      assert.equal((await f.storage.list({ prefix: 'failure:' })).size, 0)
    }
    await finish(f)
    assert.equal(f.publishes, 1)
    assert.equal(f.uploadEffects, 3)
    assert.equal(f.remotes.size, 0)
    assert.equal(f.sourceRetained, false)
    assert.equal(await f.storage.getAlarm(), null)
  })
}

Deno.test('a capture superseded during execution clears its old failure and retains cleanup wake', async () => {
  const f = fixture(0)
  const failure = `failure:${JSON.stringify([capture.generation, capture.identity.name])}`
  await f.storage.put(failure, { ...capture, error: 'prior execution failed' })
  Object.assign(f.db, { computeManifest: () => { f.obsolete(); return Promise.reject(new Error('superseded during execution')) } })
  await assert.rejects(() => actor(f).alarm(), /superseded during execution/)
  assert.equal(f.rejects, 0)
  assert.equal(await f.storage.get(failure), undefined)
  assert.notEqual(await f.storage.getAlarm(), null)
  await actor(f, new MemoryStorage(f.storage.values)).alarm()
  assert.equal(await f.storage.getAlarm(), null)
  assert.equal((await f.storage.list({ prefix: 'paged:' })).size, 0)
  assert.equal(f.publishes, 0)
})

Deno.test('obsolete generations reclaim only their own remote capture and never publish stale output', async () => {
  const f = fixture(260)
  await actor(f).alarm()
  const other = { ...capture, generation: 'generation-2' }
  f.remotes.set(keyOf(other), { ...structuredClone(f.remotes.get(keyOf(capture))!), capture: other })
  f.replaceGeneration()
  await actor(f, new MemoryStorage(f.storage.values)).alarm()
  assert.equal(f.publishes, 0)
  assert.equal(f.remotes.has(keyOf(capture)), false)
  assert.equal(f.remotes.has(keyOf(other)), true)
  assert.equal((await f.storage.list({ prefix: 'paged:' })).size, 0)
  assert.equal(await f.storage.getAlarm(), null)
})

Deno.test('an incomplete output page cannot seal or publish and its durable compute result remains retryable', async () => {
  const f = fixture(0)
  f.incomplete(true)
  let failed = false
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await actor(f).alarm() }
    catch (error) { assert.match(String(error), /output transfer made no progress/); failed = true; break }
  }
  assert.ok(failed)
  assert.equal(f.publishes, 0)
  assert.equal(f.events.includes('seal'), false)
  assert.equal(f.remotes.get(keyOf(capture))!.execution.done, true)
  f.incomplete(false)
  await finish(f)
  assert.equal(f.publishes, 1)
  assert.equal(f.events.filter(event => event === 'step').length, 3)
})

Deno.test('failed garbage collection retains its journal and alarm until deletion succeeds', async () => {
  const f = fixture(40)
  await advancePaged(f.db, f.service, f.storage, capture, owner)
  f.obsolete()
  f.faults.add('cleanup')
  await assert.rejects(() => actor(f).alarm(), /lost cleanup acknowledgement/)
  assert.equal((await f.storage.list({ prefix: 'paged:' })).size, 1)
  assert.ok(await f.storage.getAlarm())
  assert.ok(await f.storage.get('failure'))
  assert.equal(f.rejects, 0)
  assert.deepEqual(await reclaimPaged(f.db, f.service, new MemoryStorage(f.storage.values), owner), [capture])
  assert.equal((await f.storage.list({ prefix: 'paged:' })).size, 0)
  assert.equal(f.remotes.size, 0)
})

Deno.test('partial garbage collection clears each reclaimed failure before a later cleanup can fail', async () => {
  const f = fixture(40)
  await advancePaged(f.db, f.service, f.storage, capture, owner)
  const second = { ...capture, identity: { ...capture.identity, id: 'capture-2', name: 'second' } }
  await f.storage.put(progressKey(second), { owner, capture: second, outputs: {} })
  f.remotes.set(keyOf(second), { ...structuredClone(f.remotes.get(keyOf(capture))!), capture: second })
  const failureKey = (value: ComputeCapture) => `failure:${JSON.stringify([value.generation, value.identity.name])}`
  for (const value of [capture, second]) await f.storage.put(failureKey(value), { ...value, error: 'previous attempt failed' })
  f.obsolete()
  f.faults.add(`cleanup:${keyOf(second)}`)
  await assert.rejects(() => actor(f).alarm(), /lost cleanup/)
  assert.equal(await f.storage.get(progressKey(capture)), undefined)
  assert.equal(await f.storage.get(failureKey(capture)), undefined)
  assert.ok(await f.storage.get(progressKey(second)))
  assert.ok(await f.storage.get(failureKey(second)))
  await actor(f, new MemoryStorage(f.storage.values)).alarm()
  assert.equal((await f.storage.list({ prefix: 'paged:' })).size, 0)
  assert.equal((await f.storage.list({ prefix: 'failure:' })).size, 0)
  assert.equal(f.remotes.size, 0)
})

Deno.test('a new release retains the previous owner and starts its own output transfer', async () => {
  const previous = fixture(0)
  while (!previous.uploadEffects) await advancePaged(previous.db, previous.service, previous.storage, capture, previous.owner)
  const saved = await previous.storage.get(progressKey(capture))
  const current = fixture(0, 'compute-b', previous.storage.values)
  await finish(current)
  assert.equal(current.uploadEffects, 3)
  assert.equal(current.uploadCalls, 3)
  assert.equal(current.remotes.size, 0)
  assert.equal(previous.remotes.size, 1)
  assert.deepEqual(await current.storage.get(progressKey(capture)), saved)
  assert.deepEqual((await actor(current).status()).retainedPaged, [{ key: progressKey(capture), owner, capture }])
  previous.obsolete()
  await actor(previous).alarm()
  assert.equal(previous.remotes.size, 0)
  assert.equal(await previous.storage.get(progressKey(capture)), undefined)
})

Deno.test('ownerless legacy progress remains visible without supplying the current release cursor', async () => {
  const f = fixture(0)
  const key = `paged:${keyOf(capture)}`
  const legacy = { capture, outputs: { sink: { after: 19, chunks: 3, rows: 3, done: true } } }
  await f.storage.put(key, legacy)
  await finish(f)
  assert.equal(f.uploadEffects, 3)
  assert.deepEqual(await f.storage.get(key), legacy)
  assert.deepEqual((await actor(f).status()).retainedPaged, [{ key, owner: null, capture }])
  const unconfigured = new (createCoordinator())({ storage: f.storage }, {})
  assert.deepEqual((await unconfigured.status()).retainedPaged, [{ key, owner: null, capture }])
})

Deno.test('rollback resumes only its own partially uploaded output and retains the newer release', async () => {
  const previous = fixture(0)
  while (!previous.uploadEffects) await advancePaged(previous.db, previous.service, previous.storage, capture, previous.owner)
  const current = fixture(0, 'compute-b', previous.storage.values)
  await advancePaged(current.db, current.service, current.storage, capture, current.owner)
  const currentKey = progressKey(capture, current.owner)
  const saved = await current.storage.get(currentKey)
  await finish(previous)
  assert.equal(previous.uploadEffects, 3)
  assert.equal(previous.uploadCalls, 3)
  assert.deepEqual(await previous.storage.get(currentKey), saved)
  assert.equal(current.remotes.size, 1)
  assert.deepEqual((await actor(previous).status()).retainedPaged, [{ key: currentKey, owner: current.owner, capture }])
})

Deno.test('physical preparation yields between bounded transfer turns without starting queries or rejecting a healthy capture', async () => {
  const f = fixture()
  let prepared = 0
  Object.assign(f.db, { computePrepare: () => Promise.resolve(++prepared > 140) })
  await actor(f).alarm()
  assert.equal(prepared, 128)
  assert.equal(f.events.includes('manifest'), false)
  assert.equal(f.events.includes('reject'), false)
  assert.notEqual(await f.storage.getAlarm(), null)
  await actor(f, new MemoryStorage(f.storage.values)).alarm()
  assert.equal(prepared, 141)
  assert.equal(f.events.includes('manifest'), true)
})

Deno.test('cached manifest survives coordinator restart and avoids repeated Reader and initialization calls', async () => {
  const f = fixture(20)
  for (let i = 0; i < 10; i++) await advancePaged(f.db, f.service, new MemoryStorage(f.storage.values), capture, owner)
  assert.equal(f.events.filter(event => event === 'manifest').length, 1)
  assert.equal(f.events.filter(event => event === 'initialize').length, 1)
  assert.equal(f.events.filter(event => event === 'status').length, 9)
  assert.equal(f.events.filter(event => event === 'append').length, 10)
})

Deno.test('lost initialization acknowledgement retries without saving an unacknowledged manifest', async () => {
  const f = fixture(2)
  f.faults.add('initialize')
  await assert.rejects(advancePaged(f.db, f.service, f.storage, capture, owner), /lost initialize/)
  const first = await f.storage.get<{ manifest?: SnapshotManifest }>(progressKey(capture))
  assert.equal(first?.manifest, undefined)
  await advancePaged(f.db, f.service, new MemoryStorage(f.storage.values), capture, owner)
  await advancePaged(f.db, f.service, new MemoryStorage(f.storage.values), capture, owner)
  assert.equal(f.events.filter(event => event === 'initialize').length, 2)
  assert.equal(f.events.filter(event => event === 'manifest').length, 2)
  assert.equal(f.events.filter(event => event === 'status').length, 1)
})

Deno.test('legacy progress initializes once and subsequent status errors or mismatched artifacts fail loudly', async () => {
  const f = fixture(4)
  await f.storage.put(progressKey(capture), { owner, capture, outputs: {} })
  await advancePaged(f.db, f.service, f.storage, capture, owner)
  f.faults.add('status')
  await assert.rejects(advancePaged(f.db, f.service, f.storage, capture, owner), /lost status/)
  f.faults.add('wrong-manifest')
  await assert.rejects(advancePaged(f.db, f.service, f.storage, capture, owner), /manifest differs/)
  assert.equal(f.events.filter(event => event === 'append').length, 1)
  await advancePaged(f.db, f.service, f.storage, capture, owner)
  assert.equal(f.events.filter(event => event === 'manifest').length, 1)
  assert.equal(f.events.filter(event => event === 'append').length, 2)
})

Deno.test('source transfers reuse acknowledged progress only within an uninterrupted alarm', async () => {
  const f = fixture(10)
  const session = { executing: false }
  for (let i = 0; i < 4; i++) await advancePaged(f.db, f.service, f.storage, capture, owner, session)
  assert.equal(f.events.filter(event => event === 'status').length, 0)
  f.faults.add('append')
  await assert.rejects(advancePaged(f.db, f.service, f.storage, capture, owner, session), /lost append acknowledgement/)
  await advancePaged(f.db, f.service, f.storage, capture, owner, session)
  assert.equal(f.events.filter(event => event === 'status').length, 1)
  assert.equal(f.remotes.get(keyOf(capture))!.sources.get('source'), 6)
  await advancePaged(f.db, f.service, f.storage, capture, owner, { executing: false })
  assert.equal(f.events.filter(event => event === 'status').length, 2)
  assert.equal(f.remotes.get(keyOf(capture))!.sources.get('source'), 7)
})

Deno.test('an invalid append acknowledgement cannot advance the alarm-local cursor', async () => {
  const f = fixture(10)
  const session = { executing: false }
  await advancePaged(f.db, f.service, f.storage, capture, owner, session)
  f.faults.add('wrong-append-cursor')
  await assert.rejects(advancePaged(f.db, f.service, f.storage, capture, owner, session), /append acknowledgement differs/)
  await advancePaged(f.db, f.service, f.storage, capture, owner, session)
  assert.equal(f.events.filter(event => event === 'status').length, 1)
  assert.equal(f.remotes.get(keyOf(capture))!.sources.get('source'), 3)
})

Deno.test('advancePaged applies WAL deltas and falls back to reset-source when WAL is unavailable or mismatched', async () => {
  const f = fixture(2)
  let walMode: 'ok' | 'mismatch' | 'null' = 'ok'
  Object.assign(f.db, {
    computeWal: (_value: ComputeCapture, table: string, fromLsn: number) => Promise.resolve(
      walMode === 'null' ? null : {
        ...capture.identity,
        table,
        fromLsn,
        targetLsn: 5,
        pkColumns: ['id'],
        entries: [{ lsn: 5, op: 'I' as const, row: { id: '1', total: '2' } }],
      },
    ),
  })
  const baseFetch = f.service.fetch
  f.service.fetch = async (input, init) => {
    const req = JSON.parse(String(init!.body)) as PagedRequest
    if (req.action === 'initialize' || req.action === 'status') {
      const res = await baseFetch(input, init)
      const body = await res.json() as Record<string, unknown>
      const remote = f.remotes.get(keyOf(req.capture))!
      if ((remote.sources.get('source') ?? 0) === 0 && !f.events.includes('reset-source') && !f.events.includes('apply-wal')) {
        body.walSources = [{ name: 'source', fromLsn: 1, targetLsn: 5 }]
      }
      return Response.json(body)
    }
    if (req.action === 'apply-wal') {
      f.events.push('apply-wal')
      if (walMode === 'mismatch') {
        return new Response(JSON.stringify({ error: 'replica row count mismatch after WAL apply for source' }), { status: 500 })
      }
      const remote = f.remotes.get(keyOf(req.capture))!
      remote.sources.set('source', 2)
      return Response.json({ next: 2 })
    }
    if (req.action === 'reset-source') {
      f.events.push('reset-source')
      const remote = f.remotes.get(keyOf(req.capture))!
      remote.sources.set('source', 0)
      return Response.json({ next: 0 })
    }
    return await baseFetch(input, init)
  }
  assert.equal(await advancePaged(f.db, f.service, f.storage, capture, owner), 'transfer')
  assert.equal(f.events.includes('apply-wal'), true)
  assert.equal(f.events.includes('reset-source'), false)
  assert.equal(f.remotes.get(keyOf(capture))!.sources.get('source'), 2)

  const f2 = fixture(2)
  walMode = 'mismatch'
  Object.assign(f2.db, { computeWal: f.db.computeWal })
  const baseFetch2 = f2.service.fetch
  f2.service.fetch = async (input, init) => {
    const req = JSON.parse(String(init!.body)) as PagedRequest
    if (req.action === 'initialize') {
      const res = await baseFetch2(input, init)
      const body = await res.json() as Record<string, unknown>
      body.walSources = [{ name: 'source', fromLsn: 1, targetLsn: 5 }]
      return Response.json(body)
    }
    if (req.action === 'apply-wal') {
      f2.events.push('apply-wal')
      return new Response(JSON.stringify({ error: 'replica row count mismatch after WAL apply for source' }), { status: 500 })
    }
    if (req.action === 'reset-source') {
      f2.events.push('reset-source')
      return Response.json({ next: 0 })
    }
    return await baseFetch2(input, init)
  }
  assert.equal(await advancePaged(f2.db, f2.service, f2.storage, capture, owner), 'transfer')
  assert.equal(f2.events.includes('apply-wal'), true)
  assert.equal(f2.events.includes('reset-source'), true)
})
