// Sign-in through an OpenID Connect provider: the authorization code flow with
// PKCE, by redirect, so no provider script runs in any page the door serves and
// the terminal's CSP is untouched. The service is the client, found by the
// provider's discovery document: Google by default, or any issuer a deployment
// names in its place. A state JWT and a cookie holding the PKCE verifier tie
// the callback to the browser that started it, and the code is redeemed by
// this service alone. A signed-in person is an app_user linked to the
// provider's subject (identity_link), and the session is the one a passkey
// mints. A guest signs in with its token as `id_token_hint`: a subject no
// account holds becomes the guest's, and one another account holds is OpenID
// Connect's `login_required`, held for the reader to take or leave — never a
// merge. A redirect cannot write the page's storage, so the callback leaves
// the device's session, or the account held, in session.ts's cookies.
//
// Native hosts (?return=native), whose auth sheet shares no cookie jar with
// the app's HTTP client, send their own PKCE S256 challenge at /start, receive
// a 60-second single-use ticket on <scheme>://auth/callback, and redeem
// { ticket, code_verifier } at /auth/oidc/session. A guest's token passed on a
// native start is the browser's id_token_hint: a subject no account holds
// becomes the guest's, and one another account holds is login_required, its
// ticket held, so redeeming it answers the account and a ticket that switches
// to it — never a merge, on a page or in an app.
//
// Pure but for what Config hands it — the origin, the links, the tickets, the
// network — so oidc_test.ts drives every refusal against a provider of its own.
import { isGuest, providerProof, type Proof } from "./claims.ts";
import { decodeBase64Url, encodeBase64Url, isSession, randomToken, sha256url, signJwt, verifyJwt } from "./jwt.ts";
import { cookieOf, type Device, type Way } from "./session.ts";
export { sha256url };

export const PREFIX = "/auth/oidc";
export const STATE_COOKIE = "mecha_oidc_state";
const STATE_TTL_S = 600;
export const NATIVE_TICKET_TTL_S = 60;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** The client id that stands for the door a request came through. */
export const ORIGIN_CLIENT = "origin";

type Preset = { issuer: string; issuers: string[]; scope: string; params: Record<string, string> };

/** What a provider name means when the deployment names nothing else. */
export const PRESETS: Record<string, Preset> = {
  google: {
    issuer: "https://accounts.google.com",
    // Google's ID tokens name it either way.
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    scope: "openid profile email",
    params: { prompt: "select_account" },
  },
  apple: {
    issuer: "https://appleid.apple.com",
    issuers: ["https://appleid.apple.com", "appleid.apple.com"],
    scope: "openid",
    params: {},
  },
};

export type Provider = {
  /** The issuer, as readers reach it and its ID tokens name it. */
  issuer: string;
  /** Where this service reaches the issuer, when the cluster's way differs. */
  internal: string;
  issuers: string[];
  /** The registered client, or ORIGIN_CLIENT: the door's own origin. */
  client: string;
  secret: string | null;
  scope: string;
  params: Record<string, string>;
};

// Set by the flow itself, so a deployment's parameters cannot loosen it.
const RESERVED = new Set(["client_id", "redirect_uri", "response_type", "scope", "state", "nonce", "code_challenge", "code_challenge_method"]);

/** The enabled providers from OIDC_PROVIDERS and each one's OIDC_<NAME>_*:
 * CLIENT_ID always; ISSUER where no preset names one, or in its place;
 * INTERNAL, CLIENT_SECRET, SCOPE and AUTHORIZE_PARAMS where wanted. Refused at
 * startup when a provider cannot be signed in through. */
