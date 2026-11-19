// Sign-in through an OpenID Connect provider: the authorization code flow with
// PKCE, by redirect, so no provider script runs in any page the door serves and
// the terminal's CSP is untouched. The service is the client, found by the
// provider's discovery document: Google by default, or any issuer a deployment
// names in its place.
//
// Browser sessions bind the callback with a PKCE cookie and leave an HttpOnly
// session cookie redeemed at /auth/oidc/session. Native hosts (?return=native),
// whose auth sheet shares no cookie jar with the app's HTTP client, send their
// own PKCE S256 challenge at /start, receive a 60-second single-use ticket on
// <scheme>://auth/callback, and redeem { ticket, code_verifier } at
// /auth/oidc/session. An unlinked guest session passed on /start promotes in
// place onto a new link or merges its owned rows into an existing linked user.
//
// Pure but for what Config hands it — the origin, the links, the tickets, the
// network — so oidc_test.ts drives every refusal against a provider of its own.
import { decodeBase64Url, encodeBase64Url, randomToken, sha256url, signJwt, verifyJwt } from "./jwt.ts";
export { sha256url };

export const PREFIX = "/auth/oidc";
export const SESSION_COOKIE = "mecha_oidc";
export const STATE_COOKIE = "mecha_oidc_state";
export const HINT_COOKIE = "mecha_oidc_hint";
export const NATIVE_TICKET_TTL_S = 60;
const STATE_TTL_S = 600;
const COOKIE_TTL_S = 30 * 24 * 3600;
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

export type Profile = { provider: string; issuer: string; sub: string; name: string | null; picture: string | null; email: string | null };
/** The person as the app shows them: the handle always, the link's name and
 * email while a provider vouches for them. */
export type User = { id: string; handle: string; name?: string | null; email?: string | null };

export class PromoteError extends Error {
  constructor(readonly status: 401 | 409, message: string) {
    super(message);
  }
}

export type NativeTicket = {
  id: string;
  userId: string;
  provider: string;
  issuer: string;
  codeChallenge: string;
  ttlSeconds: number;
};

export type ConsumedTicket = {
  userId: string;
  provider: string;
  issuer: string;
  codeChallenge: string;
};

export interface Tickets {
  issue(ticket: NativeTicket): Promise<void>;
  consume(id: string): Promise<ConsumedTicket | null>;
}

export type IssuedSession = string | { token: string; refresh_token?: string };

/** What the service needs of Postgres. */
export interface Links {
  /** The user linked to this subject, made with its link when there is none;
   * when `promoteUserId` names an unlinked guest, promotes that guest onto a
   * fresh link or merges its owned rows into an existing linked user. */
  userFor(p: Profile, promoteUserId?: string | null): Promise<User>;
  /** The user, with the link's name and email, while a link of `provider`
   * still names them. */
  handleOf(provider: string, issuer: string, id: string): Promise<Omit<User, "id"> | null>;
  /** Checks whether `userId` is an existing unlinked guest `app_user`. */
  canPromote?(userId: string): Promise<"ok" | "already_account" | "absent">;
}

export type Config = {
  secret: string;
  /** The door this request came through, which the provider redirects back to. */
  origin: (req: Request) => string;
  providers: Record<string, Provider>;
  links: Links;
  issue: (user: User) => Promise<IssuedSession>;
  nativeSchemes?: readonly string[];
  tickets?: Tickets;
  fetcher?: typeof fetch;
};

const dec = new TextDecoder();
const enc = new TextEncoder();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const random = (bytes: number) => randomToken(bytes);

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
  const picture = typeof c.picture === "string" && c.picture.startsWith("https://") ? c.picture : null;
  // An address the provider has not verified is nobody's to prefill.
  const email = typeof c.email === "string" && c.email_verified === true && c.email.includes("@") ? c.email.trim().toLowerCase().slice(0, 254) : null;
  return { provider, issuer: p.issuer, sub: c.sub, name, picture, email };
}

/** A same-origin path to come back to, or the root: never another origin, and
 * never the auth service's own routes. */
