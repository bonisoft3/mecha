import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { isoBase64URL, isoCBOR, isoUint8Array, toHash } from '@simplewebauthn/server/helpers'
import { encodeBase64Url, randomToken, signJwt, verifyJwt } from '../../../services/auth/jwt.ts'
import { providersFrom, SESSION_COOKIE, sha256url, STATE_COOKIE } from '../../../services/auth/oidc.ts'
import { createEdgeCluster } from '../src/cluster.ts'

type Cbor = Parameters<typeof isoCBOR.encode>[0]
type CeremonyStart = { challenge: string; state: string }
type AuthSession = { token: string; refresh_token: string; user: { id: string; handle: string; guest?: boolean; name?: string; email?: string } }

async function makePasskey(rpId = 'test.local') {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const id = crypto.getRandomValues(new Uint8Array(16))
  const rpIdHash = await toHash(isoUint8Array.fromUTF8String(rpId))
  const b64 = (bytes: Uint8Array) => isoBase64URL.fromBuffer(bytes)
  const clientData = (type: string, challenge: string, origin: string) =>
    isoUint8Array.fromUTF8String(JSON.stringify({ type, challenge, origin, crossOrigin: false }))

  const der = (sig: Uint8Array) => {
    const int = (n: Uint8Array) => {
      let i = 0
      while (i < n.length - 1 && n[i] === 0) i++
      const v = n[i] & 0x80 ? [0, ...n.slice(i)] : [...n.slice(i)]
      return [0x02, v.length, ...v]
    }
    const body = [...int(sig.slice(0, 32)), ...int(sig.slice(32))]
    return new Uint8Array([0x30, body.length, ...body])
  }

  return {
    register(challenge: string, origin: string) {
      const key = isoCBOR.encode(
        new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33)]]),
      )
      const authData = isoUint8Array.concat([
        rpIdHash,
        new Uint8Array([0x41, 0, 0, 0, 0]),
        new Uint8Array(16),
        new Uint8Array([0, id.length]),
        id,
        key,
      ])
      const attestation = isoCBOR.encode(
        new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]),
      )
      return {
        id: b64(id),
        rawId: b64(id),
        type: 'public-key',
        response: { clientDataJSON: b64(clientData('webauthn.create', challenge, origin)), attestationObject: b64(attestation) },
        clientExtensionResults: {},
      }
    },
    async login(challenge: string, origin: string) {
      const authData = isoUint8Array.concat([rpIdHash, new Uint8Array([0x01, 0, 0, 0, 1])])
      const data = clientData('webauthn.get', challenge, origin)
      const signed = isoUint8Array.concat([authData, await toHash(data)])
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new Uint8Array(signed)))
      return {
        id: b64(id),
        rawId: b64(id),
        type: 'public-key',
        response: { clientDataJSON: b64(data), authenticatorData: b64(authData), signature: b64(der(sig)) },
        clientExtensionResults: {},
      }
    },
  }
}

