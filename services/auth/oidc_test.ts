// Provider sign-in against providers of the test's own, reached through the
// fetch the service is handed: Google's discovery, keys and token endpoint
// standing in for Google's, and an issuer of another name standing for one a
// deployment puts in Google's place — the client its door's origin, holding
// no secret, signing with ES256, reached inside the cluster at another
// address. Each case is a way a sign-in could be forged, replayed or
// misdirected.
// deno-lint-ignore no-import-prefix
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.13";
import { errors } from "jose";
import { encodeBase64Url, nativeSchemesFrom, randomToken, signJwt, STACK_ISSUER } from "./jwt.ts";
import { GUEST_ACR, sessionClaims } from "./claims.ts";
import {
  type ConsumedTicket,
  discovery,
  type Config,
  JWKS_TIMEOUT_MS,
  keySource,
  type Links,
  type NativeTicket,
  oidc,
  type Provider,
  providersFrom,
  providerStill,
  safeReturn,
  sha256url,
  NONCE_COOKIE,
  STATE_COOKIE,
  type Tickets,
  type User,
} from "./oidc.ts";
import { publicAddress, publicHttps } from "./atproto.ts";
import { cookieOf, deviceSession, HELD_COOKIE, HINT_COOKIE, SESSION_COOKIE } from "./session.ts";

const ORIGIN = "https://app.test";
const SECRET = "a-test-secret-that-is-at-least-32-chars";
const now = () => Math.floor(Date.now() / 1000);
const b64 = (s: string) => encodeBase64Url(new TextEncoder().encode(s));

type Alg = "RS256" | "ES256";
const generate = (alg: Alg) =>
  crypto.subtle.generateKey(
    alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;

async function sign(alg: Alg, key: CryptoKey, kid: string | undefined, claims: Record<string, unknown>): Promise<string> {
  const head = b64(JSON.stringify({ alg, ...(kid === undefined ? {} : { kid }), typ: "JWT" }));
  const body = b64(JSON.stringify(claims));
  const params = alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
  const sig = new Uint8Array(await crypto.subtle.sign(params, key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${encodeBase64Url(sig)}`;
}

/** An OpenID provider in memory: the codes it issued, what /token is asked,
 * and the ID token it signs, which a case may bend. */
async function provider(p: { issuer: string; reachedAt?: string; alg: Alg; client?: string; secret?: string; iss?: string }) {
  const keys = await generate(p.alg);
  const other = await generate(p.alg);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" };
  const publicBase = p.issuer.replace(/\/$/, "");
  const base = (p.reachedAt ?? p.issuer).replace(/\/$/, "");
  const codes = new Map<string, { client: string; redirect: string; challenge: string; nonce: string }>();
  const asked: string[] = [];
  let bend: Record<string, unknown> = {};
  let signer: { key: CryptoKey; kid: string | undefined } = { key: keys.privateKey, kid: "k1" };
  const published = [jwk];
  let keysDown = false;
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    if (url === `${base}/.well-known/openid-configuration`) {
      return Response.json({ issuer: p.issuer, authorization_endpoint: `${publicBase}/authorize`, token_endpoint: `${publicBase}/token`, jwks_uri: `${publicBase}/jwks` });
    }
    if (url === `${base}/jwks`) return keysDown ? new Response("unavailable", { status: 503 }) : Response.json({ keys: published });
    if (url === `${base}/token`) {
      const form = new URLSearchParams(String(init?.body));
      const grant = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (
        !grant || form.get("grant_type") !== "authorization_code" || form.get("client_id") !== grant.client ||
        form.get("redirect_uri") !== grant.redirect || (await sha256url(form.get("code_verifier") ?? "")) !== grant.challenge ||
        form.get("client_secret") !== (p.secret ?? null)
      ) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const claims = { iss: p.iss ?? p.issuer, aud: grant.client, sub: "alice-sub", name: "Alice", picture: "https://pics.test/a", email: "Alice@Example.test", email_verified: true, nonce: grant.nonce, exp: now() + 300, ...bend };
      return Response.json({ id_token: await sign(p.alg, signer.key, signer.kid, claims) });
    }
    throw new Error(`the test's provider was asked ${url}`);
  };
  return {
    fetcher,
    asked,
    /** What the reader's visit to the authorization endpoint answers. */
    authorize(to: URL): string {
      assertEquals(to.origin + to.pathname, `${publicBase}/authorize`);
      const code = crypto.randomUUID();
      codes.set(code, { client: to.searchParams.get("client_id")!, redirect: to.searchParams.get("redirect_uri")!, challenge: to.searchParams.get("code_challenge")!, nonce: to.searchParams.get("nonce")! });
      return code;
    },
    bend(claims: Record<string, unknown>) {
      bend = claims;
    },
    signWithAnotherKey(kid: string | undefined = "k1") {
      signer = { key: other.privateKey, kid };
    },
    /** Publishes a new key and signs with it from now on, as a rotation does. */
    async rotate() {
      published.push({ ...(await crypto.subtle.exportKey("jwk", other.publicKey)), kid: "k2" });
      signer = { key: other.privateKey, kid: "k2" };
    },
    breakKeys() {
      keysDown = true;
    },
    /** An ID token as the provider's own button hands it to the page. */
    async mint(client: string, nonce: string, claims: Record<string, unknown> = {}) {
      return await sign(p.alg, signer.key, signer.kid, { iss: p.iss ?? p.issuer, aud: client, sub: "alice-sub", name: "Alice", email: "Alice@Example.test", email_verified: true, nonce, exp: now() + 300, ...claims });
    },
  };
}

/** Links in memory, and the guests the test has minted, each one a guest
 * while no subject is linked to it. */
function memory(): Links & { users: Map<string, User & { name: string | null; email: string | null }>; guests: Map<string, string> } {
  const users = new Map<string, User & { name: string | null; email: string | null }>();
  const guests = new Map<string, string>();
  return {
    users,
    guests,
    userFor(p, guest) {
      const key = `${p.provider}:${p.issuer}:${p.sub}`;
      const held = users.get(key);
      if (held && guest !== null && guest !== held.id) return Promise.resolve({ taken: { id: held.id, handle: held.handle, name: held.name, email: held.email } });
      const promoted = !held && guest !== null && guests.has(guest) && ![...users.values()].some((u) => u.id === guest);
      const u = held ?? (promoted ? { id: guest!, handle: guests.get(guest!)!, name: p.name, email: p.email } : { id: crypto.randomUUID(), handle: `h-${users.size}`, name: p.name, email: p.email });
      u.name = p.name;
      u.email = p.email;
      users.set(key, u);
      return Promise.resolve({ id: u.id, handle: u.handle, name: u.name, email: u.email });
    },
    addTo(p, owner) {
      const key = `${p.provider}:${p.issuer}:${p.sub}`;
      const held = users.get(key);
      if (held) return Promise.resolve(held.id === owner ? "added" : "taken");
      if ([...users.entries()].some(([k, u]) => u.id === owner && k.startsWith(`${p.provider}:${p.issuer}:`))) return Promise.resolve("held");
      const handle = [...users.values()].find((u) => u.id === owner)?.handle ?? guests.get(owner) ?? `h-${owner}`;
      users.set(key, { id: owner, handle, name: p.name, email: p.email });
      return Promise.resolve("added");
    },
    handleOf(provider, issuer, sub, id) {
      const hit = [...users.entries()].find(([k, u]) => u.id === id && k === `${provider}:${issuer}:${sub}`);
      return Promise.resolve(hit ? { handle: hit[1].handle, name: hit[1].name, email: hit[1].email } : null);
    },
  };
}

const GOOGLE: Record<string, string> = { OIDC_PROVIDERS: "google", OIDC_GOOGLE_CLIENT_ID: "client-123", OIDC_GOOGLE_CLIENT_SECRET: "shh" };
// A deployment putting another issuer in Google's place, as pronto-identity's broker is.
const BROKERED: Record<string, string> = {
  OIDC_PROVIDERS: "google",
  OIDC_GOOGLE_ISSUER: "https://broker.test",
  OIDC_GOOGLE_INTERNAL: "http://broker.internal:28443",
  OIDC_GOOGLE_CLIENT_ID: "origin",
  OIDC_GOOGLE_SCOPE: "openid",
  OIDC_GOOGLE_AUTHORIZE_PARAMS: "provider=google",
};

/** The device session over these providers' links: a provider's way alone. */
const deviceFor = (providers: Record<string, Provider>, links: Links, origin = ORIGIN) => {
  const stands = providerStill(providers, links);
  return deviceSession({
    secret: SECRET,
    origin: () => origin,
    still: (way, sub) => way.kind === "provider" ? stands(way, sub) : Promise.resolve(null),
    issue: (u, proof) => signJwt(SECRET, sessionClaims(origin, u, proof, now() + 60)),
  });
};

async function setup(env = GOOGLE, links = memory(), origin = ORIGIN, adding?: Config["adding"]) {
  const providers = providersFrom((name) => env[name]);
  const issuer = env.OIDC_GOOGLE_ISSUER ?? "https://accounts.google.com";
  const brokered = issuer !== "https://accounts.google.com";
  const idp = await provider(
    brokered
      ? { issuer, reachedAt: env.OIDC_GOOGLE_INTERNAL || issuer, alg: "ES256" }
      : { issuer: "https://accounts.google.com", iss: "accounts.google.com", alg: "RS256", secret: "shh" },
  );
  const device = deviceFor(providers, links, origin);
  const routes = oidc({ secret: SECRET, origin: () => origin, providers, links, device, fetcher: idp.fetcher as typeof fetch, adding });
  const serve = async (req: Request) => {
    const res = routes(req) ?? device.route(req);
    assert(res !== null, `${req.method} ${req.url} is not a route`);
    return await res;
  };
  return { idp, links, routes, serve };
}

const jar = (res: Response) =>
  Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(";")[0].split("=")).map(([k, ...v]) => [k, v.join("=")]));