export function providersFrom(env: (name: string) => string | undefined): Record<string, Provider> {
  const providers: Record<string, Provider> = {};
  for (const name of (env("OIDC_PROVIDERS") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "")) {
    if (!/^[a-z][a-z0-9]*$/.test(name)) throw new Error(`OIDC_PROVIDERS names ${name}, which is not a lowercase word`);
    const key = (k: string) => `OIDC_${name.toUpperCase()}_${k}`;
    const get = (k: string) => env(key(k)) || undefined;
    const preset = PRESETS[name];
    const client = get("CLIENT_ID");
    if (!client) throw new Error(`OIDC_PROVIDERS names ${name}, so ${key("CLIENT_ID")} is required`);
    const configured = get("ISSUER");
    const issuer = configured ?? preset?.issuer;
    if (!issuer) throw new Error(`${name} is no provider the service knows, so ${key("ISSUER")} is required`);
    if (new URL(issuer).protocol !== "https:" && new URL(issuer).hostname !== "localhost") {
      throw new Error(`${key("ISSUER")} ${issuer} is not https`);
    }
    const params = Object.fromEntries(new URLSearchParams(get("AUTHORIZE_PARAMS") ?? ""));
    for (const p of Object.keys(params)) {
      if (RESERVED.has(p)) throw new Error(`${key("AUTHORIZE_PARAMS")} sets ${p}, which the flow sets itself`);
    }
    providers[name] = {
      issuer,
      internal: get("INTERNAL") ?? issuer,
      // A preset's aliases stand only for the preset's own issuer.
      issuers: configured === undefined && preset ? preset.issuers : [issuer],
      client,
      secret: get("CLIENT_SECRET") ?? null,
      scope: get("SCOPE") ?? preset?.scope ?? "openid",
      params: { ...(configured === undefined ? preset?.params : {}), ...params },
    };
  }
  return providers;
}

export type Endpoints = { authorize: string; token: string; jwks: string };

/** A provider's endpoints from its discovery document, held once found. The
 * reader is sent to the authorization endpoint as published; this service
 * reaches the token endpoint and the keys at `internal` where that differs. */