export function safeReturn(raw: string | null): string {
  if (raw === null || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.startsWith("/auth/")) return "/";
  if ([...raw].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return "/";
  return raw;
}

function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
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
  const sessionBody = async (user: User) => {
    const issued = await cfg.issue(user);
    return typeof issued === "string"
      ? { token: issued, user }
      : { token: issued.token, ...(issued.refresh_token ? { refresh_token: issued.refresh_token } : {}), user };
  };

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
    if (!claims || claims.role !== "app_user" || typeof claims.sub !== "string") return refuse(401, "invalid token");
    if (claims.guest !== true) return refuse(409, "already an account");
    if (cfg.links.canPromote) {
      const status = await cfg.links.canPromote(claims.sub);
      if (status === "absent") return refuse(401, "invalid token");
      if (status === "already_account") return refuse(409, "already an account");
    }
    return claims.sub;
  }

  async function start(req: Request, name: string): Promise<Response> {
    const p = cfg.providers[name];
    const origin = cfg.origin(req);
    const q = new URL(req.url).searchParams;
    const promote = await promoteSubject(req, q);
    if (promote instanceof Response) return promote;
    const verifier = random(32);
    const nonce = random(16);
    const challenge = await sha256url(verifier);
    let state: string;
    let cookies: string[];
    if (q.get("return") === "native") {
      if (!cfg.tickets) return refuse(400, "native sign-in is not configured");
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
      const seal = await sealVerifier(cfg.secret, verifier);
      state = await signJwt(cfg.secret, {
        purpose: "oidc",
        provider: name,
        issuer: p.issuer,
        nonce,
        seal,
        native: { scheme, challenge: appChallenge },
        ...(promote ? { promote } : {}),
        exp: now() + STATE_TTL_S,
      });
      cookies = [];
    } else {
      const ret = safeReturn(q.get("return"));
      state = await signJwt(cfg.secret, {
        purpose: "oidc",
        provider: name,
        issuer: p.issuer,
        nonce,
        bind: challenge,
        ret,
        ...(promote ? { promote } : {}),
        exp: now() + STATE_TTL_S,
      });
      cookies = [stateCookie(origin, name, verifier, STATE_TTL_S)];
    }
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
    return redirect(to.toString(), cookies);
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
    let user: User;
    try {
      user = await cfg.links.userFor(profile, typeof state.promote === "string" ? state.promote : null);
    } catch (e) {
      if (e instanceof PromoteError) return refuse(e.status, e.message);
      throw e;
    }
    if (native !== null) {
      const ticket = random(32);
      await cfg.tickets!.issue({
        id: ticket,
        userId: user.id,
        provider: name,
        issuer: p.issuer,
        codeChallenge: native.challenge as string,
        ttlSeconds: NATIVE_TICKET_TTL_S,
      });
      return redirect(`${native.scheme as string}://auth/callback?ticket=${encodeURIComponent(ticket)}`, []);
    }
    const session = await signJwt(cfg.secret, { purpose: "oidc-session", provider: name, issuer: p.issuer, sub: user.id, exp: now() + COOKIE_TTL_S });
    return redirect(safeReturn(typeof state.ret === "string" ? state.ret : null), [
      `${SESSION_COOKIE}=${session}; Path=${PREFIX}; HttpOnly; SameSite=Lax${secure(origin)}; Max-Age=${COOKIE_TTL_S}`,
      `${HINT_COOKIE}=${name}; Path=/; SameSite=Lax${secure(origin)}; Max-Age=${COOKIE_TTL_S}`,
      stateCookie(origin, name, "", 0),
    ]);
  }

  async function session(req: Request): Promise<Response> {
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== cfg.origin(req)) return refuse(403, "another origin");
    const rawBody = await req.text();
    if (rawBody.trim() !== "") {
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return refuse(400, "invalid json body");
      }
      if (!isObject(body)) return refuse(400, "invalid json body");
      if ("ticket" in body || "code_verifier" in body) {
        if (!cfg.tickets) return refuse(400, "native sign-in is not configured");
        if (typeof body.ticket !== "string" || body.ticket === "" || typeof body.code_verifier !== "string" || body.code_verifier === "") {
          return refuse(400, "ticket and code_verifier required");
        }
        const consumed = await cfg.tickets.consume(body.ticket);
        if (consumed === null) return refuse(401, "invalid ticket");
        if (!PKCE_VERIFIER.test(body.code_verifier) || (await sha256url(body.code_verifier)) !== consumed.codeChallenge) {
          return refuse(401, "invalid code_verifier");
        }
        if (!Object.hasOwn(cfg.providers, consumed.provider) || cfg.providers[consumed.provider].issuer !== consumed.issuer) {
          return refuse(401, "not signed in");
        }
        const who = await cfg.links.handleOf(consumed.provider, consumed.issuer, consumed.userId);
        if (who === null) return refuse(401, "not signed in");
        const user: User = { id: consumed.userId, ...who };
        return new Response(JSON.stringify(await sessionBody(user)), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
    }
    const raw = cookieOf(req, SESSION_COOKIE);
    if (raw === null) return refuse(401, "not signed in");
    const c = await verifyJwt(cfg.secret, raw);
    if (c === null || c.purpose !== "oidc-session" || typeof c.sub !== "string" || typeof c.provider !== "string" || typeof c.issuer !== "string") {
      return refuse(401, "not signed in");
    }
    // An issuer replacement cannot inherit the previous issuer's sessions.
    if (!Object.hasOwn(cfg.providers, c.provider) || cfg.providers[c.provider].issuer !== c.issuer) return refuse(401, "not signed in");
    // A link removed since is a sign-in revoked.
    const who = await cfg.links.handleOf(c.provider, c.issuer, c.sub);
    if (who === null) return refuse(401, "not signed in");
    const user: User = { id: c.sub, ...who };
    return new Response(JSON.stringify(await sessionBody(user)), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  function signout(req: Request): Response {
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== cfg.origin(req)) return refuse(403, "another origin");
    const door = cfg.origin(req);
    const headers = new Headers({ "cache-control": "no-store" });
    headers.append("set-cookie", `${SESSION_COOKIE}=; Path=${PREFIX}; HttpOnly; SameSite=Lax${secure(door)}; Max-Age=0`);
    headers.append("set-cookie", `${HINT_COOKIE}=; Path=/; SameSite=Lax${secure(door)}; Max-Age=0`);
    return new Response(null, { status: 204, headers });
  }

  return (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === `${PREFIX}/session`) return session(req);
    if (req.method === "POST" && path === `${PREFIX}/signout`) return Promise.resolve(signout(req));
    const m = /^\/auth\/oidc\/([a-z][a-z0-9]*)\/(start|callback)$/.exec(path);
    if (m === null || !Object.hasOwn(cfg.providers, m[1]) || req.method !== "GET") return null;
    if (speculative(req)) return Promise.resolve(refuse(400, "not a navigation"));
    return m[2] === "start" ? start(req, m[1]) : callback(req, m[1]);
  };
}