async function begin(serve: (r: Request) => Promise<Response>, ret = "/chapter/8") {
  const res = await serve(new Request(`${ORIGIN}/auth/oidc/google/start?return=${encodeURIComponent(ret)}`));
  assertEquals(res.status, 303);
  const to = new URL(res.headers.get("location")!);
  return { to, state: to.searchParams.get("state")!, verifier: jar(res)[`${STATE_COOKIE}_google`], cookie: res.headers.getSetCookie()[0] };
}

const callback = (q: Record<string, string>, verifier: string | null) =>
  new Request(`${ORIGIN}/auth/oidc/google/callback?${new URLSearchParams(q)}`, {
    headers: verifier === null ? {} : { cookie: `${STATE_COOKIE}_google=${verifier}` },
  });

/** A whole sign-in: start, the provider's answer, the callback. */
async function signIn(s: Awaited<ReturnType<typeof setup>>) {
  const { to, state, verifier } = await begin(s.serve);
  return await s.serve(callback({ code: s.idp.authorize(to), state }, verifier));
}

const exchange = (session: string, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/auth/session`, {
    method: "POST",
    headers: { cookie: `${SESSION_COOKIE}=${session}`, ...(origin === null ? {} : { origin }) },
  });

Deno.test("Google signs a person in by code and PKCE, and the cookie becomes a non-guest session", async () => {
  const s = await setup();
  const { to, state, verifier, cookie } = await begin(s.serve);
  assertEquals(to.searchParams.get("client_id"), "client-123");
  assertEquals(to.searchParams.get("redirect_uri"), `${ORIGIN}/auth/oidc/google/callback`);
  assertEquals(to.searchParams.get("response_type"), "code");
  assertEquals(to.searchParams.get("scope"), "openid profile email");
  assertEquals(to.searchParams.get("prompt"), "select_account");
  assertEquals(to.searchParams.get("code_challenge_method"), "S256");
  assertEquals(to.searchParams.get("code_challenge"), await sha256url(verifier));
  // The provider sees the challenge, never the verifier.
  assert(!to.toString().includes(verifier));
  assert(cookie.includes("Path=/;") && cookie.includes("HttpOnly") && cookie.includes("SameSite=Lax") && cookie.includes("Secure"), cookie);

  const done = await s.serve(callback({ code: s.idp.authorize(to), state }, verifier));
  assertEquals(done.status, 303);
  assertEquals(done.headers.get("location"), "/chapter/8");
  const back = jar(done);
  assertEquals(back[HINT_COOKIE], "1");
  assertEquals(back[`${STATE_COOKIE}_google`], "");
  assertEquals(s.links.users.get("google:https://accounts.google.com:alice-sub")?.name, "Alice");
  // The address as the provider vouched for it, folded for the checkout to start from.
  assertEquals(s.links.users.get("google:https://accounts.google.com:alice-sub")?.email, "alice@example.test");

  const session = await s.serve(exchange(back[SESSION_COOKIE]));
  assertEquals(session.status, 200);
  // The session the terminal adopts names the person as the provider vouched: the chrome
  // shows the name over the handle, and a checkout starts from the email.
  assertEquals((await session.json()).user, { id: s.links.users.get("google:https://accounts.google.com:alice-sub")!.id, handle: "h-0", name: "Alice", email: "alice@example.test" });
});

Deno.test("an issuer in Google's place is a public client named by the door, reached inside the cluster", async () => {
  const s = await setup(BROKERED);
  // Asked for `openid` alone, it vouches for a subject and says nothing else.
  s.idp.bend({ name: undefined, picture: undefined });
  const { to, state, verifier } = await begin(s.serve);
  assertEquals(to.origin, "https://broker.test");
  assertEquals(to.searchParams.get("client_id"), ORIGIN);
  assertEquals(to.searchParams.get("provider"), "google");
  assertEquals(to.searchParams.get("scope"), "openid");
  // Google's own parameters are Google's alone.
  assertEquals(to.searchParams.has("prompt"), false);
  const done = await s.serve(callback({ code: s.idp.authorize(to), state }, verifier));
  assertEquals(done.status, 303);
  // The broker gives a subject and nothing about the person.
  assertEquals(s.links.users.get("google:https://broker.test:alice-sub")?.name, null);
  // Discovery, keys and the code all went to the cluster's address; the reader alone went to the issuer's.
  assert(s.idp.asked.every((u) => u.startsWith("http://broker.internal:28443/")), s.idp.asked.join(" "));
});

Deno.test("an issuer's trailing slash survives discovery, sign-in and session adoption", async () => {
  for (const internal of ["", "http://broker.internal:28443/realm/"]) {
    const env = { ...BROKERED, OIDC_GOOGLE_ISSUER: "https://broker.test/realm/", OIDC_GOOGLE_INTERNAL: internal };
    const s = await setup(env);
    const done = await signIn(s);
    assertEquals(done.status, 303);
    const session = await s.serve(exchange(jar(done)[SESSION_COOKIE]));
    assertEquals(session.status, 200);
    assertEquals((await session.json()).user.id, s.links.users.get("google:https://broker.test/realm/:alice-sub")!.id);
    assert(s.idp.asked.every((u) => u.startsWith(internal || env.OIDC_GOOGLE_ISSUER)));
    s.idp.bend({ iss: "https://broker.test/realm" });
    assertEquals((await signIn(s)).status, 401);
  }
});

Deno.test("discovery compares the exact issuer and rewrites only endpoints under its URL", async () => {
  const p = providersFrom((name) => ({ ...BROKERED, OIDC_GOOGLE_ISSUER: "https://broker.test/", OIDC_GOOGLE_INTERNAL: "http://broker.internal:28443/" })[name]).google;
  const document = {
    issuer: p.issuer,
    authorization_endpoint: "https://broker.test/authorize",
    token_endpoint: "https://broker.test.other/token",
    jwks_uri: "https://broker.test/jwks",
  };
  const endpoints = await discovery(() => Promise.resolve(Response.json(document)))(p);
  assertEquals(endpoints.token, document.token_endpoint);
  assertEquals(endpoints.jwks, "http://broker.internal:28443/jwks");
  await assertRejects(
    () => discovery(() => Promise.resolve(Response.json({ ...document, issuer: "https://broker.test" })))(p),
    Error,
    "names the issuer https://broker.test",
  );
});

Deno.test("signing in again is the same person, with the provider's new name", async () => {
  const s = await setup();
  assertEquals((await signIn(s)).status, 303);
  s.idp.bend({ name: "Alice B." });
  assertEquals((await signIn(s)).status, 303);
  assertEquals(s.links.users.size, 1);
  assertEquals(s.links.users.get("google:https://accounts.google.com:alice-sub")!.name, "Alice B.");
});

Deno.test("a callback is refused without this browser's verifier, and its code is then spent for nobody", async () => {
  const s = await setup();
  const { to, state } = await begin(s.serve);
  const code = s.idp.authorize(to);
  assertEquals((await s.serve(callback({ code, state }, null))).status, 400);
  const other = await begin(s.serve);
  assertEquals((await s.serve(callback({ code, state }, other.verifier))).status, 400);
  assertEquals(s.links.users.size, 0);
});

Deno.test("a callback is refused with a forged, foreign or expired state", async () => {
  const s = await setup();
  const { to, verifier } = await begin(s.serve);
  const code = s.idp.authorize(to);
  const bind = await sha256url(verifier);
  const claims = { purpose: "oidc", provider: "google", issuer: "https://accounts.google.com", nonce: to.searchParams.get("nonce"), bind, ret: "/", exp: now() + 60 };
  for (const [why, state] of [
    ["another secret", await signJwt("another-secret-that-is-at-least-32-chars", claims)],
    ["a passkey's", await signJwt(SECRET, { ...claims, purpose: "login" })],
    ["another provider's", await signJwt(SECRET, { ...claims, provider: "apple" })],
    ["expired", await signJwt(SECRET, { ...claims, exp: now() - 1 })],
  ]) {
    assertEquals((await s.serve(callback({ code, state }, verifier))).status, 400, why);
  }
});

Deno.test("a provider's refusal, and a code it will not redeem, sign nobody in", async () => {
  const s = await setup();
  const { state, verifier } = await begin(s.serve);
  assertEquals((await s.serve(callback({ error: "access_denied", state }, verifier))).status, 401);
  assertEquals((await s.serve(callback({ code: "never-issued", state }, verifier))).status, 401);
  assertEquals(s.links.users.size, 0);
});

Deno.test("an ID token is refused unless the provider signed it for this client and this nonce", async () => {
  type Idp = Awaited<ReturnType<typeof provider>>;
  const cases: [string, (idp: Idp) => void][] = [
    ["another key", (idp) => idp.signWithAnotherKey()],
    ["an unpublished kid", (idp) => idp.signWithAnotherKey("k2")],
    ["no kid", (idp) => idp.signWithAnotherKey(undefined)],
    ["another issuer", (idp) => idp.bend({ iss: "https://evil.test" })],
    ["another client", (idp) => idp.bend({ aud: "someone-else" })],
    ["several audiences, handed to another", (idp) => idp.bend({ aud: ["client-123", "x"], azp: "x" })],
    ["expired", (idp) => idp.bend({ exp: now() - 1 })],
    ["another nonce", (idp) => idp.bend({ nonce: "replayed" })],
    ["no subject", (idp) => idp.bend({ sub: "" })],
  ];
  for (const [why, bend] of cases) {
    const s = await setup();
    bend(s.idp);
    assertEquals((await signIn(s)).status, 401, why);
    assertEquals(s.links.users.size, 0, why);
  }
});

// Regression: jose's remote key set waits 30 s after a fetch before fetching
// again, and a key the provider rotated to within that time was refused.
Deno.test("a key the provider rotates to is fetched at once, and its first token signs in", async () => {
  const s = await setup();
  assertEquals((await signIn(s)).status, 303);
  await s.idp.rotate();
  assertEquals((await signIn(s)).status, 303);
});

// Regression: a provider failing to serve its keys read as its token refused.
Deno.test("a provider that cannot serve its keys fails the sign-in loudly, not as a refused token", async () => {
  const s = await setup();
  s.idp.breakKeys();
  await assertRejects(() => signIn(s));
});

Deno.test("a discovery document naming another issuer is refused", async () => {
  const s = await setup();
  const routes = oidc({
    secret: SECRET,
    origin: () => ORIGIN,
    providers: providersFrom((name) => ({ ...GOOGLE, OIDC_GOOGLE_ISSUER: "https://not-google.test", OIDC_GOOGLE_INTERNAL: "https://accounts.google.com" })[name]),
    links: s.links,
    device: deviceFor({}, s.links),
    fetcher: s.idp.fetcher as typeof fetch,
  });
  await assertRejects(() => routes(new Request(`${ORIGIN}/auth/oidc/google/start`))!, Error, "names the issuer https://accounts.google.com");
});

Deno.test("the session exchange is refused from another origin, without the cookie, or once the link is gone", async () => {
  const s = await setup();
  const session = jar(await signIn(s))[SESSION_COOKIE];
  assertEquals((await s.serve(exchange(session, "https://evil.test"))).status, 403);
  assertEquals((await s.serve(new Request(`${ORIGIN}/auth/session`, { method: "POST" }))).status, 401);
  const notOurs = await signJwt(SECRET, { purpose: "oidc", way: { kind: "provider", provider: "google", issuer: "https://accounts.google.com" }, auth_time: now(), sub: s.links.users.get("google:https://accounts.google.com:alice-sub")!.id, exp: now() + 60 });
  assertEquals((await s.serve(exchange(notOurs))).status, 401);
  assertEquals((await s.serve(exchange(session, null))).status, 200);
  s.links.users.clear();
  assertEquals((await s.serve(exchange(session))).status, 401);
});

Deno.test("sign-out clears the session and its hint, and only from this origin", async () => {
  const s = await setup();
  assertEquals((await s.serve(new Request(`${ORIGIN}/auth/signout`, { method: "POST", headers: { origin: "https://evil.test" } }))).status, 403);
  const res = await s.serve(new Request(`${ORIGIN}/auth/signout`, { method: "POST", headers: { origin: ORIGIN } }));
  assertEquals(res.status, 204);
  assertEquals(jar(res), { [SESSION_COOKIE]: "", [HELD_COOKIE]: "", [HINT_COOKIE]: "" });
});

/** A guest the test mints, and its token. */
async function guestOf(s: Awaited<ReturnType<typeof setup>>, handle = "mango-otter-3fa2") {
  const id = crypto.randomUUID();
  s.links.guests.set(id, handle);
  return { id, token: await signJwt(SECRET, sessionClaims(ORIGIN, { id, handle }, { acr: GUEST_ACR, auth_time: now() }, now() + 60)) };
}

/** A guest's start: a POST from this origin carrying its token. */
const hintedStart = (token: string, origin: string | null = ORIGIN, ret = "/chapter/8") =>
  new Request(`${ORIGIN}/auth/oidc/google/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(origin === null ? {} : { origin }) },
    body: new URLSearchParams({ id_token_hint: token, return: ret }),
  });