export function discovery(fetcher: typeof fetch = fetch): (p: Provider) => Promise<Endpoints> {
  const found = new Map<string, Promise<Endpoints>>();
  const inside = (p: Provider, url: string) => {
    const issuer = p.issuer.replace(/\/$/, "");
    const internal = p.internal.replace(/\/$/, "");
    return p.internal !== p.issuer && (url === issuer || url.startsWith(`${issuer}/`)) ? internal + url.slice(issuer.length) : url;
  };
  return (p) => {
    let hit = found.get(p.issuer);
    if (hit === undefined) {
      hit = (async () => {
        const res = await fetcher(`${p.internal.replace(/\/$/, "")}/.well-known/openid-configuration`);
        if (!res.ok) throw new Error(`${p.issuer}'s discovery: ${res.status}`);
        const d = (await res.json()) as { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
        // OpenID Connect Discovery 1.0 §4.3: the document names the issuer it was asked of.
        if (d.issuer !== p.issuer) throw new Error(`${p.issuer}'s discovery names the issuer ${d.issuer}`);
        return { authorize: d.authorization_endpoint, token: inside(p, d.token_endpoint), jwks: inside(p, d.jwks_uri) };
      })();
      // A failed lookup is asked again next time, not held.
      hit.catch(() => found.delete(p.issuer));
      found.set(p.issuer, hit);
    }
    return hit;
  };
}

/** A provider's signing keys, fetched again only for a key id not held, as
 * rotation reaches a running service. */
export function keySource(fetcher: typeof fetch = fetch): (jwks: string, kid: string) => Promise<JsonWebKey | undefined> {
  const held = new Map<string, JsonWebKey[]>();
  return async (jwks, kid) => {
    const find = () => held.get(jwks)?.find((k) => (k as { kid?: string }).kid === kid);
    if (find()) return find();
    const res = await fetcher(jwks);
    if (!res.ok) throw new Error(`${jwks}: ${res.status}`);
    held.set(jwks, ((await res.json()) as { keys: JsonWebKey[] }).keys);
    return find();
  };
}

/** A provider's subject and what it says of the person: `given` is the first
 * name (OpenID Connect's given_name), `name` the whole one. */
export type Profile = {
  provider: string;
  issuer: string;
  sub: string;
  given: string | null;
  name: string | null;
  picture: string | null;
  email: string | null;
  proof: Proof;
};
/** The person as the app shows them: the handle always, the link's name and
 * email while a provider vouches for them. */
export type User = { id: string; handle: string; name?: string | null; email?: string | null };

/** What a sign-in hinted at a guest finds: the guest itself, now holding the
 * subject, or the account that already does. */
export type Found = User | { taken: User };

export type NativeTicket = {
  id: string;
  userId: string;
  provider: string;
  issuer: string;
  codeChallenge: string;
  proof: Proof;
  /** An account another holds, found for a guest: redeemed, it is offered. */
  held: boolean;
  ttlSeconds: number;
};

export type ConsumedTicket = Omit<NativeTicket, "id" | "ttlSeconds">;

export interface Tickets {
  issue(ticket: NativeTicket): Promise<void>;
  consume(id: string): Promise<ConsumedTicket | null>;
}

export interface Links {
  /** The user linked to this subject, the link's name and picture refreshed.
   * With none, the subject is linked to `guest` while it is still a guest —
   * no passkey, no link — and otherwise to an account made for it. A subject
   * another account holds is `taken` when a guest was hinted. */
  userFor(p: Profile, guest: string | null): Promise<Found>;
  /** The user, with the link's name and email, while a link of `provider`
   * still names them. */
  handleOf(provider: string, issuer: string, id: string): Promise<Omit<User, "id"> | null>;
}

export type Config = {
  secret: string;
  /** The door this request came through, which the provider redirects back to. */
  origin: (req: Request) => string;
  providers: Record<string, Provider>;
  links: Links;
  device: Device;
  /** A native host's session, with the refresh token it renews by while `way` stands. */
  issue?: (user: User, proof: Proof, way: Way) => Promise<{ token: string; refresh_token: string }>;
  nativeSchemes?: readonly string[];
  tickets?: Tickets;
  fetcher?: typeof fetch;
};

/** A provider's way while it still signs `sub` in: the provider enabled
 * under the same issuer, so a replacement cannot inherit the previous
 * issuer's sessions, and the link still there, so one removed is a sign-in
 * revoked. */
export function providerStill(providers: Record<string, Provider>, links: Links) {
  return async (way: Extract<Way, { kind: "provider" }>, sub: string): Promise<User | null> => {
    if (!Object.hasOwn(providers, way.provider) || providers[way.provider].issuer !== way.issuer) return null;
    const who = await links.handleOf(way.provider, way.issuer, sub);
    return who === null ? null : { id: sub, ...who };
  };
}

const dec = new TextDecoder();
const enc = new TextEncoder();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const random = (bytes: number) => randomToken(bytes);

// A native start has no cookie to keep its PKCE verifier in, so the state the
// provider sees carries it sealed.
const sealKeys = new Map<string, Promise<CryptoKey>>();
function sealKey(secret: string): Promise<CryptoKey> {
  let k = sealKeys.get(secret);
  if (k === undefined) {
    k = crypto.subtle.digest("SHA-256", enc.encode(`oidc-state-seal:${secret}`))
      .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
    sealKeys.set(secret, k);
  }
  return k;
}

async function sealVerifier(secret: string, verifier: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(secret), enc.encode(verifier)));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return encodeBase64Url(packed);
}

async function openVerifier(secret: string, sealed: string): Promise<string | null> {
  try {
    const packed = decodeBase64Url(sealed);
    if (packed.length <= 12) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12) }, await sealKey(secret), packed.slice(12));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

