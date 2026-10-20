// Provider sign-in at the edge: the auth service's oidc.ts answered by the
// cluster's object under wrangler dev, against an OpenID provider of the
// test's own on a local port, as a browser walks it — start, the provider's
// authorization, the callback, the session the terminal adopts — and the
// person it makes, whose rows are theirs. oidc.ts's own tests cover the ways
// a sign-in could be forged; these cover what the edge adds: the links on
// PGlite, the door's origin, and the cookies through the Worker. Needs
// ../pglite-workerd/dist.
import assert from 'node:assert/strict'
import { startWorker } from '../../pglite-workerd/wrangler-dev.ts'
import { load } from '../../pglite-workerd/load.ts'
import { encodeBase64Url } from '../../../services/auth/jwt.ts'
import { sha256url } from '../../../services/auth/oidc.ts'
import { seed } from './seed.ts'

const CLIENT = 'edge-client'
const CLIENT_SECRET = 'edge-client-secret'
const b64 = (s: string) => encodeBase64Url(new TextEncoder().encode(s))

/** An OpenID provider over HTTP that authorizes whoever the test says, at
 * once: the authorization endpoint redirects back with a code. */
async function provider() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' }
  const codes = new Map<string, { redirect: string; challenge: string; nonce: string; sub: string }>()
  let sub = 'alice-sub'
  let issuer = ''
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (req): Promise<Response> => {
    const url = new URL(req.url)
    if (url.pathname === '/.well-known/openid-configuration') {
      return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` })
    }
    if (url.pathname === '/jwks') return Response.json({ keys: [jwk] })
    if (url.pathname === '/authorize') {
      const q = url.searchParams
      if (q.get('client_id') !== CLIENT) return new Response('unknown client', { status: 400 })
      const code = crypto.randomUUID()
      codes.set(code, { redirect: q.get('redirect_uri')!, challenge: q.get('code_challenge')!, nonce: q.get('nonce')!, sub })
      const back = new URL(q.get('redirect_uri')!)
      back.search = new URLSearchParams({ code, state: q.get('state')! }).toString()
      return new Response(null, { status: 302, headers: { location: back.toString() } })
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await req.text())
      const grant = codes.get(form.get('code') ?? '')
      codes.delete(form.get('code') ?? '')
      if (
        !grant || form.get('client_id') !== CLIENT || form.get('client_secret') !== CLIENT_SECRET ||
        form.get('redirect_uri') !== grant.redirect || (await sha256url(form.get('code_verifier') ?? '')) !== grant.challenge
      ) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      const head = b64(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }))
      const body = b64(JSON.stringify({ iss: issuer, aud: CLIENT, sub: grant.sub, name: 'Alice', nonce: grant.nonce, exp: Math.floor(Date.now() / 1000) + 300 }))
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`${head}.${body}`)))
      return Response.json({ id_token: `${head}.${body}.${encodeBase64Url(sig)}` })
    }
    return new Response('not found', { status: 404 })
  })
  issuer = `http://localhost:${server.addr.port}`
  return {
    issuer,
    as(next: string) { sub = next },
    stop: () => server.shutdown(),
  }
}

/** The cookies a response sets, as a browser would send them back. */
const cookiesOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='))

Deno.test({ name: 'a person signs in at the edge through a provider', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  Deno.statSync(new URL('../../pglite-workerd/dist/pglite.wasm', import.meta.url))
  const tmp = await Deno.makeTempDir({ prefix: 'mecha-edge-oidc-' })
  await seed(`${tmp}/pgdata`)
  const idp = await provider()
  const worker = await startWorker(new URL('wrangler.jsonc', import.meta.url), `${tmp}/state`, {
    OIDC_PROVIDERS: 'test',
    OIDC_TEST_ISSUER: idp.issuer,
    OIDC_TEST_CLIENT_ID: CLIENT,
    OIDC_TEST_CLIENT_SECRET: CLIENT_SECRET,
  })
  const at = (path: string) => `${worker.origin}${path}`
  /** A browser's walk from start to the session it adopts. */
  const signIn = async (ret = '/notes') => {
    const start = await fetch(at(`/auth/oidc/test/start?return=${encodeURIComponent(ret)}`), { redirect: 'manual' })
    assert.equal(start.status, 303, await start.text())
    const authorize = new URL(start.headers.get('location')!)
    assert.equal(authorize.searchParams.get('redirect_uri'), at('/auth/oidc/test/callback'))
    const back = await fetch(authorize, { redirect: 'manual' })
    assert.equal(back.status, 302)
    const callback = await fetch(back.headers.get('location')!, { redirect: 'manual', headers: { cookie: cookiesOf(start).join('; ') } })
    assert.equal(callback.status, 303, await callback.text())
    assert.equal(callback.headers.get('location'), ret)
    const cookie = cookiesOf(callback).join('; ')
    const session = await fetch(at('/auth/oidc/session'), { method: 'POST', headers: { cookie, origin: worker.origin } })
    assert.equal(session.status, 200, await session.clone().text())
    return { cookie, ...(await session.json()) as { token: string; user: { id: string; handle: string } } }
  }
  const crud = async (token: string, path: string, init: RequestInit = {}) => {
    const res = await fetch(at(`/crud/${path}`), { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', prefer: 'return=representation' } })
    const text = await res.text()
    assert.ok(res.ok, `${path}: ${res.status} ${text}`)
    return JSON.parse(text)
  }
  try {
    await load(`${tmp}/pgdata`, (route, init) => fetch(at(`/import/${route}`), { ...init, headers: { authorization: 'Bearer test-import' } }), { log: () => {} })

    let alice: Awaited<ReturnType<typeof signIn>>
    await t.step('the provider signs a person in, with a handle as the auth service makes one', async () => {
      alice = await signIn()
      assert.match(alice.user.handle, /^[a-z]+-[a-z]+-\d\d$/)
      const who = await fetch(at('/auth/whoami'), { headers: { authorization: `Bearer ${alice.token}` } })
      assert.deepEqual(await who.json(), { id: alice.user.id, handle: alice.user.handle })
    })
    await t.step("the session is no guest's, and its rows are its own", async () => {
      const [, payload] = alice.token.split('.')
      assert.equal(JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))).guest, false)
      const [note] = await crud(alice.token, 'note', { method: 'POST', body: JSON.stringify({ body: 'da Alice, pelo provedor' }) })
      assert.equal(note.owner, alice.user.id)
    })
    await t.step('signing in again is the same person, and a tab opened later adopts the cookie', async () => {
      const again = await signIn()
      assert.deepEqual(again.user, alice.user)
      assert.equal((await crud(again.token, 'note')).length, 1)
      const later = await fetch(at('/auth/oidc/session'), { method: 'POST', headers: { cookie: alice.cookie } })
      assert.equal(later.status, 200)
    })
    await t.step("another subject is another person, who reads none of Alice's rows", async () => {
      idp.as('bob-sub')
      const bob = await signIn()
      assert.notEqual(bob.user.id, alice.user.id)
      assert.equal((await crud(bob.token, 'note')).length, 0)
    })
    await t.step("a callback without the browser's verifier is refused", async () => {
      const start = await fetch(at('/auth/oidc/test/start'), { redirect: 'manual' })
      await start.body?.cancel()
      const back = await fetch(start.headers.get('location')!, { redirect: 'manual' })
      const callback = await fetch(back.headers.get('location')!, { redirect: 'manual' })
      assert.equal(callback.status, 400)
      assert.deepEqual(await callback.json(), { error: "state is another browser's" })
    })
    await t.step("no table of the auth service's is the app's to read", async () => {
      const res = await fetch(at('/crud/identity_link'), { headers: { authorization: `Bearer ${alice.token}` } })
      await res.body?.cancel()
      assert.ok(!res.ok, `identity_link answered ${res.status}`)
    })
    await t.step('another origin cannot adopt the session, and sign-out clears it', async () => {
      const elsewhere = await fetch(at('/auth/oidc/session'), { method: 'POST', headers: { cookie: alice.cookie, origin: 'https://evil.test' } })
      await elsewhere.body?.cancel()
      assert.equal(elsewhere.status, 403)
      const out = await fetch(at('/auth/oidc/signout'), { method: 'POST', headers: { origin: worker.origin } })
      await out.body?.cancel()
      assert.equal(out.status, 204)
      assert.ok(out.headers.getSetCookie().every((c) => c.includes('Max-Age=0')))
    })
    await t.step('a provider no setting names is no route', async () => {
      const res = await fetch(at('/auth/oidc/google/start'), { redirect: 'manual' })
      await res.body?.cancel()
      assert.equal(res.status, 404)
    })
  } finally {
    await worker.stop()
    await idp.stop()
  }
})