async function hintedSignIn(s: Awaited<ReturnType<typeof setup>>, token: string) {
  const res = await s.serve(hintedStart(token));
  assertEquals(res.status, 303);
  const to = new URL(res.headers.get("location")!);
  // The provider is asked as any reader would be: the guest is the state's, signed.
  assert(!to.toString().includes(token));
  return await s.serve(callback({ code: s.idp.authorize(to), state: to.searchParams.get("state")! }, jar(res)[`${STATE_COOKIE}_google`]));
}

const claimsOf = (token: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0))));

Deno.test("a guest that signs in with a subject no account holds becomes it, keeping its id and handle", async () => {
  const s = await setup();
  const guest = await guestOf(s);
  const done = await hintedSignIn(s, guest.token);
  assertEquals(done.status, 303);
  assertEquals(done.headers.get("location"), "/chapter/8");
  const session = await s.serve(exchange(jar(done)[SESSION_COOKIE]));
  const body = await session.json();
  assertEquals(body.user.id, guest.id);
  assertEquals(body.user.handle, "mango-otter-3fa2");
  const claims = claimsOf(body.token);
  assertEquals([claims.iss, claims.sub, claims.acr], [ORIGIN, guest.id, undefined]);
  // The provider said nothing of when its person signed in, so neither does the session.
  assertEquals(claims.auth_time, undefined);
});

Deno.test("a guest that signs in with a subject another account holds is held, not switched, until it takes it", async () => {
  const s = await setup();
  await signIn(s);
  const owner = s.links.users.get("google:https://accounts.google.com:alice-sub")!;
  const guest = await guestOf(s);
  const done = await hintedSignIn(s, guest.token);
  assertEquals(done.status, 303);
  const back = jar(done);
  // No session: the guest stays the device's.
  assertEquals(back[SESSION_COOKIE], undefined);
  // The guest's own hint is left as it was.
  assertEquals(back[HINT_COOKIE], undefined);
  assert(done.headers.getSetCookie().some((c) => c.startsWith(`${HELD_COOKIE}=`) && c.includes("HttpOnly") && c.includes("Path=/;")));
  const held = new Request(`${ORIGIN}/auth/session`, { method: "POST", headers: { cookie: `${HELD_COOKIE}=${back[HELD_COOKIE]}`, origin: ORIGIN } });
  const asked = await s.serve(held);
  assertEquals(asked.status, 409);
  const offer = await asked.json();
  assertEquals([offer.error, offer.user, typeof offer.offer], ["login_required", { handle: owner.handle, name: "Alice" }, "string"]);
  // Taking it from another origin is refused; from this one, naming the offer, it is the session.
  const take = (origin: string) =>
    new Request(`${ORIGIN}/auth/session/switch`, { method: "POST", headers: { cookie: `${HELD_COOKIE}=${back[HELD_COOKIE]}`, origin }, body: JSON.stringify({ offer: offer.offer }) });
  assertEquals((await s.serve(take("https://evil.test"))).status, 403);
  const taken = await s.serve(take(ORIGIN));
  assertEquals(taken.status, 200);
  assertEquals((await taken.json()).user.id, owner.id);
  const after = jar(taken);
  assertEquals(after[HELD_COOKIE], "");
  assertEquals((await s.serve(exchange(after[SESSION_COOKIE]))).status, 200);
  // The guest never held the subject.
  assertEquals(s.links.users.size, 1);
});

Deno.test("a guest's start fetched answers where to go, since a page's CSP refuses a form's redirect to the provider", async () => {
  const s = await setup();
  const guest = await guestOf(s);
  const req = hintedStart(guest.token);
  req.headers.set("accept", "application/json");
  const res = await s.serve(req);
  assertEquals(res.status, 200);
  const { to } = await res.json();
  assertEquals(new URL(to).searchParams.get("code_challenge_method"), "S256");
  assert(res.headers.getSetCookie().some((c) => c.startsWith(`${STATE_COOKIE}_google=`)), "the state cookie binds the callback to this browser");
});

Deno.test("a guest's start is refused from another origin, and for a token that is no guest's", async () => {
  const s = await setup();
  const guest = await guestOf(s);
  // Another origin would give its guest this reader's subject.
  assertEquals((await s.serve(hintedStart(guest.token, "https://evil.test"))).status, 403);
  const person = await signJwt(SECRET, sessionClaims(ORIGIN, { id: crypto.randomUUID(), handle: "p" }, { acr: "phr", auth_time: now() }, now() + 60));
  assertEquals((await s.serve(hintedStart(person))).status, 400);
  assertEquals((await s.serve(hintedStart(await signJwt("another-secret-of-at-least-32-chars", { role: "app_user", sub: guest.id, acr: GUEST_ACR, exp: now() + 60 })))).status, 400);
});

