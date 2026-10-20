// Passkeys at the edge: the auth service's ceremonies (passkey.ts) answered by
// the cluster's object under wrangler dev, with a passkey made as a browser
// makes one for the Worker's own door — a new account, a guest promoted with
// its rows, and either signed in again elsewhere. main_test.ts covers the
// ceremonies' refusals; these cover what the edge adds: the credentials on
// PGlite, the door as the relying party, and @simplewebauthn on workerd.
// Needs ../pglite-workerd/dist and `npm ci` here.
import assert from 'node:assert/strict'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { load } from '../../pglite-workerd/load.ts'
import { testPasskey } from '../../../services/auth/passkey_testing.ts'
import { seed } from './seed.ts'

type Session = { token: string; user: { id: string; handle: string } }

Deno.test({ name: "a person signs in at the edge with a passkey for the Worker's door", sanitizeResources: false, sanitizeOps: false }, async (t) => {
  Deno.statSync(new URL('../../pglite-workerd/dist/pglite.wasm', import.meta.url))
  Deno.statSync(new URL('../node_modules/@simplewebauthn/server', import.meta.url))
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-passkey-' })
  await seed(`${tmp}/pgdata`)
  const worker = await startWorker(new URL('wrangler.jsonc', import.meta.url), `${tmp}/state`)
  const { origin } = worker
  const rpId = new URL(origin).hostname
  const at = (path: string) => `${origin}${path}`
  const post = async (path: string, body: unknown, token?: string) => {
    const res = await fetch(at(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
  const register = async (key: Awaited<ReturnType<typeof testPasskey>>, token?: string) => {
    const start = await post('/auth/register/start', {}, token)
    assert.equal(start.status, 200, JSON.stringify(start.body))
    assert.equal(start.body.rp.id, rpId)
    return post('/auth/register/verify', { state: start.body.state, response: key.register(start.body.challenge, origin) })
  }
  const login = async (key: Awaited<ReturnType<typeof testPasskey>>, doorOrigin = origin) => {
    const start = await post('/auth/login/start', {})
    assert.equal(start.status, 200, JSON.stringify(start.body))
    return post('/auth/login/verify', { state: start.body.state, response: await key.login(start.body.challenge, doorOrigin) })
  }
  const crud = async (token: string, path: string, init: RequestInit = {}) => {
    const res = await fetch(at(`/crud/${path}`), { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', prefer: 'return=representation' } })
    const text = await res.text()
    assert.ok(res.ok, `${path}: ${res.status} ${text}`)
    return JSON.parse(text)
  }
  try {
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: 'Bearer test-import' } }), { log: () => {} })

    await t.step('a new passkey makes an account, which the passkey signs into again', async () => {
      const key = await testPasskey(rpId)
      const made = await register(key)
      assert.equal(made.status, 200, JSON.stringify(made.body))
      const account = made.body as Session
      assert.match(account.user.handle, /^[a-z]+-[a-z]+-\d\d$/)
      const [note] = await crud(account.token, 'note', { method: 'POST', body: JSON.stringify({ body: 'da conta' }) })
      assert.equal(note.owner, account.user.id)
      const again = await login(key)
      assert.equal(again.status, 200, JSON.stringify(again.body))
      assert.deepEqual(again.body.user, account.user)
      assert.equal((await crud(again.body.token, 'note')).length, 1)
    })
    await t.step("a guest's passkey keeps the guest and every row it wrote, once", async () => {
      const guest = (await (await fetch(at('/auth/guest'), { method: 'POST' })).json()) as Session
      await crud(guest.token, 'note', { method: 'POST', body: JSON.stringify({ body: 'do convidado' }) })
      const key = await testPasskey(rpId)
      const promoted = await register(key, guest.token)
      assert.equal(promoted.status, 200, JSON.stringify(promoted.body))
      assert.equal(promoted.body.user.id, guest.user.id)
      const signedIn = await login(key)
      assert.equal(signedIn.body.user.id, guest.user.id)
      assert.deepEqual((await crud(signedIn.body.token, 'note')).map((n: { body: string }) => n.body), ['do convidado'])
      // The guest's token outlives its promotion, and adds no second passkey.
      const second = await register(await testPasskey(rpId), guest.token)
      assert.equal(second.status, 409)
    })
    await t.step('an account is not given a second passkey on the strength of its token', async () => {
      const account = (await register(await testPasskey(rpId))).body as Session
      const start = await post('/auth/register/start', {}, account.token)
      assert.equal(start.status, 409)
    })
    await t.step("a ceremony made on another origin, or by an unknown passkey, signs nobody in", async () => {
      const key = await testPasskey(rpId)
      assert.equal((await register(key)).status, 200)
      assert.equal((await login(key, 'https://evil.example')).status, 401)
      assert.equal((await login(await testPasskey(rpId))).status, 401)
    })
    await t.step("no table of the auth service's is the app's to read", async () => {
      const guest = (await (await fetch(at('/auth/guest'), { method: 'POST' })).json()) as Session
      const res = await fetch(at('/crud/webauthn_credential'), { headers: { authorization: `Bearer ${guest.token}` } })
      await res.body?.cancel()
      assert.ok(!res.ok, `webauthn_credential answered ${res.status}`)
    })
  } finally {
    await worker.stop()
  }
})
