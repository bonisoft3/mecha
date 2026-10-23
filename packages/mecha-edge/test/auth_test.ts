import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { isoBase64URL, isoCBOR, isoUint8Array, toHash } from '@simplewebauthn/server/helpers'
import { signJwt } from '../../../services/auth/jwt.ts'
import { createEdgeCluster } from '../src/cluster.ts'

type Cbor = Parameters<typeof isoCBOR.encode>[0]

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
      const regStart = (await regStartRes.json()) as any
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
      const regVerified = (await regVerifyRes.json()) as any
      assert.ok(regVerified.token)
      assert.ok(regVerified.user?.id)
      assert.ok(regVerified.user?.handle)

      // 2. Authentication with the registered passkey
      const loginStartRes = await cluster.handle(new Request(`${origin}/auth/login/start`, { method: 'POST' }))
      assert.equal(loginStartRes.status, 200)
      const loginStart = (await loginStartRes.json()) as any
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
      const loggedIn = (await loginVerifyRes.json()) as any
      assert.equal(loggedIn.user.id, regVerified.user.id)
      assert.equal(loggedIn.user.handle, regVerified.user.handle)

      // 3. Guest minting and promotion to passkey
      const guestRes = await cluster.handle(new Request(`${origin}/auth/guest`, { method: 'POST' }))
      assert.equal(guestRes.status, 200)
      const guest = (await guestRes.json()) as any
      assert.ok(guest.token)
      assert.ok(guest.user.guest)

      const promoPasskey = await makePasskey(rpId)
      const promoStartRes = await cluster.handle(
        new Request(`${origin}/auth/register/start`, {
          method: 'POST',
          headers: { authorization: `Bearer ${guest.token}` },
        }),
      )
      assert.equal(promoStartRes.status, 200)
      const promoStart = (await promoStartRes.json()) as any

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
      const promoted = (await promoVerifyRes.json()) as any
      // Retains guest ID and handle
      assert.equal(promoted.user.id, guest.user.id)
      assert.equal(promoted.user.handle, guest.user.handle)

      // 4. Login with promoted passkey succeeds
      const promoLoginStartRes = await cluster.handle(new Request(`${origin}/auth/login/start`, { method: 'POST' }))
      const promoLoginStart = (await promoLoginStartRes.json()) as any
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
      const promoLoggedIn = (await promoLoginVerifyRes.json()) as any
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