Deno.test("a provider the deployment did not enable, and every other path, is not a route", async () => {
  const { routes } = await setup();
  assertEquals(routes(new Request(`${ORIGIN}/auth/oidc/apple/start`)), null);
  assertEquals(routes(new Request(`${ORIGIN}/auth/oidc/google/callback`, { method: "POST" })), null);
  assertEquals(routes(new Request(`${ORIGIN}/auth/login/start`, { method: "POST" })), null);
});

Deno.test("the return path stays on this origin and off the auth service", () => {
  for (const raw of [null, "https://evil.test/", "//evil.test", "/\\evil.test", "/auth/oidc/session", "/a\nb", "chapter"]) {
    assertEquals(safeReturn(raw), "/", String(raw));
  }
  assertEquals(safeReturn("/chapter/8?page=2"), "/chapter/8?page=2");
});

Deno.test("a provider is configured by name, and refused at startup when it cannot sign anyone in", () => {
  const from = (vars: Record<string, string>) => providersFrom((name) => vars[name]);
  assertEquals(from({}), {});
  const google: Provider = from(GOOGLE).google;
  assertEquals(google.issuers, ["https://accounts.google.com", "accounts.google.com"]);
  assertEquals(google.secret, "shh");
  // Google's aliases are not lent to an issuer in its place.
  assertEquals(from(BROKERED).google.issuers, ["https://broker.test"]);
  assertEquals(from({ OIDC_PROVIDERS: "acme", OIDC_ACME_ISSUER: "https://id.acme.test/", OIDC_ACME_CLIENT_ID: "c" }).acme.issuer, "https://id.acme.test/");
  for (const [vars, why] of [
    [{ OIDC_PROVIDERS: "google" }, "OIDC_GOOGLE_CLIENT_ID is required"],
    [{ OIDC_PROVIDERS: "acme", OIDC_ACME_CLIENT_ID: "c" }, "OIDC_ACME_ISSUER is required"],
    [{ ...GOOGLE, OIDC_GOOGLE_ISSUER: "http://id.test" }, "is not https"],
    [{ ...GOOGLE, OIDC_GOOGLE_AUTHORIZE_PARAMS: "redirect_uri=https://evil.test" }, "sets redirect_uri"],
    [{ OIDC_PROVIDERS: "Google", OIDC_GOOGLE_CLIENT_ID: "c" }, "not a lowercase word"],
    [{ ...GOOGLE, OIDC_GOOGLE_CREDENTIAL: "yes" }, "not true"],
    [{ OIDC_PROVIDERS: "google", OIDC_GOOGLE_CLIENT_ID: "origin", OIDC_GOOGLE_CREDENTIAL: "true" }, "a registered client"],
  ] as const) {
    assertThrows(() => from(vars), Error, why);
  }
});

Deno.test("replacing an issuer cannot inherit its subject or its browser session", async () => {
  const links = memory();
  const google = await setup(GOOGLE, links);
  const previous = jar(await signIn(google))[SESSION_COOKIE];
  const alice = (await (await google.serve(exchange(previous))).json()).user;
  const broker = await setup(BROKERED, links);
  assertEquals((await broker.serve(exchange(previous))).status, 401);
  const pending = await begin(google.serve);
  assertEquals((await broker.serve(callback({ code: google.idp.authorize(pending.to), state: pending.state }, pending.verifier))).status, 400);
  const current = jar(await signIn(broker))[SESSION_COOKIE];
  const other = (await (await broker.serve(exchange(current))).json()).user;
  assert(alice.id !== other.id);
  assertEquals(links.users.size, 2);
  assertEquals((await google.serve(exchange(current))).status, 401);
});

Deno.test("disabling a provider also refuses its browser session", async () => {
  const s = await setup();
  const cookie = jar(await signIn(s))[SESSION_COOKIE];
  assertEquals((await deviceFor({}, s.links).route(exchange(cookie))!).status, 401);
});

Deno.test("Service-Worker-Navigation-Preload and prefetch GETs neither overwrite PKCE state nor spend a single-use code", async () => {
  const s = await setup();
  const { to, state, verifier } = await begin(s.serve);
  const code = s.idp.authorize(to);
  for (const headers of [
    { "service-worker-navigation-preload": "true" },
    { "sec-purpose": "prefetch;prerender" },
  ] as Record<string, string>[]) {
    const preloadStart = await s.serve(new Request(`${ORIGIN}/auth/oidc/google/start`, { headers }));
    assertEquals(preloadStart.status, 400);
    assertEquals(preloadStart.headers.getSetCookie(), []);
    const preloadCb = await s.serve(new Request(`${ORIGIN}/auth/oidc/google/callback?${new URLSearchParams({ code, state })}`, {
      headers: { ...headers, cookie: `${STATE_COOKIE}_google=${verifier}` },
    }));
    assertEquals(preloadCb.status, 400);
    assertEquals(preloadCb.headers.getSetCookie(), []);
  }
  const done = await s.serve(callback({ code, state }, verifier));
  assertEquals(done.status, 303);
  assertEquals(s.links.users.size, 1);
});

function memoryTickets() {
  const held = new Map<string, NativeTicket & { expiresAt: number }>();
  const tickets: Tickets = {
    issue(t) {
      held.set(t.id, { ...t, expiresAt: Date.now() + t.ttlSeconds * 1000 });
      return Promise.resolve();
    },
    consume(id): Promise<ConsumedTicket | null> {
      const hit = held.get(id);
      held.delete(id);
      if (!hit || hit.expiresAt <= Date.now()) return Promise.resolve(null);
      return Promise.resolve({
        userId: hit.userId,
        provider: hit.provider,
        issuer: hit.issuer,
        sub: hit.sub,
        codeChallenge: hit.codeChallenge,
        proof: hit.proof,
        held: hit.held,
      });
    },
  };
  return {
    tickets,
    held,
    expire(id: string) {
      const hit = held.get(id);
      if (hit) hit.expiresAt = Date.now() - 1;
    },
  };
}

async function setupNative(schemes: readonly string[] = ["snapcards", "snapcards-dev"]) {
  const providers = providersFrom((name) => GOOGLE[name]);
  const idp = await provider({ issuer: "https://accounts.google.com", iss: "accounts.google.com", alg: "RS256", secret: "shh" });
  const guests = new Map<string, { handle: string; linked: boolean }>();
  const users = new Map<string, User & { name: string | null; email: string | null }>();
  const links: Links = {
    userFor(p, promoteUserId) {
      const key = `${p.provider}:${p.issuer}:${p.sub}`;
      const existing = users.get(key);
      if (existing && promoteUserId && promoteUserId !== existing.id) {
        return Promise.resolve({ taken: { id: existing.id, handle: existing.handle, name: p.name, email: p.email } });
      }
      if (promoteUserId && !existing) {
        const g = guests.get(promoteUserId)!;
        g.linked = true;
        const promoted = { id: promoteUserId, handle: g.handle, name: p.name, email: p.email };
        users.set(key, promoted);
        return Promise.resolve(promoted);
      }
      const u = users.get(key) ?? { id: crypto.randomUUID(), handle: `h-${users.size}`, name: p.name, email: p.email };
      u.name = p.name;
      u.email = p.email;
      users.set(key, u);
      return Promise.resolve({ id: u.id, handle: u.handle, name: u.name, email: u.email });
    },
    addTo() {
      throw new Error("a native start adds no way");
    },
    handleOf(prov, issuer, sub, id) {
      const hit = [...users.entries()].find(([k, u]) => u.id === id && k === `${prov}:${issuer}:${sub}`);
      return Promise.resolve(hit ? { handle: hit[1].handle, name: hit[1].name, email: hit[1].email } : null);
    },
  };
  const store = memoryTickets();
  const routes = oidc({
    secret: SECRET,
    origin: () => ORIGIN,
    providers,
    links,
    device: deviceFor(providers, links),
    tickets: store.tickets,
    nativeSchemes: schemes,
    issue: async (u, proof) => ({
      token: await signJwt(SECRET, sessionClaims(STACK_ISSUER, u, proof, now() + 60)),
      refresh_token: `rt-${u.id}`,
    }),
    fetcher: idp.fetcher as typeof fetch,
  });
  const serve = async (req: Request) => {
    const res = routes(req);
    assert(res !== null, `${req.method} ${req.url} is not a route`);
    return await res;
  };
  return { idp, guests, users, store, serve };
}