Deno.test({
  name: 'mecha-edge passkey registration, promotion and authentication',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origin = 'https://test.local'
    const rpId = 'test.local'
    const secret = 'edge-auth-secret'
    const db = await PGlite.create()
    try {
      await db.exec(await Deno.readTextFile(new URL('../../../services/database/rls/rls.sql', import.meta.url)))
      await db.exec(await Deno.readTextFile(new URL('fixture.sql', import.meta.url)))
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;')

      const cluster = await createEdgeCluster({
        db,
        tables: ['note', 'board'],
        secret,
        origin,
        rpId,
        log: (line) => { console.error('CLUSTER LOG:', line) },
        fail: (e) => { throw e },
      })

      // 1. Fresh passkey registration (without prior guest)
      const freshPasskey = await makePasskey(rpId)
      const regStartRes = await cluster.handle(new Request(`${origin}/auth/register/start`, { method: 'POST' }))
      assert.equal(regStartRes.status, 200)
      const regStart = (await regStartRes.json()) as CeremonyStart
      assert.ok(regStart.challenge)
      assert.ok(regStart.state)

      const regVerifyRes = await cluster.handle(
        new Request(`${origin}/auth/register/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            state: regStart.state,
            response: freshPasskey.register(regStart.challenge, origin),
          }),
        }),
      )
      assert.equal(regVerifyRes.status, 200)
      const regVerified = (await regVerifyRes.json()) as AuthSession
      assert.ok(regVerified.token)
      assert.ok(regVerified.refresh_token)
      assert.equal((await verifyJwt(secret, regVerified.token))?.guest, false)
      assert.ok(regVerified.user?.id)
      assert.ok(regVerified.user?.handle)

      // 2. Authentication with the registered passkey
      const loginStartRes = await cluster.handle(new Request(`${origin}/auth/login/start`, { method: 'POST' }))
      assert.equal(loginStartRes.status, 200)
      const loginStart = (await loginStartRes.json()) as CeremonyStart
      assert.ok(loginStart.challenge)
      assert.ok(loginStart.state)

      const loginVerifyRes = await cluster.handle(
        new Request(`${origin}/auth/login/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            state: loginStart.state,
            response: await freshPasskey.login(loginStart.challenge, origin),
          }),
        }),
      )
      assert.equal(loginVerifyRes.status, 200)
      const loggedIn = (await loginVerifyRes.json()) as AuthSession
      assert.equal(loggedIn.user.id, regVerified.user.id)
      assert.ok(loggedIn.refresh_token)
      assert.equal((await verifyJwt(secret, loggedIn.token))?.guest, false)
      assert.equal(loggedIn.user.handle, regVerified.user.handle)

      // 3. Guest minting and promotion to passkey
      const guestRes = await cluster.handle(new Request(`${origin}/auth/guest`, { method: 'POST' }))
      assert.equal(guestRes.status, 200)
      const guest = (await guestRes.json()) as AuthSession
      assert.ok(guest.token)
      assert.ok(guest.refresh_token)
      assert.ok(guest.user.guest)

      const promoPasskey = await makePasskey(rpId)
      const promoStartRes = await cluster.handle(
        new Request(`${origin}/auth/register/start`, {
          method: 'POST',
          headers: { authorization: `Bearer ${guest.token}` },
        }),
      )
      assert.equal(promoStartRes.status, 200)
      const promoStart = (await promoStartRes.json()) as CeremonyStart

      const promoVerifyRes = await cluster.handle(
        new Request(`${origin}/auth/register/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            state: promoStart.state,
            response: promoPasskey.register(promoStart.challenge, origin),
          }),
        }),
      )
      assert.equal(promoVerifyRes.status, 200)
      const promoted = (await promoVerifyRes.json()) as AuthSession
      assert.equal((await verifyJwt(secret, promoted.token))?.guest, false)
      // Retains guest ID and handle
      assert.equal(promoted.user.id, guest.user.id)
      assert.equal(promoted.user.handle, guest.user.handle)

      // 4. Login with promoted passkey succeeds
      const promoLoginStartRes = await cluster.handle(new Request(`${origin}/auth/login/start`, { method: 'POST' }))
      const promoLoginStart = (await promoLoginStartRes.json()) as CeremonyStart
      const promoLoginVerifyRes = await cluster.handle(
        new Request(`${origin}/auth/login/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            state: promoLoginStart.state,
            response: await promoPasskey.login(promoLoginStart.challenge, origin),
          }),
        }),
      )
      assert.equal(promoLoginVerifyRes.status, 200)
      const promoLoggedIn = (await promoLoginVerifyRes.json()) as AuthSession
      assert.equal(promoLoggedIn.user.id, guest.user.id)

      // 5. Already promoted / non-guest account cannot re-register
      const blockedStartRes = await cluster.handle(
        new Request(`${origin}/auth/register/start`, {
          method: 'POST',
          headers: { authorization: `Bearer ${promoted.token}` },
        }),
      )
      assert.equal(blockedStartRes.status, 409)

      // 6. Expired or malformed bearer on register/start returns 401
      const expiredToken = await signJwt(secret, {
        role: 'app_user',
        sub: crypto.randomUUID(),
        handle: 'expired',
        guest: true,
        exp: Math.floor(Date.now() / 1000) - 3600,
      })
      const expiredStartRes = await cluster.handle(
        new Request(`${origin}/auth/register/start`, {
          method: 'POST',
          headers: { authorization: `Bearer ${expiredToken}` },
        }),
      )
      assert.equal(expiredStartRes.status, 401)

      const garbageStartRes = await cluster.handle(
        new Request(`${origin}/auth/register/start`, {
          method: 'POST',
          headers: { authorization: 'Bearer totally-garbage-token' },
        }),
      )
      assert.equal(garbageStartRes.status, 401)

      // 7. Purpose mismatch on state token is rejected
      const mismatchRegRes = await cluster.handle(
        new Request(`${origin}/auth/register/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            state: promoLoginStart.state,
            response: promoPasskey.register(promoLoginStart.challenge, origin),
          }),
        }),
      )
      assert.equal(mismatchRegRes.status, 401)

      const mismatchLoginRes = await cluster.handle(
        new Request(`${origin}/auth/login/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            state: promoStart.state,
            response: await promoPasskey.login(promoStart.challenge, origin),
          }),
        }),
      )
      assert.equal(mismatchLoginRes.status, 401)

      // 8. Re-promoting already promoted guest account returns 409
      const rePromoPasskey = await makePasskey(rpId)
      const fakePromoState = await signJwt(secret, {
        purpose: 'register',
        handle: guest.user.handle,
        userId: guest.user.id,
        promote: true,
        challenge: 'dummy-challenge',
        exp: Math.floor(Date.now() / 1000) + 300,
      })
      const rePromoVerifyRes = await cluster.handle(
        new Request(`${origin}/auth/register/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            state: fakePromoState,
            response: rePromoPasskey.register('dummy-challenge', origin),
          }),
        }),
      )
      assert.equal(rePromoVerifyRes.status, 409)

      // 9. webauthn_credential is not accessible via PostgREST /crud
      const credReadRes = await cluster.handle(
        new Request(`${origin}/crud/webauthn_credential`, {
          headers: { authorization: `Bearer ${promoted.token}` },
        }),
      )
      assert.notEqual(credReadRes.status, 200)
      assert.ok(credReadRes.status >= 400)

      const credWriteRes = await cluster.handle(
        new Request(`${origin}/crud/webauthn_credential`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${promoted.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            id: 'attacker-id',
            user_id: guest.user.id,
            public_key: 'AAAA',
          }),
        }),
      )
      assert.notEqual(credWriteRes.status, 200)
      assert.notEqual(credWriteRes.status, 201)
      assert.ok(credWriteRes.status >= 400)
      // The passkeys live in mecha_auth, which no app role may use; public
      // keeps only a security_invoker view of the old name.
      const placed = await db.query<{ nspname: string; relkind: string; reloptions: string[] | null }>(
        `SELECT n.nspname, c.relkind, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'webauthn_credential' ORDER BY 1`,
      )
      assert.deepEqual(placed.rows, [
        { nspname: 'mecha_auth', relkind: 'r', reloptions: null },
        { nspname: 'public', relkind: 'v', reloptions: ['security_invoker=true'] },
      ])
      const reach = await db.query<{ usable: boolean }>(`SELECT has_schema_privilege('app_user', 'mecha_auth', 'USAGE') AS usable`)
      assert.equal(reach.rows[0].usable, false)
      const exempt = await db.query(`SELECT 1 FROM mecha.rls_exempt WHERE table_name = 'mecha_auth.webauthn_credential'`)
      assert.equal(exempt.rows.length, 1)

      // 10. Invalid verification responses fail with 401
      const badVerifyRes = await cluster.handle(
        new Request(`${origin}/auth/register/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: 'garbage', response: {} }),
        }),
      )
      assert.equal(badVerifyRes.status, 401)
    } finally {
      await db.close()
    }
  },
})

