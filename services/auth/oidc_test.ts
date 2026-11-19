// Provider sign-in against providers of the test's own, reached through the
// fetch the service is handed: Google's discovery, keys and token endpoint
// standing in for Google's, and an issuer of another name standing for one a
// deployment puts in Google's place — the client its door's origin, holding
// no secret, signing with ES256, reached inside the cluster at another
// address. Each case is a way a sign-in could be forged, replayed or
// misdirected.
// deno-lint-ignore no-import-prefix
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.13";
import { encodeBase64Url, nativeSchemesFrom, randomToken, signJwt, STACK_ISSUER } from "./jwt.ts";
import {
  type ConsumedTicket,
  discovery,
  HINT_COOKIE,
  type Links,
  type NativeTicket,
  oidc,
  PromoteError,
  type Provider,
  providersFrom,
  safeReturn,
  SESSION_COOKIE,
  sha256url,
  STATE_COOKIE,
  type Tickets,
  type User,
} from "./oidc.ts";

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

async function sign(alg: Alg, key: CryptoKey, kid: string, claims: Record<string, unknown>): Promise<string> {
  const head = b64(JSON.stringify({ alg, kid, typ: "JWT" }));
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
  let signer = { key: keys.privateKey, kid: "k1" };
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    if (url === `${base}/.well-known/openid-configuration`) {
      return Response.json({ issuer: p.issuer, authorization_endpoint: `${publicBase}/authorize`, token_endpoint: `${publicBase}/token`, jwks_uri: `${publicBase}/jwks` });
    }
    if (url === `${base}/jwks`) return Response.json({ keys: [jwk] });
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
    signWithAnotherKey(kid = "k1") {
      signer = { key: other.privateKey, kid };
    },
  };
}