Deno.test("native OIDC PKCE flow issues a cookie-free single-use ticket and redeems it with code_verifier", async () => {
  const s = await setupNative();
  const appVerifier = randomToken(32);
  const appChallenge = await sha256url(appVerifier);

  const startRes = await s.serve(
    new Request(`${ORIGIN}/auth/oidc/google/start?return=native&code_challenge=${appChallenge}&scheme=snapcards-dev`),
  );
  assertEquals(startRes.status, 303);
  assertEquals(startRes.headers.getSetCookie(), []);
  const to = new URL(startRes.headers.get("location")!);
  const code = s.idp.authorize(to);
  const state = to.searchParams.get("state")!;

  const cbRes = await s.serve(new Request(`${ORIGIN}/auth/oidc/google/callback?${new URLSearchParams({ code, state })}`));
  assertEquals(cbRes.status, 303);
  assertEquals(cbRes.headers.getSetCookie(), []);
  const redirectUrl = new URL(cbRes.headers.get("location")!);
  assertEquals(`${redirectUrl.protocol}//${redirectUrl.host}${redirectUrl.pathname}`, "snapcards-dev://auth/callback");
  const ticket = redirectUrl.searchParams.get("ticket")!;
  assert(ticket.length >= 43);

  const sessionRes = await s.serve(
    new Request(`${ORIGIN}/auth/oidc/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket, code_verifier: appVerifier }),
    }),
  );
  assertEquals(sessionRes.status, 200);
  const session = await sessionRes.json();
  assertEquals(typeof session.token, "string");
  assertEquals(session.refresh_token, `rt-${session.user.id}`);
  assertEquals(session.user.name, "Alice");
  assertEquals(session.user.email, "alice@example.test");

  // Replaying an already-redeemed ticket is refused.
  const replay = await s.serve(
    new Request(`${ORIGIN}/auth/oidc/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket, code_verifier: appVerifier }),
    }),
  );
  assertEquals(replay.status, 401);
});

Deno.test("native OIDC refuses unknown schemes, bad challenges, wrong verifiers, and expired tickets", async () => {
  assertEquals(nativeSchemesFrom("snapcards, snapcards-dev, snapcards"), ["snapcards", "snapcards-dev"]);
  for (const bad of ["https", "http", "javascript", "data", "Snapcards", "1app"]) {
    assertThrows(() => nativeSchemesFrom(bad), Error, "not a custom URI scheme");
  }

  const s = await setupNative(["snapcards"]);
  const appVerifier = randomToken(32);
  const appChallenge = await sha256url(appVerifier);

  // Unknown scheme -> 400.
  assertEquals(
    (await s.serve(new Request(`${ORIGIN}/auth/oidc/google/start?return=native&code_challenge=${appChallenge}&scheme=evil`))).status,
    400,
  );
  // Unconfigured scheme allowlist -> 400.
  const unconfigured = await setupNative([]);
  assertEquals(
    (await unconfigured.serve(new Request(`${ORIGIN}/auth/oidc/google/start?return=native&code_challenge=${appChallenge}`))).status,
    400,
  );
  // Missing / short / padded code_challenge -> 400.
  for (const badChallenge of ["", "too-short", `${appChallenge}=`, "a".repeat(129)]) {
    assertEquals(
      (await s.serve(new Request(`${ORIGIN}/auth/oidc/google/start?return=native&code_challenge=${encodeURIComponent(badChallenge)}`))).status,
      400,
      badChallenge,
    );
  }

  // Wrong code_verifier returns 401 and burns the single-use ticket immediately.
  const mintTicket = async () => {
    const startRes = await s.serve(new Request(`${ORIGIN}/auth/oidc/google/start?return=native&code_challenge=${appChallenge}`));
    assertEquals(startRes.status, 303);
    const to = new URL(startRes.headers.get("location")!);
    const cbRes = await s.serve(
      new Request(`${ORIGIN}/auth/oidc/google/callback?${new URLSearchParams({ code: s.idp.authorize(to), state: to.searchParams.get("state")! })}`),
    );
    assertEquals(cbRes.status, 303);
    const loc = new URL(cbRes.headers.get("location")!);
    assertEquals(loc.protocol, "snapcards:");
    return loc.searchParams.get("ticket")!;
  };

  const t1 = await mintTicket();
  const wrong = await s.serve(
    new Request(`${ORIGIN}/auth/oidc/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: t1, code_verifier: randomToken(32) }),
    }),
  );
  assertEquals(wrong.status, 401);
  // Even with the right verifier afterward, t1 was already consumed.
  const afterWrong = await s.serve(
    new Request(`${ORIGIN}/auth/oidc/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: t1, code_verifier: appVerifier }),
    }),
  );
  assertEquals(afterWrong.status, 401);

  // Expired ticket -> 401.
  const t2 = await mintTicket();
  s.store.expire(t2);
  const expired = await s.serve(
    new Request(`${ORIGIN}/auth/oidc/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: t2, code_verifier: appVerifier }),
    }),
  );
  assertEquals(expired.status, 401);
});

Deno.test("guest promotion on OIDC start validates unlinked guest tokens and preserves guest identity", async () => {
  const s = await setupNative(["snapcards"]);
  const guestId = crypto.randomUUID();
  s.guests.set(guestId, { handle: "mango-otter-1234", linked: false });
  const guestToken = await signJwt(SECRET, {
    iss: STACK_ISSUER,
    role: "app_user",
    sub: guestId,
    handle: "mango-otter-1234",
    acr: GUEST_ACR,
    auth_time: now(),
    exp: now() + 300,
  });
  const nonGuestToken = await signJwt(SECRET, {
    iss: STACK_ISSUER,
    role: "app_user",
    sub: guestId,
    handle: "mango-otter-1234",
    acr: "phr",
    auth_time: now(),
    exp: now() + 300,
  });
  const appVerifier = randomToken(32);
  const appChallenge = await sha256url(appVerifier);

  assertEquals(
    (await s.serve(new Request(`${ORIGIN}/auth/oidc/google/start?return=native&code_challenge=${appChallenge}&promote_token=garbage`))).status,
    401,
  );
  assertEquals(
    (await s.serve(new Request(`${ORIGIN}/auth/oidc/google/start?return=native&code_challenge=${appChallenge}`, {
      headers: { authorization: `Bearer ${nonGuestToken}` },
    }))).status,
    409,
  );

  // Promote via promote_token query parameter on native start.
  const startRes = await s.serve(
    new Request(`${ORIGIN}/auth/oidc/google/start?return=native&code_challenge=${appChallenge}&promote_token=${encodeURIComponent(guestToken)}`),
  );
  assertEquals(startRes.status, 303);
  const to = new URL(startRes.headers.get("location")!);
  const cbRes = await s.serve(
    new Request(`${ORIGIN}/auth/oidc/google/callback?${new URLSearchParams({ code: s.idp.authorize(to), state: to.searchParams.get("state")! })}`),
  );
  assertEquals(cbRes.status, 303);
  const ticket = new URL(cbRes.headers.get("location")!).searchParams.get("ticket")!;
  const session = await (await s.serve(
    new Request(`${ORIGIN}/auth/oidc/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket, code_verifier: appVerifier }),
    }),
  )).json();
  assertEquals(session.user, {
    id: guestId,
    handle: "mango-otter-1234",
    name: "Alice",
    email: "alice@example.test",
  });

  // Once promoted, the old guest token starts as a browser's hint does: the
  // provider's answer decides, not the token.
  assertEquals(
    (await s.serve(new Request(`${ORIGIN}/auth/oidc/google/start?return=native&code_challenge=${appChallenge}`, {
      headers: { authorization: `Bearer ${guestToken}` },
    }))).status,
    303,
  );
});

Deno.test("the providers a deployment turns on are the ways in it tells the page, and none where it turns on none", async () => {
  const on = await setup();
  assertEquals(await (await on.serve(new Request(`${ORIGIN}/auth/oidc`))).json(), { providers: ["google"], credential: {} });
  const off = await setup({});
  assertEquals(await (await off.serve(new Request(`${ORIGIN}/auth/oidc`))).json(), { providers: [], credential: {} });
});

// Google's own button (Identity Services, FedCM where the browser has it)
// hands the page an ID token for the client registered to the page's origins.
const CREDENTIAL: Record<string, string> = { OIDC_PROVIDERS: "google", OIDC_GOOGLE_CLIENT_ID: "client-123", OIDC_GOOGLE_CREDENTIAL: "true" };

async function credentialSignIn(s: Awaited<ReturnType<typeof setup>>, bend: { claims?: Record<string, unknown>; nonce?: (asked: string) => string; cookie?: (c: string, nonce: string) => string | Promise<string>; origin?: string; hint?: string; add?: boolean } = {}) {
  const asked = await s.serve(new Request(`${ORIGIN}/auth/oidc/google/nonce${bend.add ? "?add" : ""}`));
  assertEquals(asked.status, 200);
  const { nonce } = await asked.json();
  const cookie = jar(asked)[`${NONCE_COOKIE}_google`];
  const token = await s.idp.mint("client-123", bend.nonce ? bend.nonce(nonce) : nonce, bend.claims);
  const form = new URLSearchParams({ credential: token, ...(bend.hint ? { id_token_hint: bend.hint } : {}), ...(bend.add ? { add: "" } : {}) });
  return await s.serve(new Request(`${ORIGIN}/auth/oidc/google/credential`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: bend.origin ?? ORIGIN, cookie: `${NONCE_COOKIE}_google=${bend.cookie ? await bend.cookie(cookie, nonce) : cookie}` },
    body: form,
  }));
}