// A release before mecha_auth made the table in public, where an app's grants
// reached it: the next start moves it with its passkeys and none of those
// grants, and a passkey registered then still signs in.
Deno.test({
  name: 'mecha-edge moves an earlier release\'s passkey table out of public with its rows',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origin = 'https://test.local'
    const rpId = 'test.local'
    const secret = 'edge-auth-secret'
    const db = await PGlite.create()
    try {
      await db.exec(await Deno.readTextFile(new URL('../../../services/database/rls/rls.sql', import.meta.url)))
      await db.exec(await Deno.readTextFile(new URL('fixture.sql', import.meta.url)))
      const config = { db, tables: ['note', 'board'], secret, origin, rpId, log: () => {}, fail: (e: unknown) => { throw e } }
      const first = await createEdgeCluster(config)
      const passkey = await makePasskey(rpId)
      const start = (await (await first.handle(new Request(`${origin}/auth/register/start`, { method: 'POST' }))).json()) as CeremonyStart
      const registered = await first.handle(new Request(`${origin}/auth/register/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: start.state, response: passkey.register(start.challenge, origin) }),
      }))
      assert.equal(registered.status, 200)
      const user = ((await registered.json()) as AuthSession).user
      // The layout an earlier release left: the table in public, granted to app_user.
      await db.exec(`
        DROP VIEW public.webauthn_credential;
        ALTER TABLE mecha_auth.webauthn_credential SET SCHEMA public;
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.webauthn_credential TO app_user;
      `)

      const next = await createEdgeCluster(config)
      const login = (await (await next.handle(new Request(`${origin}/auth/login/start`, { method: 'POST' }))).json()) as CeremonyStart
      const signedIn = await next.handle(new Request(`${origin}/auth/login/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: login.state, response: await passkey.login(login.challenge, origin) }),
      }))
      assert.equal(signedIn.status, 200)
      assert.equal(((await signedIn.json()) as AuthSession).user.id, user.id)
      const after = await db.query<{ table: string | null; view: string; granted: boolean; rows: number }>(
        `SELECT to_regclass('mecha_auth.webauthn_credential')::text AS table,
                (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('public.webauthn_credential')) AS view,
                has_table_privilege('app_user', 'mecha_auth.webauthn_credential', 'SELECT, INSERT, UPDATE, DELETE') AS granted,
                (SELECT count(*)::int FROM mecha_auth.webauthn_credential WHERE user_id = $1) AS rows`,
        [user.id],
      )
      assert.deepEqual(after.rows[0], { table: 'mecha_auth.webauthn_credential', view: 'v', granted: false, rows: 1 })
    } finally {
      await db.close()
    }
  },
})