function memory(): Links & { users: Map<string, User & { name: string | null; email: string | null }> } {
  const users = new Map<string, User & { name: string | null; email: string | null }>();
  return {
    users,
    userFor(p) {
      const key = `${p.provider}:${p.issuer}:${p.sub}`;
      const u = users.get(key) ?? { id: crypto.randomUUID(), handle: `h-${users.size}`, name: p.name, email: p.email };
      u.name = p.name;
      u.email = p.email;
      users.set(key, u);
      return Promise.resolve({ id: u.id, handle: u.handle, name: u.name, email: u.email });
    },
    handleOf(provider, issuer, id) {
      const hit = [...users.entries()].find(([k, u]) => u.id === id && k.startsWith(`${provider}:${issuer}:`));
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

async function setup(env = GOOGLE, links = memory()) {
  const providers = providersFrom((name) => env[name]);
  const issuer = env.OIDC_GOOGLE_ISSUER ?? "https://accounts.google.com";
  const brokered = issuer !== "https://accounts.google.com";
  const idp = await provider(
    brokered
      ? { issuer, reachedAt: env.OIDC_GOOGLE_INTERNAL || issuer, alg: "ES256" }
      : { issuer: "https://accounts.google.com", iss: "accounts.google.com", alg: "RS256", secret: "shh" },
  );
  const routes = oidc({
    secret: SECRET,
    origin: () => ORIGIN,
    providers,
    links,
    issue: (u) => signJwt(SECRET, { role: "app_user", sub: u.id, handle: u.handle, guest: false, exp: now() + 60 }),
    fetcher: idp.fetcher as typeof fetch,
  });
  const serve = async (req: Request) => {
    const res = routes(req);
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
  return { to, state: to.searchParams.get("state")!, verifier: jar(res)[STATE_COOKIE], cookie: res.headers.getSetCookie()[0] };
}

const callback = (q: Record<string, string>, verifier: string | null) =>
  new Request(`${ORIGIN}/auth/oidc/google/callback?${new URLSearchParams(q)}`, {
    headers: verifier === null ? {} : { cookie: `${STATE_COOKIE}=${verifier}` },
  });

/** A whole sign-in: start, the provider's answer, the callback. */
async function signIn(s: Awaited<ReturnType<typeof setup>>) {
  const { to, state, verifier } = await begin(s.serve);
  return await s.serve(callback({ code: s.idp.authorize(to), state }, verifier));
}

const exchange = (session: string, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/auth/oidc/session`, {
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
  assert(cookie.includes("Path=/auth/oidc/google/callback") && cookie.includes("HttpOnly") && cookie.includes("SameSite=Lax") && cookie.includes("Secure"), cookie);

  const done = await s.serve(callback({ code: s.idp.authorize(to), state }, verifier));
  assertEquals(done.status, 303);
  assertEquals(done.headers.get("location"), "/chapter/8");
  const back = jar(done);
  assertEquals(back[HINT_COOKIE], "google");
  assertEquals(back[STATE_COOKIE], "");
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

Deno.test("a discovery document naming another issuer is refused", async () => {
  const s = await setup();
  const routes = oidc({
    secret: SECRET,
    origin: () => ORIGIN,
    providers: providersFrom((name) => ({ ...GOOGLE, OIDC_GOOGLE_ISSUER: "https://not-google.test", OIDC_GOOGLE_INTERNAL: "https://accounts.google.com" })[name]),
    links: s.links,
    issue: () => Promise.resolve(""),
    fetcher: s.idp.fetcher as typeof fetch,
  });
  await assertRejects(() => routes(new Request(`${ORIGIN}/auth/oidc/google/start`))!, Error, "names the issuer https://accounts.google.com");
});

Deno.test("the session exchange is refused from another origin, without the cookie, or once the link is gone", async () => {
  const s = await setup();
  const session = jar(await signIn(s))[SESSION_COOKIE];
  assertEquals((await s.serve(exchange(session, "https://evil.test"))).status, 403);
  assertEquals((await s.serve(new Request(`${ORIGIN}/auth/oidc/session`, { method: "POST" }))).status, 401);
  const notOurs = await signJwt(SECRET, { purpose: "oidc", provider: "google", sub: s.links.users.get("google:https://accounts.google.com:alice-sub")!.id, exp: now() + 60 });
  assertEquals((await s.serve(exchange(notOurs))).status, 401);
  assertEquals((await s.serve(exchange(session, null))).status, 200);
  s.links.users.clear();
  assertEquals((await s.serve(exchange(session))).status, 401);
});

Deno.test("sign-out clears the session and its hint, and only from this origin", async () => {
  const s = await setup();
  assertEquals((await s.serve(new Request(`${ORIGIN}/auth/oidc/signout`, { method: "POST", headers: { origin: "https://evil.test" } }))).status, 403);
  const res = await s.serve(new Request(`${ORIGIN}/auth/oidc/signout`, { method: "POST", headers: { origin: ORIGIN } }));
  assertEquals(res.status, 204);
  assertEquals(jar(res), { [SESSION_COOKIE]: "", [HINT_COOKIE]: "" });
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
  const disabled = oidc({ secret: SECRET, origin: () => ORIGIN, providers: {}, links: s.links, issue: () => Promise.resolve("unused") });
  assertEquals((await disabled(exchange(cookie))!).status, 401);
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
      headers: { ...headers, cookie: `${STATE_COOKIE}=${verifier}` },
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
        codeChallenge: hit.codeChallenge,
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
    canPromote(userId) {
      const g = guests.get(userId);
      if (!g) return Promise.resolve("absent");
      return Promise.resolve(g.linked ? "already_account" : "ok");
    },
    userFor(p, promoteUserId) {
      const key = `${p.provider}:${p.issuer}:${p.sub}`;
      if (promoteUserId) {
        const g = guests.get(promoteUserId);
        if (!g) return Promise.reject(new PromoteError(401, "invalid token"));
        if (g.linked) return Promise.reject(new PromoteError(409, "already an account"));
        g.linked = true;
        const existing = users.get(key);
        if (existing) {
          existing.name = p.name;
          existing.email = p.email;
          guests.delete(promoteUserId);
          return Promise.resolve({ id: existing.id, handle: existing.handle, name: p.name, email: p.email });
        }
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
    handleOf(prov, issuer, id) {
      const hit = [...users.entries()].find(([k, u]) => u.id === id && k.startsWith(`${prov}:${issuer}:`));
      return Promise.resolve(hit ? { handle: hit[1].handle, name: hit[1].name, email: hit[1].email } : null);
    },
  };
  const store = memoryTickets();
  const routes = oidc({
    secret: SECRET,
    origin: () => ORIGIN,
    providers,
    links,
    tickets: store.tickets,
    nativeSchemes: schemes,
    issue: async (u) => ({
      token: await signJwt(SECRET, { iss: STACK_ISSUER, role: "app_user", sub: u.id, handle: u.handle, guest: false, exp: now() + 60 }),
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
    guest: true,
    exp: now() + 300,
  });
  const nonGuestToken = await signJwt(SECRET, {
    iss: STACK_ISSUER,
    role: "app_user",
    sub: guestId,
    handle: "mango-otter-1234",
    guest: false,
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

  // Once promoted, the old guest token cannot promote again.
  assertEquals(
    (await s.serve(new Request(`${ORIGIN}/auth/oidc/google/start?return=native&code_challenge=${appChallenge}`, {
      headers: { authorization: `Bearer ${guestToken}` },
    }))).status,
    409,
  );
});