Deno.test("a provider's button signs a person in by the ID token it hands the page, bound to the nonce this browser asked", async () => {
  const s = await setup(CREDENTIAL);
  assertEquals(await (await s.serve(new Request(`${ORIGIN}/auth/oidc`))).json(), { providers: ["google"], credential: { google: "client-123" } });
  const done = await credentialSignIn(s);
  assertEquals(done.status, 200);
  const back = jar(done);
  assertEquals(back[`${NONCE_COOKIE}_google`], "");
  const session = await s.serve(exchange(back[SESSION_COOKIE]));
  assertEquals((await session.json()).user.name, "Alice");
  // A provider signing in by its button has no redirect to begin.
  assertEquals(s.routes(new Request(`${ORIGIN}/auth/oidc/google/start`)), null);
});

Deno.test("a credential is refused unless it carries this browser's nonce, for this client, from this origin", async () => {
  const cases: [string, Parameters<typeof credentialSignIn>[1], number][] = [
    // A lapsed or replaced nonce is the page's to ask anew.
    ["another browser's nonce", { nonce: () => "someone-elses" }, 409],
    ["no nonce asked here", { cookie: () => "" }, 409],
    // Regression: the cookie held the nonce's hash, which anyone holding the
    // token (and so its nonce) could compute and send.
    ["a token alone, its nonce in the cookie's place", { cookie: (_, nonce) => nonce }, 409],
    ["a token alone, its nonce's hash in the cookie's place", { cookie: (_, nonce) => sha256url(nonce) }, 409],
    ["another client's token", { claims: { aud: "client-999" } }, 401],
    ["an expired token", { claims: { exp: now() - 1 } }, 401],
    ["another origin", { origin: "https://evil.test" }, 403],
  ];
  for (const [why, bend, status] of cases) {
    const s = await setup(CREDENTIAL);
    assertEquals((await credentialSignIn(s, bend)).status, status, why);
    assertEquals(s.links.users.size, 0, why);
  }
});

Deno.test("a provider signing in by redirect offers no credential route", async () => {
  const s = await setup();
  assertEquals(await (await s.serve(new Request(`${ORIGIN}/auth/oidc`))).json(), { providers: ["google"], credential: {} });
  assertEquals(s.routes(new Request(`${ORIGIN}/auth/oidc/google/nonce`)), null);
});