Deno.test({
  name: 'mecha-edge OIDC provider sign-in, session exchange, sign-out and sealed identity_link',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origin = 'https://test.local'
    const issuer = 'https://accounts.google.com'
    const secret = 'edge-auth-secret'
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' }
    const codes = new Map<string, { client: string; redirect: string; challenge: string; nonce: string }>()
    let profileName = 'Alice'
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        })
      }
      if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] })
      if (url === `${issuer}/token`) {
        const form = new URLSearchParams(String(init?.body))
        const grant = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        if (!grant || (await sha256url(form.get('code_verifier') ?? '')) !== grant.challenge) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        const b64 = (s: string) => encodeBase64Url(new TextEncoder().encode(s))
        const head = b64(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }))
        const body = b64(JSON.stringify({
          iss: issuer,
          aud: grant.client,
          sub: 'google-sub-1',
          name: profileName,
          picture: 'https://pics.test/alice.png',
          email: 'alice@example.test',
          email_verified: true,
          nonce: grant.nonce,
          exp: Math.floor(Date.now() / 1000) + 300,
        }))
        const sig = new Uint8Array(
          await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`${head}.${body}`)),
        )
        return Response.json({ id_token: `${head}.${body}.${encodeBase64Url(sig)}` })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    const db = await PGlite.create()
    try {
      await db.exec(await Deno.readTextFile(new URL('../../../services/database/rls/rls.sql', import.meta.url)))
      await db.exec(await Deno.readTextFile(new URL('fixture.sql', import.meta.url)))
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;')

      const providers = providersFrom((k) => ({
        OIDC_PROVIDERS: 'google',
        OIDC_GOOGLE_CLIENT_ID: 'origin',
      }[k]))
      const cluster = await createEdgeCluster({
        db,
        tables: ['note', 'board'],
        secret,
        origin,
        providers,
        fetcher,
        log: (line) => { console.error('CLUSTER LOG:', line) },
        fail: (e) => { throw e },
      })

      const startRes = await cluster.handle(new Request(`${origin}/auth/oidc/google/start?return=%2Fexplore`))
      assert.equal(startRes.status, 303)
      const authorizeUrl = new URL(startRes.headers.get('location')!)
      assert.equal(authorizeUrl.origin + authorizeUrl.pathname, `${issuer}/authorize`)
      assert.equal(authorizeUrl.searchParams.get('client_id'), origin)
      const stateCookie = startRes.headers.get('set-cookie')!.split(';')[0]
      assert.ok(stateCookie.startsWith(`${STATE_COOKIE}=`))
      const code = crypto.randomUUID()
      codes.set(code, {
        client: authorizeUrl.searchParams.get('client_id')!,
        redirect: authorizeUrl.searchParams.get('redirect_uri')!,
        challenge: authorizeUrl.searchParams.get('code_challenge')!,
        nonce: authorizeUrl.searchParams.get('nonce')!,
      })

      const cbRes = await cluster.handle(
        new Request(`${origin}/auth/oidc/google/callback?code=${code}&state=${encodeURIComponent(authorizeUrl.searchParams.get('state')!)}`, {
          headers: { cookie: stateCookie },
        }),
      )
      assert.equal(cbRes.status, 303)
      assert.equal(cbRes.headers.get('location'), '/explore')
      const sessionCookie = cbRes.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0]

      const sessionRes = await cluster.handle(
        new Request(`${origin}/auth/oidc/session`, {
          method: 'POST',
          headers: { cookie: sessionCookie },
        }),
      )
      assert.equal(sessionRes.status, 200)
      const session = (await sessionRes.json()) as { token: string; user: { id: string; handle: string } }
      assert.ok(session.token)
      assert.ok(session.user.id)

      // Repeat sign-in updates profile and preserves user_id
      profileName = 'Alice Updated'
      const start2 = await cluster.handle(new Request(`${origin}/auth/oidc/google/start`))
      const authUrl2 = new URL(start2.headers.get('location')!)
      const stateCookie2 = start2.headers.get('set-cookie')!.split(';')[0]
      const code2 = crypto.randomUUID()
      codes.set(code2, {
        client: authUrl2.searchParams.get('client_id')!,
        redirect: authUrl2.searchParams.get('redirect_uri')!,
        challenge: authUrl2.searchParams.get('code_challenge')!,
        nonce: authUrl2.searchParams.get('nonce')!,
      })
      const cb2 = await cluster.handle(
        new Request(`${origin}/auth/oidc/google/callback?code=${code2}&state=${encodeURIComponent(authUrl2.searchParams.get('state')!)}`, {
          headers: { cookie: stateCookie2 },
        }),
      )
      const sessionCookie2 = cb2.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0]
      const session2 = (await (await cluster.handle(new Request(`${origin}/auth/oidc/session`, { method: 'POST', headers: { cookie: sessionCookie2 } }))).json()) as { user: { id: string } }
      assert.equal(session2.user.id, session.user.id)
      const stored = await db.query<{ name: string; email: string }>('SELECT name, email FROM mecha_auth.identity_link WHERE user_id = $1', [session.user.id])
      assert.equal(stored.rows[0].name, 'Alice Updated')
      assert.equal(stored.rows[0].email, 'alice@example.test')
      // The session the terminal adopts carries both, for the chrome and the checkout.
      assert.equal((session2.user as { name?: string }).name, 'Alice Updated')
      assert.equal((session2.user as { email?: string }).email, 'alice@example.test')

      // mecha_auth.identity_link is sealed from app_user in DB privileges and exempt from RLS audit
      const privs = await db.query<{ schema_ok: boolean; table_ok: boolean; exempt: boolean }>(
        `SELECT has_schema_privilege('app_user', 'mecha_auth', 'USAGE') AS schema_ok,
                has_table_privilege('app_user', 'mecha_auth.identity_link', 'SELECT') AS table_ok,
                EXISTS (SELECT 1 FROM mecha.rls_exempt WHERE table_name = 'mecha_auth.identity_link') AS exempt`,
      )
      assert.equal(privs.rows[0].schema_ok, false)
      assert.equal(privs.rows[0].table_ok, false)
      assert.equal(privs.rows[0].exempt, true)

      const signoutRes = await cluster.handle(new Request(`${origin}/auth/oidc/signout`, { method: 'POST' }))
      assert.equal(signoutRes.status, 204)
      const cleared = signoutRes.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=;`))
      assert.ok(cleared?.includes('Max-Age=0'))
      const clearedCookie = cleared!.split(';')[0]
      const afterSignout = await cluster.handle(
        new Request(`${origin}/auth/oidc/session`, { method: 'POST', headers: { cookie: clearedCookie } }),
      )
      assert.equal(afterSignout.status, 401)
    } finally {
      await db.close()
    }
  },
})

Deno.test({
  name: 'mecha-edge Android APK WebAuthn origins, native OIDC PKCE + guest adoption, rotating refresh, and account deletion',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const origin = 'https://test.local'
    const rpId = 'test.local'
    const issuer = 'https://accounts.google.com'
    const secret = 'edge-auth-secret'
    const apkHash = await sha256url('snapcards-android-signing-cert')
    const unlistedHash = await sha256url('other-android-signing-cert')
    const apkOrigin = `android:apk-key-hash:${apkHash}`

    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' }
    const codes = new Map<string, { client: string; redirect: string; challenge: string; nonce: string }>()
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        })
      }
      if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] })
      if (url === `${issuer}/token`) {
        const form = new URLSearchParams(String(init?.body))
        const grant = codes.get(form.get('code') ?? '')
        codes.delete(form.get('code') ?? '')
        if (!grant || (await sha256url(form.get('code_verifier') ?? '')) !== grant.challenge) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        const b64 = (s: string) => encodeBase64Url(new TextEncoder().encode(s))
        const head = b64(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }))
        const body = b64(JSON.stringify({
          iss: issuer,
          aud: grant.client,
          sub: 'edge-native-sub-1',
          name: 'Edge Alice',
          email: 'edge.alice@example.test',
          email_verified: true,
          nonce: grant.nonce,
          exp: Math.floor(Date.now() / 1000) + 300,
        }))
        const sig = new Uint8Array(
          await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(`${head}.${body}`)),
        )
        return Response.json({ id_token: `${head}.${body}.${encodeBase64Url(sig)}` })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    const db = await PGlite.create()
    try {
      await db.exec(await Deno.readTextFile(new URL('../../../services/database/rls/rls.sql', import.meta.url)))
      await db.exec(await Deno.readTextFile(new URL('fixture.sql', import.meta.url)))
      await db.exec(`
        CREATE TABLE deck (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          owner uuid NOT NULL DEFAULT auth_uid() REFERENCES app_user(id) ON DELETE CASCADE,
          title text NOT NULL,
          scope_id text GENERATED ALWAYS AS ('user:' || owner) STORED NOT NULL
        );
        CALL rls_protect('deck');
        CREATE POLICY own_deck ON deck FOR ALL USING (owner = auth_uid()) WITH CHECK (owner = auth_uid());
        GRANT SELECT, INSERT, UPDATE, DELETE ON deck TO app_user;
      `)

      const providers = providersFrom((k) => ({ OIDC_PROVIDERS: 'google', OIDC_GOOGLE_CLIENT_ID: 'origin' }[k]))
      const cluster = await createEdgeCluster({
        db,
        tables: ['note', 'board', 'deck'],
        secret,
        origin,
        rpId,
        androidApkKeyHashes: apkHash,
        nativeSchemes: 'snapcards',
        providers,
        fetcher,
        log: (line) => { console.error('CLUSTER LOG:', line) },
        fail: (e) => { throw e },
      })

      // 1. Android APK key hash WebAuthn registration + login
      const androidPasskey = await makePasskey(rpId)
      const regStart = (await (await cluster.handle(new Request(`${origin}/auth/register/start`, { method: 'POST' }))).json()) as CeremonyStart
      const unlistedReg = await cluster.handle(
        new Request(`${origin}/auth/register/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: regStart.state, response: androidPasskey.register(regStart.challenge, `android:apk-key-hash:${unlistedHash}`) }),
        }),
      )
      assert.equal(unlistedReg.status, 401)

      const androidRegRes = await cluster.handle(
        new Request(`${origin}/auth/register/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: regStart.state, response: androidPasskey.register(regStart.challenge, apkOrigin) }),
        }),
      )
      assert.equal(androidRegRes.status, 200)
      const androidReg = (await androidRegRes.json()) as AuthSession

      const loginStart = (await (await cluster.handle(new Request(`${origin}/auth/login/start`, { method: 'POST' }))).json()) as CeremonyStart
      const androidLoginRes = await cluster.handle(
        new Request(`${origin}/auth/login/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: loginStart.state, response: await androidPasskey.login(loginStart.challenge, apkOrigin) }),
        }),
      )
      assert.equal(androidLoginRes.status, 200)
      assert.equal(((await androidLoginRes.json()) as AuthSession).user.id, androidReg.user.id)

      // 2. Native OIDC PKCE ticket flow + guest promotion + account merge
      const runNativeOidc = async (extraQuery = '') => {
        const verifier = randomToken(32)
        const challenge = await sha256url(verifier)
        const startRes = await cluster.handle(
          new Request(`${origin}/auth/oidc/google/start?return=native&code_challenge=${challenge}${extraQuery}`),
        )
        assert.equal(startRes.status, 303)
        assert.deepEqual(startRes.headers.getSetCookie(), [])
        const authUrl = new URL(startRes.headers.get('location')!)
        const code = crypto.randomUUID()
        codes.set(code, {
          client: authUrl.searchParams.get('client_id')!,
          redirect: authUrl.searchParams.get('redirect_uri')!,
          challenge: authUrl.searchParams.get('code_challenge')!,
          nonce: authUrl.searchParams.get('nonce')!,
        })
        const cbRes = await cluster.handle(
          new Request(`${origin}/auth/oidc/google/callback?code=${code}&state=${encodeURIComponent(authUrl.searchParams.get('state')!)}`),
        )
        assert.equal(cbRes.status, 303)
        const loc = new URL(cbRes.headers.get('location')!)
        assert.equal(`${loc.protocol}//${loc.host}${loc.pathname}`, 'snapcards://auth/callback')
        return { ticket: loc.searchParams.get('ticket')!, verifier }
      }

      const guest1 = (await (await cluster.handle(new Request(`${origin}/auth/guest`, { method: 'POST' }))).json()) as AuthSession
      await cluster.handle(new Request(`${origin}/crud/deck`, {
        method: 'POST',
        headers: { authorization: `Bearer ${guest1.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'First Guest Deck' }),
      }))

      const native1 = await runNativeOidc(`&promote_token=${encodeURIComponent(guest1.token)}`)
      const session1Res = await cluster.handle(new Request(`${origin}/auth/oidc/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: native1.ticket, code_verifier: native1.verifier }),
      }))
      assert.equal(session1Res.status, 200)
      const session1 = (await session1Res.json()) as AuthSession
      assert.equal(session1.user.id, guest1.user.id)
      assert.equal(session1.user.name, 'Edge Alice')

      // Second guest writes a note (DEFAULT auth_uid()) and a deck, then signs into the same OIDC account -> merged!
      const guest2 = (await (await cluster.handle(new Request(`${origin}/auth/guest`, { method: 'POST' }))).json()) as AuthSession
      await cluster.handle(new Request(`${origin}/crud/note`, {
        method: 'POST',
        headers: { authorization: `Bearer ${guest2.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'offline guest note' }),
      }))
      await cluster.handle(new Request(`${origin}/crud/deck`, {
        method: 'POST',
        headers: { authorization: `Bearer ${guest2.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Second Guest Deck' }),
      }))
      const native2 = await runNativeOidc(`&promote_token=${encodeURIComponent(guest2.token)}`)
      const session2 = (await (await cluster.handle(new Request(`${origin}/auth/oidc/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: native2.ticket, code_verifier: native2.verifier }),
      }))).json()) as AuthSession
      assert.equal(session2.user.id, guest1.user.id)

      const mergedDecks = (await (await cluster.handle(new Request(`${origin}/crud/deck?select=title&order=title.asc`, {
        headers: { authorization: `Bearer ${session2.token}` },
      }))).json()) as Array<{ title: string }>
      assert.deepEqual(mergedDecks.map((d) => d.title), ['First Guest Deck', 'Second Guest Deck'])
      const mergedNotes = (await (await cluster.handle(new Request(`${origin}/crud/note?select=body`, {
        headers: { authorization: `Bearer ${session2.token}` },
      }))).json()) as Array<{ body: string }>
      assert.deepEqual(mergedNotes.map((n) => n.body), ['offline guest note'])

      // 3. Rotating POST /auth/refresh + replay family revocation
      const rot1Res = await cluster.handle(new Request(`${origin}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: session2.refresh_token }),
      }))
      assert.equal(rot1Res.status, 200)
      const rot1 = (await rot1Res.json()) as AuthSession
      assert.equal(rot1.user.id, guest1.user.id)
      assert.notEqual(rot1.refresh_token, session2.refresh_token)

      // Replaying session2.refresh_token revokes the family so rot1.refresh_token is also dead.
      const replayRes = await cluster.handle(new Request(`${origin}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: session2.refresh_token }),
      }))
      assert.equal(replayRes.status, 401)
      const revokedChild = await cluster.handle(new Request(`${origin}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: rot1.refresh_token }),
      }))
      assert.equal(revokedChild.status, 401)

      // 4. DELETE /auth/account cascades credentials, links, refresh tokens, and ON DELETE CASCADE rows
      const delRes = await cluster.handle(new Request(`${origin}/auth/account`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${rot1.token}` },
      }))
      assert.equal(delRes.status, 200)
      assert.deepEqual(await delRes.json(), { deleted: true })
      const remainingDecks = await db.query('SELECT 1 FROM deck WHERE owner = $1', [guest1.user.id])
      assert.equal(remainingDecks.rows.length, 0)
      const remainingLinks = await db.query('SELECT 1 FROM mecha_auth.identity_link WHERE user_id = $1', [guest1.user.id])
      assert.equal(remainingLinks.rows.length, 0)

      // Auth tables and compatibility views pass rls_unprotected with zero flags
      const unprotected = await db.query(
        `SELECT * FROM mecha.rls_unprotected
         WHERE table_name LIKE 'mecha_auth.%' OR table_name IN ('public.webauthn_credential', 'public.identity_link')`,
      )
      assert.deepEqual(unprotected.rows, [])
    } finally {
      await db.close()
    }
  },
})