const ALGS = {
  RS256: { kty: "RSA", import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { kty: "EC", import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
} as const;

/** An ID token's subject and profile, verified: signed under one of the
 * provider's keys, issued by it for this client, unexpired, and carrying the
 * nonce this browser was sent with. Null on any doubt. */
export async function verifyIdToken(
  provider: string,
  token: string,
  key: (kid: string) => Promise<JsonWebKey | undefined>,
  p: { issuer: string; issuers: string[]; client: string; nonce: string },
): Promise<Profile | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let head: unknown, c: unknown;
  try {
    head = JSON.parse(dec.decode(decodeBase64Url(parts[0])));
    c = JSON.parse(dec.decode(decodeBase64Url(parts[1])));
  } catch {
    return null;
  }
  if (!isObject(head) || !isObject(c)) return null;
  if (typeof head.kid !== "string" || !Object.hasOwn(ALGS, head.alg as string)) return null;
  const alg = ALGS[head.alg as keyof typeof ALGS];
  const jwk = await key(head.kid);
  if (jwk === undefined || jwk.kty !== alg.kty) return null;
  let ok: boolean;
  try {
    const pub = alg.kty === "RSA" ? { kty: "RSA", n: jwk.n, e: jwk.e } : { kty: "EC", crv: jwk.crv, x: jwk.x, y: jwk.y };
    const k = await crypto.subtle.importKey("jwk", pub, alg.import, false, ["verify"]);
    ok = await crypto.subtle.verify(alg.verify, k, decodeBase64Url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return null;
  }
  if (!ok) return null;
  if (typeof c.iss !== "string" || !p.issuers.includes(c.iss)) return null;
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(p.client)) return null;
  // A token for several audiences names the one it was handed to (OIDC Core 3.1.3.7).
  if (aud.length > 1 && c.azp !== p.client) return null;
  if (typeof c.exp !== "number" || c.exp <= Math.floor(Date.now() / 1000)) return null;
  if (p.nonce === "" || c.nonce !== p.nonce) return null;
  if (typeof c.sub !== "string" || c.sub === "" || c.sub.length > 255) return null;
  const name = typeof c.name === "string" && c.name.trim() !== "" ? c.name.trim().slice(0, 120) : null;
  const given = typeof c.given_name === "string" && c.given_name.trim() !== "" ? c.given_name.trim().slice(0, 120) : null;
  const picture = typeof c.picture === "string" && c.picture.startsWith("https://") ? c.picture : null;
  // An address the provider has not verified is nobody's to prefill.
  const email = typeof c.email === "string" && c.email_verified === true && c.email.includes("@") ? c.email.trim().toLowerCase().slice(0, 254) : null;
  return { provider, issuer: p.issuer, sub: c.sub, given, name, picture, email, proof: providerProof(c, Math.floor(Date.now() / 1000)) };
}

/** A same-origin path to come back to, or the root: never another origin, and
 * never the auth service's own routes. */
export function safeReturn(raw: string | null): string {
  if (raw === null || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.startsWith("/auth/")) return "/";
  if ([...raw].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return "/";
  return raw;
}

const redirect = (to: string, cookies: string[]) => {
  const headers = new Headers({ location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
};
const refuse = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
// Speculative GETs (an inherited Service-Worker-Navigation-Preload or link prefetch)
// are discarded when /auth/* bypasses the worker; answering them would spend a
// single-use OAuth code or overwrite the browser's PKCE state cookie.
const speculative = (req: Request) =>
  req.headers.has("service-worker-navigation-preload") ||
  /\b(prefetch|preview)\b/i.test(`${req.headers.get("sec-purpose") ?? ""},${req.headers.get("purpose") ?? ""}`);

/** The routes under PREFIX, or null for a path that is not one of them. */
export function oidc(cfg: Config): (req: Request) => Promise<Response> | null {
  const fetcher = cfg.fetcher ?? fetch;
  const endpoints = discovery(fetcher);
  const keys = keySource(fetcher);
  const now = () => Math.floor(Date.now() / 1000);
  const secure = (origin: string) => origin.startsWith("https://") ? "; Secure" : "";
  const callbackOf = (origin: string, name: string) => `${origin}${PREFIX}/${name}/callback`;
  const clientOf = (p: Provider, origin: string) => p.client === ORIGIN_CLIENT ? origin : p.client;
  // Lax reaches the callback: the provider sends the reader back by a
  // top-level GET.
  const stateCookie = (origin: string, name: string, value: string, age: number) =>
    `${STATE_COOKIE}=${value}; Path=${PREFIX}/${name}/callback; HttpOnly; SameSite=Lax${secure(origin)}; Max-Age=${age}`;
  // A cross-site POST carries no Lax cookie, and the Origin a browser sends
  // is checked besides.
  const foreign = (req: Request) => {
    const origin = req.headers.get("origin");
    return origin !== null && origin !== cfg.origin(req);
  };

  /** The guest a POSTed start names by its token, as OpenID Connect's
   * `id_token_hint`; null with none, "refused" for a token that is no
   * guest's session. */
  async function hintedGuest(req: Request): Promise<{ guest: string | null; ret: string | null } | "refused"> {
    if (req.method === "GET") return { guest: null, ret: new URL(req.url).searchParams.get("return") };
    const form = await req.formData();
    const ret = form.get("return");
    const hint = form.get("id_token_hint");
    if (hint === null) return { guest: null, ret: typeof ret === "string" ? ret : null };
    const claims = typeof hint === "string" ? await verifyJwt(cfg.secret, hint) : null;
    if (!isSession(claims) || !isGuest(claims)) return "refused";
    return { guest: claims.sub, ret: typeof ret === "string" ? ret : null };
  }

  /** The guest a native start promotes, by a bearer header or `promote_token`;
   * undefined with neither. */
  async function promoteSubject(req: Request, q: URLSearchParams): Promise<string | Response | undefined> {
    const auth = req.headers.get("authorization");
    let headerToken: string | null = null;
    if (auth !== null) {
      if (!auth.startsWith("Bearer ") || auth.length <= "Bearer ".length) return refuse(401, "invalid token");
      headerToken = auth.slice("Bearer ".length);
    }
    const queryToken = q.get("promote_token");
    if (queryToken === "") return refuse(401, "invalid token");
    if (headerToken !== null && queryToken !== null && headerToken !== queryToken) {
      return refuse(400, "conflicting promote token");
    }
    const raw = headerToken ?? queryToken;
    if (raw === null) return undefined;
    const claims = await verifyJwt(cfg.secret, raw);
    if (!isSession(claims) || claims.role !== "app_user") return refuse(401, "invalid token");
    if (!isGuest(claims)) return refuse(409, "already an account");
    return claims.sub;
  }

  async function nativeStart(req: Request, name: string, q: URLSearchParams): Promise<Response> {
    if (!cfg.tickets || !cfg.issue) return refuse(400, "native sign-in is not configured");
    const promote = await promoteSubject(req, q);
    if (promote instanceof Response) return promote;
    const allowed = cfg.nativeSchemes ?? [];
    const requestedScheme = q.get("scheme");
    if (requestedScheme !== null ? !allowed.includes(requestedScheme) : allowed.length === 0) {
      return refuse(400, "unknown native scheme");
    }
    const scheme = requestedScheme ?? allowed[0];
    const appChallenge = q.get("code_challenge");
    if (appChallenge === null || !PKCE_CHALLENGE.test(appChallenge)) {
      return refuse(400, "invalid code_challenge");
    }
    const p = cfg.providers[name];
    const origin = cfg.origin(req);
    const verifier = random(32);
    const nonce = random(16);
    const challenge = await sha256url(verifier);
    const state = await signJwt(cfg.secret, {
      purpose: "oidc",
      provider: name,
      issuer: p.issuer,
      nonce,
      seal: await sealVerifier(cfg.secret, verifier),
      native: { scheme, challenge: appChallenge },
      ...(promote ? { promote } : {}),
      exp: now() + STATE_TTL_S,
    });
    return redirect(await authorizeUrl(p, origin, name, state, nonce, challenge), []);
  }

  async function authorizeUrl(p: Provider, origin: string, name: string, state: string, nonce: string, challenge: string) {
    const to = new URL((await endpoints(p)).authorize);
    to.search = new URLSearchParams({
      ...p.params,
      client_id: clientOf(p, origin),
      redirect_uri: callbackOf(origin, name),
      response_type: "code",
      scope: p.scope,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return to.toString();
  }

  async function start(req: Request, name: string): Promise<Response> {
    const q = new URL(req.url).searchParams;
    if (req.method === "GET" && q.get("return") === "native") return nativeStart(req, name, q);
    // A guest's start is a POST, so its token leaves no trace in a URL; one
    // from another origin would give that origin's guest this reader's
    // subject.
    if (req.method === "POST" && foreign(req)) return refuse(403, "another origin");
    const hinted = await hintedGuest(req);
    if (hinted === "refused") return refuse(400, "id_token_hint is no guest's session");
    const p = cfg.providers[name];
    const origin = cfg.origin(req);
    const verifier = random(32);
    const nonce = random(16);
    const challenge = await sha256url(verifier);
    const ret = safeReturn(hinted.ret);
    // The verifier stays in this browser's cookie; the state, which the
    // provider sees, carries only its hash.
    const state = await signJwt(cfg.secret, {
      purpose: "oidc",
      provider: name,
      issuer: p.issuer,
      nonce,
      bind: challenge,
      ret,
      ...(hinted.guest === null ? {} : { guest: hinted.guest }),
      exp: now() + STATE_TTL_S,
    });
    const to = await authorizeUrl(p, origin, name, state, nonce, challenge);
    const cookies = [stateCookie(origin, name, verifier, STATE_TTL_S)];
    // A guest's start, fetched: a form's redirect to the provider is one a
    // page's CSP (form-action 'self') refuses, so the page goes there itself.
    if (req.method === "POST" && (req.headers.get("accept") ?? "").includes("application/json")) {
      const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
      for (const c of cookies) headers.append("set-cookie", c);
      return new Response(JSON.stringify({ to }), { status: 200, headers });
    }
    return redirect(to, cookies);
  }

  async function callback(req: Request, name: string): Promise<Response> {
    const p = cfg.providers[name];
    const origin = cfg.origin(req);
    const q = new URL(req.url).searchParams;
    if (q.has("error")) return refuse(401, `the provider refused: ${q.get("error")}`);
    const code = q.get("code");
    const stateToken = q.get("state");
    if (code === null || stateToken === null) return refuse(400, "no code");
    const state = await verifyJwt(cfg.secret, stateToken);
    if (state === null || state.purpose !== "oidc" || state.provider !== name || state.issuer !== p.issuer || typeof state.nonce !== "string") {
      return refuse(400, "invalid state");
    }
    const native = isObject(state.native) ? state.native : null;
    let verifier: string | null;
    if (native !== null) {
      if (
        !cfg.tickets || typeof native.scheme !== "string" || !(cfg.nativeSchemes ?? []).includes(native.scheme) ||
        typeof native.challenge !== "string" || !PKCE_CHALLENGE.test(native.challenge) || typeof state.seal !== "string"
      ) {
        return refuse(400, "invalid state");
      }
      verifier = await openVerifier(cfg.secret, state.seal);
      if (verifier === null) return refuse(400, "invalid state");
    } else {
      verifier = cookieOf(req, STATE_COOKIE);
      if (verifier === null || (await sha256url(verifier)) !== state.bind) return refuse(400, "state is another browser's");
    }
    const client = clientOf(p, origin);
    const ends = await endpoints(p);
    const exchanged = await fetcher(ends.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackOf(origin, name),
        client_id: client,
        code_verifier: verifier,
        ...(p.secret === null ? {} : { client_secret: p.secret }),
      }),
    });
    if (!exchanged.ok) return refuse(401, "the provider refused the code");
    const idToken = ((await exchanged.json()) as { id_token?: unknown }).id_token;
    if (typeof idToken !== "string") return refuse(401, "no id token");
    const profile = await verifyIdToken(name, idToken, (kid) => keys(ends.jwks, kid), { issuer: p.issuer, issuers: p.issuers, client, nonce: state.nonce });
    if (profile === null) return refuse(401, "id token refused");
    if (native !== null) {
      const found = await cfg.links.userFor(profile, typeof state.promote === "string" ? state.promote : null);
      const ticket = random(32);
      await cfg.tickets!.issue({
        id: ticket,
        userId: "taken" in found ? found.taken.id : found.id,
        provider: name,
        issuer: p.issuer,
        codeChallenge: native.challenge as string,
        proof: profile.proof,
        held: "taken" in found,
        ttlSeconds: NATIVE_TICKET_TTL_S,
      });
      return redirect(`${native.scheme as string}://auth/callback?ticket=${encodeURIComponent(ticket)}`, []);
    }
    const found = await cfg.links.userFor(profile, typeof state.guest === "string" ? state.guest : null);
    const back = safeReturn(typeof state.ret === "string" ? state.ret : null);
    const way: Way = { kind: "provider", provider: name, issuer: p.issuer };
    // Held, not signed in: the guest stays this device's until the reader
    // takes the account.
    const cookies = "taken" in found
      ? (await cfg.device.held(req, found.taken.id, way, profile.proof)).cookies
      : await cfg.device.signedIn(req, found.id, way, profile.proof);
    return redirect(back, [...cookies, stateCookie(origin, name, "", 0)]);
  }

  // A native host's ticket, with the verifier only it holds, for its session.
  async function nativeSession(req: Request): Promise<Response> {
    if (foreign(req)) return refuse(403, "another origin");
    if (!cfg.tickets || !cfg.issue) return refuse(400, "native sign-in is not configured");
    let body: unknown;
    try {
      body = JSON.parse(await req.text());
    } catch {
      return refuse(400, "invalid json body");
    }
    if (!isObject(body) || typeof body.ticket !== "string" || body.ticket === "" || typeof body.code_verifier !== "string" || body.code_verifier === "") {
      return refuse(400, "ticket and code_verifier required");
    }
    const consumed = await cfg.tickets.consume(body.ticket);
    if (consumed === null) return refuse(401, "invalid ticket");
    if (!PKCE_VERIFIER.test(body.code_verifier) || (await sha256url(body.code_verifier)) !== consumed.codeChallenge) {
      return refuse(401, "invalid code_verifier");
    }
    const way = { kind: "provider" as const, provider: consumed.provider, issuer: consumed.issuer };
    const user = await providerStill(cfg.providers, cfg.links)(way, consumed.userId);
    if (user === null) return refuse(401, "not signed in");
    // Held: the app offers the account, and the ticket answered switches to it
    // with the same verifier; left alone, it expires and the guest stays.
    if (consumed.held) {
      const ticket = random(32);
      await cfg.tickets.issue({ ...consumed, id: ticket, held: false, ttlSeconds: NATIVE_TICKET_TTL_S });
      return new Response(JSON.stringify({ error: "login_required", user: { handle: user.handle, ...(user.name ? { name: user.name } : {}) }, ticket }), {
        status: 409,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    return new Response(JSON.stringify({ ...(await cfg.issue(user, consumed.proof, way)), user }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  return (req) => {
    const path = new URL(req.url).pathname;
    // The ways in this deployment offers, which the terminal draws: a release
    // turns its program's on, a local stack none (OIDC_PROVIDERS).
    if (req.method === "GET" && path === PREFIX) {
      return Promise.resolve(Response.json({ providers: Object.keys(cfg.providers) }, { headers: { "cache-control": "no-store" } }));
    }
    if (req.method === "POST" && path === `${PREFIX}/session`) return nativeSession(req);
    const m = /^\/auth\/oidc\/([a-z][a-z0-9]*)\/(start|callback)$/.exec(path);
    if (m === null || !Object.hasOwn(cfg.providers, m[1])) return null;
    if (m[2] === "start" && req.method === "POST") return start(req, m[1]);
    if (req.method !== "GET") return null;
    if (speculative(req)) return Promise.resolve(refuse(400, "not a navigation"));
    return m[2] === "start" ? start(req, m[1]) : callback(req, m[1]);
  };
}