// Regression: Google's script assigns markup no Trusted Types policy vouches
// for, and the app's page refused it, so the button never drew.
Deno.test("the provider's button is the auth service's own page, under a policy that admits Google's script and no other", async () => {
  const s = await setup(CREDENTIAL);
  const page = await s.serve(new Request(`${ORIGIN}/auth/oidc/google/button?hl=pt-BR`));
  assertEquals(page.status, 200);
  const policy = page.headers.get("content-security-policy") ?? "";
  assert(policy.includes("script-src 'self' https://accounts.google.com/gsi/client"), policy);
  assert(policy.includes("frame-ancestors 'self'"), "only the app's own pages frame it");
  assert(!policy.includes("require-trusted-types-for"), "Google's script needs the markup sinks the app's page withholds");
  const html = await page.text();
  assert(html.includes('data-client="client-123"') && html.includes('data-locale="pt-BR"'), html);
  assert(html.includes('overflow:hidden') && html.includes('iframe{display:block}'), html);
  const script = await s.serve(new Request(`${ORIGIN}/auth/oidc/google/button.js`));
  assertEquals(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  const js = await script.text();
  for (const step of ["/oidc/${provider}/nonce", "/oidc/${provider}/credential", "top.location.reload()", "google.accounts.id.prompt()"]) assert(js.includes(step), step);
  assert(!js.includes("Math.max(200,"), js);
  // A hint is no URL's to carry.
  assertEquals((await s.serve(new Request(`${ORIGIN}/auth/oidc/google/button?hl=<script>`))).status, 200);
  assert(!(await (await s.serve(new Request(`${ORIGIN}/auth/oidc/google/button?hl=x"><script>`))).text()).includes("<script>a"), "a locale is a tag or nothing");
  const redirect = await setup();
  assertEquals(redirect.routes(new Request(`${ORIGIN}/auth/oidc/google/button`)), null);
});

/** An AT Protocol authorization server in memory, with the DID directory, the
 * account's server and the AppView it is resolved through: the requests it
 * was pushed, and the code it answers each with. */
function atprotoServer(bend: { sub?: string; tokenStatus?: number } = {}) {
  const entry = "https://bsky.social";
  const did = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
  const pushed = new Map<string, URLSearchParams>();
  const codes = new Map<string, URLSearchParams>();
  const fetcher = async (input: Request | URL | string, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const at = `${req.method} ${url.origin}${decodeURIComponent(url.pathname)}`;
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
    switch (at) {
      case `GET ${entry}/.well-known/oauth-protected-resource`:
      case "GET https://pds.test/.well-known/oauth-protected-resource":
        return json({ resource: url.origin, authorization_servers: [entry] });
      case `GET ${entry}/.well-known/oauth-authorization-server`:
      case "GET https://elsewhere.test/.well-known/oauth-authorization-server": {
        const issuer = url.origin;
        return json({
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          pushed_authorization_request_endpoint: `${issuer}/oauth/par`,
          require_pushed_authorization_requests: true,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
          token_endpoint_auth_signing_alg_values_supported: ["ES256"],
          dpop_signing_alg_values_supported: ["ES256"],
          scopes_supported: ["atproto"],
          authorization_response_iss_parameter_supported: true,
          client_id_metadata_document_supported: true,
        });
      }
      case `POST ${entry}/oauth/par`: {
        assert(req.headers.has("dpop"), "a pushed request is DPoP-bound");
        const form = new URLSearchParams(await req.text());
        const uri = `urn:ietf:params:oauth:request_uri:${pushed.size}`;
        pushed.set(uri, form);
        return json({ request_uri: uri, expires_in: 60 }, 201);
      }
      case `POST ${entry}/oauth/token`: {
        const form = new URLSearchParams(await req.text());
        const asked = codes.get(form.get("code") ?? "");
        if (bend.tokenStatus) return json({ error: bend.tokenStatus === 429 ? "slow_down" : "invalid_grant" }, bend.tokenStatus);
        if (!asked || (await sha256url(form.get("code_verifier") ?? "")) !== asked.get("code_challenge") || form.get("client_id") !== asked.get("client_id")) {
          return json({ error: "invalid_grant" }, 400);
        }
        return json({ access_token: "at", token_type: "DPoP", sub: bend.sub ?? did, scope: "atproto", expires_in: 300 });
      }
      case `GET https://plc.directory/${did}`:
        return json({
          "@context": ["https://www.w3.org/ns/did/v1"],
          id: did,
          alsoKnownAs: ["at://alice.test"],
          service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.test" }],
        });
      // An account another authorization server holds.
      case "GET https://plc.directory/did:plc:mallorymallorymallory234":
        return json({
          "@context": ["https://www.w3.org/ns/did/v1"],
          id: "did:plc:mallorymallorymallory234",
          alsoKnownAs: ["at://mallory.test"],
          service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://elsewhere.test" }],
        });
      case "GET https://elsewhere.test/.well-known/oauth-protected-resource":
        return json({ resource: url.origin, authorization_servers: ["https://elsewhere.test"] });
      // An account whose server's public-looking name answers an inside address.
      case "GET https://plc.directory/did:plc:rebindrebindrebindrebind":
        return json({
          "@context": ["https://www.w3.org/ns/did/v1"],
          id: "did:plc:rebindrebindrebindrebind",
          alsoKnownAs: ["at://rebind.test"],
          service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://rebind.test" }],
        });
      // An account whose document sends this service inside its own network.
      case "GET https://plc.directory/did:plc:insideinsideinsideinsid2":
        return json({
          "@context": ["https://www.w3.org/ns/did/v1"],
          id: "did:plc:insideinsideinsideinsid2",
          alsoKnownAs: ["at://inside.test"],
          service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://metadata.google.internal" }],
        });
      case "GET https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle":
        return json({ did });
      case "GET https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile":
        assertEquals(url.searchParams.get("actor"), did);
        return json({ did, handle: "alice.test", displayName: "Alice", avatar: "https://cdn.test/alice.jpg" });
    }
    throw new Error(`the test's AT Protocol has no ${at}`);
  };
  /** The person signs in at the server: the code it sends the browser back with. */
  const answer = (to: URL) => {
    const form = pushed.get(to.searchParams.get("request_uri") ?? "")!;
    const code = `code-${codes.size}`;
    codes.set(code, form);
    return { code, state: form.get("state")!, iss: entry };
  };
  return { fetcher, answer, pushed };
}

const BLUESKY: Record<string, string> = { OIDC_PROVIDERS: "bluesky" };

async function setupBluesky(server = atprotoServer(), links = memory()) {
  const providers = providersFrom((name) => BLUESKY[name]);
  const device = deviceFor(providers, links);
  // Every name is public but rebind.test, which answers an inside address.
  const addresses = (host: string) => Promise.resolve([host === "rebind.test" ? "10.0.0.5" : "93.184.216.34"]);
  const routes = oidc({ secret: SECRET, origin: () => ORIGIN, providers, links, device, fetcher: server.fetcher as typeof fetch, addresses });
  const serve = async (req: Request) => {
    const res = routes(req) ?? device.route(req);
    assert(res !== null, `${req.method} ${req.url} is not a route`);
    return await res;
  };
  return { server, links, serve };
}

Deno.test("Bluesky signs a person in by AT Protocol's OAuth as the DID their server vouches for, named as the AppView shows them", async () => {
  const s = await setupBluesky();
  const metadata = await (await s.serve(new Request(`${ORIGIN}/auth/oidc/bluesky/client-metadata.json`))).json();
  assertEquals(metadata.client_id, `${ORIGIN}/auth/oidc/bluesky/client-metadata.json`);
  assertEquals(metadata.redirect_uris, [`${ORIGIN}/auth/oidc/bluesky/callback`]);
  assertEquals(metadata.token_endpoint_auth_method, "none", "a public client: the app holds no secret");
  const started = await s.serve(new Request(`${ORIGIN}/auth/oidc/bluesky/start?return=${encodeURIComponent("/chapter/8")}`));
  assertEquals(started.status, 303);
  const to = new URL(started.headers.get("location")!);
  assertEquals(`${to.origin}${to.pathname}`, "https://bsky.social/oauth/authorize");
  const pushed = s.server.pushed.get(to.searchParams.get("request_uri")!)!;
  assertEquals(pushed.get("client_id"), metadata.client_id);
  assertEquals(pushed.get("scope"), "atproto", "it asks who the person is, and nothing of their repository");
  const state = jar(started)[`${STATE_COOKIE}_bluesky`];
  const done = await s.serve(new Request(`${ORIGIN}/auth/oidc/bluesky/callback?${new URLSearchParams(s.server.answer(to))}`, { headers: { cookie: `${STATE_COOKIE}_bluesky=${state}` } }));
  assertEquals(done.status, 303, await done.clone().text());
  assertEquals(done.headers.get("location"), "/chapter/8");
  const back = jar(done);
  assertEquals(back[`${STATE_COOKIE}_bluesky`], "");
  const session = await (await s.serve(exchange(back[SESSION_COOKIE]))).json();
  assertEquals(session.user.name, "Alice");
  assert(s.links.users.has("bluesky:atproto:did:plc:ewvi7nxzyoun6zhxrhs64oiz"), "the link is the DID's, whichever server holds the account");
});

Deno.test("a Bluesky sign-in is refused without this browser's state, or when the server refuses the code", async () => {
  for (const [why, server, cookie, status] of [
    ["another browser", atprotoServer(), (_: string) => "", 400],
    ["a forged state", atprotoServer(), (_: string) => "x.y.z.w.v", 400],
    ["the code refused", atprotoServer({ tokenStatus: 400 }), (c: string) => c, 401],
    // The server vouches only for the accounts it holds.
    ["a DID another server holds", atprotoServer({ sub: "did:plc:mallorymallorymallory234" }), (c: string) => c, 401],
  ] as const) {
    const s = await setupBluesky(server);
    const started = await s.serve(new Request(`${ORIGIN}/auth/oidc/bluesky/start`));
    const to = new URL(started.headers.get("location")!);
    const res = await s.serve(new Request(`${ORIGIN}/auth/oidc/bluesky/callback?${new URLSearchParams(s.server.answer(to))}`, { headers: { cookie: `${STATE_COOKIE}_bluesky=${cookie(jar(started)[`${STATE_COOKIE}_bluesky`])}` } }));
    assertEquals(res.status, status, `${why}: ${await res.clone().text()}`);
    assertEquals(s.links.users.size, 0, why);
  }
});

// Regression: what a person publishes chose where this service fetched, with
// its whole network reachable.
Deno.test("a Bluesky sign-in reaches only public https addresses, whatever a DID document names", async () => {
  const s = await setupBluesky(atprotoServer({ sub: "did:plc:insideinsideinsideinsid2" }));
  const started = await s.serve(new Request(`${ORIGIN}/auth/oidc/bluesky/start`));
  const to = new URL(started.headers.get("location")!);
  const back = new Request(`${ORIGIN}/auth/oidc/bluesky/callback?${new URLSearchParams(s.server.answer(to))}`, { headers: { cookie: `${STATE_COOKIE}_bluesky=${jar(started)[`${STATE_COOKIE}_bluesky`]}` } });
  const failed = await assertRejects(() => s.serve(back));
  const causes: string[] = [];
  for (let e: unknown = failed; e instanceof Error; e = e.cause) causes.push(e.message);
  assert(causes.some((m) => m.includes("https://metadata.google.internal/.well-known/oauth-protected-resource, which is no public https address")), causes.join(" <- "));
  // Regression: a public-looking name was trusted whatever address it named.
  const rebound = await setupBluesky(atprotoServer({ sub: "did:plc:rebindrebindrebindrebind" }));
  const again = await rebound.serve(new Request(`${ORIGIN}/auth/oidc/bluesky/start`));
  const sent = new URL(again.headers.get("location")!);
  const back2 = new Request(`${ORIGIN}/auth/oidc/bluesky/callback?${new URLSearchParams(rebound.server.answer(sent))}`, { headers: { cookie: `${STATE_COOKIE}_bluesky=${jar(again)[`${STATE_COOKIE}_bluesky`]}` } });
  const failed2 = await assertRejects(() => rebound.serve(back2));
  const causes2: string[] = [];
  for (let e: unknown = failed2; e instanceof Error; e = e.cause) causes2.push(e.message);
  assert(causes2.some((m) => m.includes("https://rebind.test/.well-known/oauth-protected-resource, which is no public https address")), causes2.join(" <- "));
  assertEquals(rebound.links.users.size, 0);
  assertEquals(s.links.users.size, 0);
  // A start names no server of the person's: the entryway is the only way in.
  const named = await s.serve(new Request(`${ORIGIN}/auth/oidc/bluesky/start?handle=${encodeURIComponent("https://10.0.0.1")}`));
  assertEquals(new URL(named.headers.get("location")!).origin, "https://bsky.social");
  // A return address too long for the state cookie is refused before the provider.
  assertEquals((await s.serve(new Request(`${ORIGIN}/auth/oidc/bluesky/start?return=/${"a".repeat(3000)}`))).status, 400);
});

Deno.test("an address inside a network is none AT Protocol reaches", () => {
  for (const inside of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert(!publicAddress(inside), inside);
  }
  for (const outside of ["93.184.216.34", "172.32.0.1", "2606:4700::1111"]) assert(publicAddress(outside), outside);
  assert(!publicHttps(new URL("https://metadata.google.internal./x")), "a trailing dot is the same name");
});

Deno.test("a Bluesky server unavailable or slowing sign-ins down is no refusal of the person: it fails loudly", async () => {
  const s = await setupBluesky(atprotoServer({ tokenStatus: 429 }));
  const started = await s.serve(new Request(`${ORIGIN}/auth/oidc/bluesky/start`));
  const to = new URL(started.headers.get("location")!);
  const back = new Request(`${ORIGIN}/auth/oidc/bluesky/callback?${new URLSearchParams(s.server.answer(to))}`, { headers: { cookie: `${STATE_COOKIE}_bluesky=${jar(started)[`${STATE_COOKIE}_bluesky`]}` } });
  await assertRejects(() => s.serve(back));
  await assertRejects(() => s.serve(new Request(`${ORIGIN}/auth/oidc/bluesky/callback?error=temporarily_unavailable`)), Error, "unavailable");
  assertEquals((await s.serve(new Request(`${ORIGIN}/auth/oidc/bluesky/callback?error=access_denied`))).status, 401);
});

Deno.test("Bluesky names no client, issuer or secret of a deployment's, and offers no native sign-in", async () => {
  assertThrows(() => providersFrom((n) => ({ ...BLUESKY, OIDC_BLUESKY_CLIENT_ID: "abc" })[n]), Error, "whose client is the origin");
  assertThrows(() => providersFrom((n) => ({ ...BLUESKY, OIDC_BLUESKY_ISSUER: "https://x.test" })[n]), Error, "means nothing");
  assertThrows(() => providersFrom((n) => ({ ...BLUESKY, OIDC_BLUESKY_ENTRYWAY: "http://x.test" })[n]), Error, "is not https on 443");
  assertThrows(() => providersFrom((n) => ({ ...BLUESKY, OIDC_BLUESKY_ENTRYWAY: "https://x.test:8443" })[n]), Error, "is not https on 443");
  const s = await setupBluesky();
  assertEquals((await s.serve(new Request(`${ORIGIN}/auth/oidc/bluesky/start?return=native&scheme=snapcards`))).status, 400);
  assertEquals(await (await s.serve(new Request(`${ORIGIN}/auth/oidc`))).json(), { providers: ["bluesky"], credential: {} });
});

// Adding a way: the account is the device's own session's (core.ts's
// `adding`), never one the request names.
let current = "acct-1";
const owned = (owner: string): Config["adding"] => () =>
  Promise.resolve({ owner: owner === "*" ? current : owner, way: { kind: "passkey", credential: "c1" }, since: now() });

Deno.test("a provider's button adds its subject to the device's account, signing no one in, and leaves one another account holds", async () => {
  const s = await setup(CREDENTIAL, memory(), ORIGIN, owned("acct-1"));
  const added = await credentialSignIn(s, { add: true });
  assertEquals([added.status, await added.json()], [200, { added: true }]);
  assertEquals(jar(added)[SESSION_COOKIE], undefined);
  assertEquals([...s.links.users.values()].map((u) => u.id), ["acct-1"]);
  const other = await setup(CREDENTIAL, s.links, ORIGIN, owned("acct-2"));
  const taken = await credentialSignIn(other, { add: true });
  assertEquals([taken.status, await taken.json()], [409, { error: "taken" }]);
  // A session not recent enough to add is handed no nonce to add with.
  const stale = await setup(CREDENTIAL, memory(), ORIGIN, () => Promise.resolve(new Response(null, { status: 401 })));
  assertEquals((await stale.serve(new Request(`${ORIGIN}/auth/oidc/google/nonce?add`))).status, 401);
});

Deno.test("a redirect adds its subject to the account the start was for, while this device is still signed in to it", async () => {
  const s = await setup(GOOGLE, memory(), ORIGIN, owned("acct-1"));
  const started = await s.serve(new Request(`${ORIGIN}/auth/oidc/google/start`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ return: "/chapter/8#top", add: "" }),
  }));
  assertEquals(started.status, 303);
  const to = new URL(started.headers.get("location")!);
  const done = await s.serve(callback({ code: s.idp.authorize(to), state: to.searchParams.get("state")! }, jar(started)[`${STATE_COOKIE}_google`]));
  assertEquals([done.status, done.headers.get("location")], [303, "/chapter/8#ways=added"]);
  assertEquals(jar(done)[SESSION_COOKIE], undefined);
  assertEquals([...s.links.users.values()].map((u) => u.id), ["acct-1"]);
  const moved = await setup(GOOGLE, s.links, ORIGIN, owned("acct-2"));
  const again = await moved.serve(new Request(`${ORIGIN}/auth/oidc/google/start`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ return: "/", add: "" }),
  }));
  const back = new URL(again.headers.get("location")!);
  const taken = await moved.serve(callback({ code: moved.idp.authorize(back), state: back.searchParams.get("state")! }, jar(again)[`${STATE_COOKIE}_google`]));
  assertEquals(taken.headers.get("location"), "/#ways=taken");
});

