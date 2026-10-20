// Sign-in through an OpenID Connect provider: the authorization code flow with
// PKCE, by redirect, so no provider script runs in any page the door serves and
// the terminal's CSP is untouched. The service is the client, found by the
// provider's discovery document: Google by default, or any issuer a deployment
// names in its place. A state JWT and a cookie holding the PKCE verifier tie
// the callback to the browser that started it, and the code is redeemed by
// this service alone. A signed-in person is an app_user linked to the
// provider's subject (identity_link), and the session is the one a passkey
// mints. Who a guest becomes on signing in is no concern of this service: a
// subject signs into its own account, made the first time.
//
// The tab's session lives in sessionStorage, which a redirect cannot write, so
// the callback leaves an HttpOnly cookie and the terminal exchanges it at
// /auth/oidc/session. The cookie outlives the tab, so a tab opened later
// adopts the same sign-in; a readable hint cookie says one may be there.
//
// Pure but for what Config hands it — the origin, the links, the network — so
// oidc_test.ts drives every refusal against a provider of its own.
import { decodeBase64Url, encodeBase64Url, signJwt, verifyJwt } from "./jwt.ts";

export const PREFIX = "/auth/oidc";
export const SESSION_COOKIE = "mecha_oidc";
export const STATE_COOKIE = "mecha_oidc_state";
export const HINT_COOKIE = "mecha_oidc_hint";
const STATE_TTL_S = 600;
const COOKIE_TTL_S = 30 * 24 * 3600;
/** The client id that stands for the door a request came through. */
export const ORIGIN_CLIENT = "origin";

type Preset = { issuer: string; issuers: string[]; scope: string; params: Record<string, string> };

/** What a provider name means when the deployment names nothing else. */
export const PRESETS: Record<string, Preset> = {
  google: {
    issuer: "https://accounts.google.com",
    // Google's ID tokens name it either way.
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    scope: "openid profile",
    params: { prompt: "select_account" },
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
        const d = await res.json();
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
    held.set(jwks, (await res.json()).keys);
    return find();
  };
}

export type Profile = { provider: string; issuer: string; sub: string; name: string | null; picture: string | null };
export type User = { id: string; handle: string };

/** What the service needs of Postgres. */
export interface Links {
  /** The user linked to this subject, made with its link when there is none;
   * the link's name and picture refreshed either way. */
  userFor(p: Profile): Promise<User>;
  /** The user's handle while a link of `provider` still names them. */
  handleOf(provider: string, issuer: string, id: string): Promise<string | null>;
}

export type Config = {
  secret: string;
  /** The door this request came through, which the provider redirects back to. */
  origin: (req: Request) => string;
  providers: Record<string, Provider>;
  links: Links;
  issue: (user: User) => Promise<string>;
  fetcher?: typeof fetch;
};

const dec = new TextDecoder();
const enc = new TextEncoder();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const random = (bytes: number) => encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
export const sha256url = async (text: string) => encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));

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
  return { provider, issuer: p.issuer, sub: c.sub, name, picture };
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

  async function start(req: Request, name: string): Promise<Response> {
    const p = cfg.providers[name];
    const origin = cfg.origin(req);
    const verifier = random(32);
    const nonce = random(16);
    const challenge = await sha256url(verifier);
    const ret = safeReturn(new URL(req.url).searchParams.get("return"));
    // The verifier stays in this browser's cookie; the state, which the
    // provider sees, carries only its hash.
    const state = await signJwt(cfg.secret, { purpose: "oidc", provider: name, issuer: p.issuer, nonce, bind: challenge, ret, exp: now() + STATE_TTL_S });
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
    return redirect(to.toString(), [stateCookie(origin, name, verifier, STATE_TTL_S)]);
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
    const verifier = cookieOf(req, STATE_COOKIE);
    if (verifier === null || (await sha256url(verifier)) !== state.bind) return refuse(400, "state is another browser's");
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
    const idToken = (await exchanged.json()).id_token;
    if (typeof idToken !== "string") return refuse(401, "no id token");
    const profile = await verifyIdToken(name, idToken, (kid) => keys(ends.jwks, kid), { issuer: p.issuer, issuers: p.issuers, client, nonce: state.nonce });
    if (profile === null) return refuse(401, "id token refused");
    const user = await cfg.links.userFor(profile);
    const session = await signJwt(cfg.secret, { purpose: "oidc-session", provider: name, issuer: p.issuer, sub: user.id, exp: now() + COOKIE_TTL_S });
    return redirect(safeReturn(typeof state.ret === "string" ? state.ret : null), [
      `${SESSION_COOKIE}=${session}; Path=${PREFIX}; HttpOnly; SameSite=Lax${secure(origin)}; Max-Age=${COOKIE_TTL_S}`,
      `${HINT_COOKIE}=${name}; Path=/; SameSite=Lax${secure(origin)}; Max-Age=${COOKIE_TTL_S}`,
      stateCookie(origin, name, "", 0),
    ]);
  }

  // The cookie as this tab's session. A cross-site POST carries no Lax
  // cookie, and the Origin a browser sends is checked besides.
  async function session(req: Request): Promise<Response> {
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== cfg.origin(req)) return refuse(403, "another origin");
    const raw = cookieOf(req, SESSION_COOKIE);
    if (raw === null) return refuse(401, "not signed in");
    const c = await verifyJwt(cfg.secret, raw);
    if (c === null || c.purpose !== "oidc-session" || typeof c.sub !== "string" || typeof c.provider !== "string" || typeof c.issuer !== "string") {
      return refuse(401, "not signed in");
    }
    // An issuer replacement cannot inherit the previous issuer's sessions.
    if (!Object.hasOwn(cfg.providers, c.provider) || cfg.providers[c.provider].issuer !== c.issuer) return refuse(401, "not signed in");
    // A link removed since is a sign-in revoked.
    const handle = await cfg.links.handleOf(c.provider, c.issuer, c.sub);
    if (handle === null) return refuse(401, "not signed in");
    const user = { id: c.sub, handle };
    return new Response(JSON.stringify({ token: await cfg.issue(user), user }), {
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
    return m[2] === "start" ? start(req, m[1]) : callback(req, m[1]);
  };
}