Deno.test("a nonce asked to add a way adds only to the account it was asked for, and signs no one in", async () => {
  const s = await setup(CREDENTIAL, memory(), ORIGIN, owned("*"));
  const credential = async (form: Record<string, string>, nonceQuery: string) => {
    const asked = await s.serve(new Request(`${ORIGIN}/auth/oidc/google/nonce${nonceQuery}`));
    const { nonce } = await asked.json();
    return { nonce, cookie: jar(asked)[`${NONCE_COOKIE}_google`], post: async (token: string, cookie: string) =>
      await s.serve(new Request(`${ORIGIN}/auth/oidc/google/credential`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: `${NONCE_COOKIE}_google=${cookie}` },
        body: new URLSearchParams({ credential: token, ...form }),
      })) };
  };
  // The device signs in to another account while the chooser is open.
  current = "acct-1";
  const forA = await credential({ add: "" }, "?add");
  current = "acct-2";
  const swapped = await forA.post(await s.idp.mint("client-123", forA.nonce), forA.cookie);
  assertEquals(swapped.status, 409);
  assertEquals(s.links.users.size, 0);
  // A nonce asked to sign in adds nothing, and one asked to add signs no one in.
  const signing = await credential({}, "");
  assertEquals((await signing.post(await s.idp.mint("client-123", signing.nonce), signing.cookie)).status, 200);
  const adding = await credential({}, "?add");
  assertEquals((await adding.post(await s.idp.mint("client-123", adding.nonce, { sub: "bob-sub" }), adding.cookie)).status, 409);
  current = "acct-1";
});

Deno.test("device credentials are host-only on HTTPS and legacy cookies cannot occupy a session", async () => {
  let live = true;
  const user = { id: "alice", handle: "alice" };
  for (const origin of ["https://app.test", "http://localhost"]) {
    const secure = origin.startsWith("https:");
    const d = deviceSession({ secret: SECRET, origin: () => origin, still: async () => live ? user : null, issue: async () => "access" });
    const req = (cookie = "") => new Request(`${origin}/auth/session`, { method: "POST", headers: { cookie } });
    const name = secure ? SESSION_COOKIE : "mecha_session";
    const set = await d.signedIn(req(), user.id, { kind: "guest" }, { acr: "0" });
    const session = set.find((c) => c.startsWith(`${name}=`))!;
    assert(session);
    assert(session.includes(secure ? "Path=/;" : "Path=/auth;"));
    assertEquals(session.includes("; Secure"), secure);
    assert(!/domain=/i.test(session));
    const raw = session.split(";")[0];
    assertEquals(await d.hasSession(req(raw)), true);
    assertEquals((await d.route(req(raw)))!.status, 200);
    const wrongName = secure ? "mecha_session" : SESSION_COOKIE;
    const planted = `${wrongName}=${raw.slice(raw.indexOf("=") + 1)}`;
    assertEquals(await d.hasSession(req(planted)), false);
    assertEquals((await d.route(req(planted)))!.status, 401);
    assertEquals(await d.hasSession(req(`${name}=invalid`)), false);
    live = false;
    assertEquals(await d.hasSession(req(raw)), false);
    live = true;
    const offer = await d.held(req(), user.id, { kind: "guest" }, { acr: "0" });
    const heldName = secure ? HELD_COOKIE : "mecha_session_held";
    assert(offer.cookies[0].startsWith(`${heldName}=`));
    assert(offer.cookies[0].includes(secure ? "Path=/;" : "Path=/auth;"));
    assertEquals((await d.route(req(offer.cookies[0].split(";")[0])))!.status, 409);
    for (const cookie of d.signedOut(req())) assert(cookie.includes("Max-Age=0"));
  }
});

Deno.test("HTTPS provider state ignores an otherwise valid verifier under the old cookie name", async () => {
  const s = await setup();
  const start = await begin(s.serve);
  assert(start.cookie.startsWith(`${STATE_COOKIE}_google=`));
  assert(start.cookie.includes("Path=/;") && start.cookie.includes("; Secure") && !/domain=/i.test(start.cookie));
  const code = s.idp.authorize(start.to);
  const res = await s.serve(new Request(`${ORIGIN}/auth/oidc/google/callback?${new URLSearchParams({ code, state: start.state })}`, {
    headers: { cookie: `mecha_oidc_state=${start.verifier}` },
  }));
  assertEquals(res.status, 400);
});

Deno.test("HTTP development completes provider sign-in with callback-scoped state and unprefixed session cookies", async () => {
  const origin = "http://localhost";
  const s = await setup(GOOGLE, memory(), origin);
  const start = await s.serve(new Request(`${origin}/auth/oidc/google/start`));
  const to = new URL(start.headers.get("location")!);
  const stateCookie = start.headers.getSetCookie()[0];
  assert(stateCookie.startsWith("mecha_oidc_state="));
  assert(stateCookie.includes("Path=/auth/oidc/google/callback;") && !stateCookie.includes("; Secure"));
  const res = await s.serve(new Request(`${origin}/auth/oidc/google/callback?${new URLSearchParams({ code: s.idp.authorize(to), state: to.searchParams.get("state")! })}`, {
    headers: { cookie: stateCookie.split(";")[0] },
  }));
  assertEquals(res.status, 303);
  assert(res.headers.getSetCookie().some(cookie => cookie.startsWith("mecha_session=") && cookie.includes("Path=/auth;")));
  assert(res.headers.getSetCookie().every(cookie => !cookie.startsWith("__Host-")));
});

Deno.test("cookie names preserve non-HTTP whitespace instead of manufacturing a host prefix", () => {
  for (const space of ["\u00a0", "\v", "\f"]) {
    const req = new Request(`${ORIGIN}/auth/session`, { headers: { cookie: `${space}${SESSION_COOKIE}=planted; ${SESSION_COOKIE}=own` } });
    assertEquals(cookieOf(req, SESSION_COOKIE), "own");
  }
  assertEquals(cookieOf(new Request(ORIGIN, { headers: { cookie: `other=1; \t${SESSION_COOKIE}=own` } }), SESSION_COOKIE), "own");
});

Deno.test("keySource configures a JWKS timeout past jose's 5s default for cold or key-generating providers", async () => {
  // Regression: Hydra's first GET /.well-known/jwks.json on Cloud Run took ~6s
  // while generating its signing key pair, tripping jose's 5s JWKSTimeout.
  assertEquals(JWKS_TIMEOUT_MS, 30_000);
  const { publicKey } = await generate("RS256");
  const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
  const delayedFetcher = (delayMs: number): typeof fetch => (_input, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ keys: [jwk] })), delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal!.reason);
      }, { once: true });
    });
  const token = { payload: "", protected: "", signature: "" };
  await assertRejects(
    async () => await keySource(delayedFetcher(200), 30)("https://jwks.test/jwks")({ alg: "RS256", kid: "k1" }, token),
    errors.JWKSTimeout,
  );
  const resolved = await keySource(delayedFetcher(30), 500)("https://jwks.test/jwks")({ alg: "RS256", kid: "k1" }, token);
  assert(resolved instanceof CryptoKey);
});
