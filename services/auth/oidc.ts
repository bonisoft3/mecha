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
import { compactDecrypt, CompactEncrypt, createRemoteJWKSet, customFetch, decodeJwt, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import { type Atproto, ATPROTO_DEFAULTS, ATPROTO_ISSUER, atprotoClient, blueskyProfile, type Carried, clientMetadata, type HostAddresses, hostAddresses, publicHttps, refusedCallback, UNAVAILABLE } from "./atproto.ts";
import { isGuest, providerProof, type Proof } from "./claims.ts";
import { isSession, randomToken, sha256url, signJwt, verifyJwt } from "./jwt.ts";
import { cookieOf, type Device, type Way } from "./session.ts";
export { sha256url };

export const PREFIX = "/auth/oidc";
// Host-prefixed cookies share Path=/, so provider names isolate concurrent sign-ins.
export const STATE_COOKIE = "__Host-mecha_oidc_state";
const PLAIN_STATE_COOKIE = "mecha_oidc_state";
export const NONCE_COOKIE = "__Host-mecha_oidc_nonce";
const PLAIN_NONCE_COOKIE = "mecha_oidc_nonce";
const STATE_TTL_S = 600;
// Under the 4096 bytes a browser keeps of one cookie, attributes and all.
const COOKIE_MAX = 4000;
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
  /** Signs in by the ID token the provider's own button hands the page
   * (Google's Identity Services, FedCM where the browser has it), for the
   * client registered to the page's origins. */
  credential: boolean;
  /** Signs in by AT Protocol's OAuth (atproto.ts), not OpenID Connect. */
  atproto: Atproto | null;
};

/** The providers of AT Protocol's kind, by name. */
const ATPROTO_PROVIDERS = new Set(["bluesky"]);

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
    if (ATPROTO_PROVIDERS.has(name)) {
      // Its client is the origin's metadata document, so a deployment names
      // no client, and a person is no issuer's.
      for (const k of ["ISSUER", "CLIENT_SECRET", "CREDENTIAL", "SCOPE", "AUTHORIZE_PARAMS"]) {
        if (get(k) !== undefined) throw new Error(`${name} signs in by AT Protocol, so ${key(k)} means nothing`);
      }
      const client = get("CLIENT_ID") ?? ORIGIN_CLIENT;
      if (client !== ORIGIN_CLIENT) throw new Error(`${name} signs in by AT Protocol, whose client is the origin, so ${key("CLIENT_ID")} is ${ORIGIN_CLIENT} or unset`);
      const atproto = { entryway: get("ENTRYWAY") ?? ATPROTO_DEFAULTS.entryway, appview: get("APPVIEW") ?? ATPROTO_DEFAULTS.appview };
      for (const [k, url] of [["ENTRYWAY", atproto.entryway], ["APPVIEW", atproto.appview]]) {
        if (!publicHttps(new URL(url))) throw new Error(`${key(k)} ${url} is not https on 443 at a public name`);
      }
      providers[name] = {
        issuer: ATPROTO_ISSUER, internal: ATPROTO_ISSUER, issuers: [ATPROTO_ISSUER], client, secret: null,
        scope: "atproto", params: {}, credential: false, atproto,
      };
      continue;
    }
    const preset = PRESETS[name];
    const client = get("CLIENT_ID");
    if (!client) throw new Error(`OIDC_PROVIDERS names ${name}, so ${key("CLIENT_ID")} is required`);
    const configured = get("ISSUER");
    const issuer = configured ?? preset?.issuer;
    if (!issuer) throw new Error(`${name} is no provider the service knows, so ${key("ISSUER")} is required`);
    if (new URL(issuer).protocol !== "https:" && new URL(issuer).hostname !== "localhost") {
      throw new Error(`${key("ISSUER")} ${issuer} is not https`);
    }
    const credential = get("CREDENTIAL");
    if (credential !== undefined && credential !== "true") throw new Error(`${key("CREDENTIAL")} is ${credential}, not true`);
    if (credential !== undefined && client === ORIGIN_CLIENT) throw new Error(`${name} signs in by credential, so ${key("CLIENT_ID")} is a registered client, not ${ORIGIN_CLIENT}`);
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
      credential: credential !== undefined,
      atproto: null,
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

// jose's 5s default aborts a cold-starting or key-generating provider.
export const JWKS_TIMEOUT_MS = 30_000;

/** A provider's key set, fetched again at once for a key id it does not
 * hold, as rotation reaches a running service (jose's remote set). A token
 * names its key. */
export function keySource(fetcher: typeof fetch = fetch, timeoutDuration = JWKS_TIMEOUT_MS): (jwks: string) => JWTVerifyGetKey {
  const held = new Map<string, JWTVerifyGetKey>();
  return (jwks) => {
    let set = held.get(jwks);
    if (set === undefined) {
      const remote = createRemoteJWKSet(new URL(jwks), { [customFetch]: fetcher, cooldownDuration: 0, timeoutDuration });
      set = (header, token) => {
        if (typeof header.kid !== "string") throw new errors.JWKSNoMatchingKey();
        return remote(header, token);
      };
      held.set(jwks, set);
    }
    return set;
  };
}

// What makes a token no token of this provider's. Anything else jose raises,
// a key set the provider failed to serve among it, is the provider's fault.
const REFUSED = [
  errors.JWSInvalid, errors.JWTInvalid, errors.JWSSignatureVerificationFailed, errors.JWTClaimValidationFailed,
  errors.JWTExpired, errors.JOSEAlgNotAllowed, errors.JWKSNoMatchingKey, errors.JWKSMultipleMatchingKeys,
];

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
  sub: string;
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

/** What authorizes a change to an account's ways: the way this device
 * signed in by, and when. */
export type Authority = { way: Way; since: number | null };

export interface Links {
  /** The user linked to this subject, the link's name and picture refreshed.
   * With none, the subject is linked to `guest` while it is still a guest —
   * no passkey, no link — and otherwise to an account made for it. A subject
   * another account holds is `taken` when a guest was hinted. */
  userFor(p: Profile, guest: string | null): Promise<Found>;
  /** The subject linked to `owner`, a way into it added while `by`, the way
   * that authorized it, still stands ("revoked" otherwise): "taken" where
   * another account holds it, which is never merged, and "held" where the
   * owner already has a link of the provider. */
  addTo(p: Profile, owner: string, by: Authority): Promise<"added" | "taken" | "held" | "revoked">;
  /** The user, with the link's name and email, while a link of `provider`
   * still names them. */
  handleOf(provider: string, issuer: string, sub: string, id: string): Promise<Omit<User, "id"> | null>;
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
  /** How a host AT Protocol reaches is resolved, to refuse an inside one. */
  addresses?: HostAddresses;
  /** The account a way is added to, this device's own session's, signed in
   * recently, and the way it came in by; else the refusal to answer. */
  adding?: (req: Request) => Promise<{ owner: string } & Authority | Response>;
};

/** A provider's way while it still signs `sub` in: the provider enabled
 * under the same issuer, so a replacement cannot inherit the previous
 * issuer's sessions, and the link still there, so one removed is a sign-in
 * revoked. */
export function providerStill(providers: Record<string, Provider>, links: Links) {
  return async (way: Extract<Way, { kind: "provider" }>, sub: string): Promise<User | null> => {
    if (!Object.hasOwn(providers, way.provider) || providers[way.provider].issuer !== way.issuer) return null;
    // A way from before ways named their subject names none: signed in again.
    if (typeof way.sub !== "string") return null;
    const who = await links.handleOf(way.provider, way.issuer, way.sub, sub);
    return who === null ? null : { id: sub, ...who };
  };
}

const dec = new TextDecoder();
const enc = new TextEncoder();
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const random = (bytes: number) => randomToken(bytes);

// A native start has no cookie to keep its PKCE verifier in, so the state the
// provider sees carries it sealed.
const sealKeys = new Map<string, Promise<Uint8Array>>();
function sealKey(secret: string): Promise<Uint8Array> {
  let k = sealKeys.get(secret);
  if (k === undefined) {
    k = crypto.subtle.digest("SHA-256", enc.encode(`oidc-state-seal:${secret}`)).then((raw) => new Uint8Array(raw));
    sealKeys.set(secret, k);
  }
  return k;
}

async function sealVerifier(secret: string, verifier: string): Promise<string> {
  return await new CompactEncrypt(enc.encode(verifier)).setProtectedHeader({ alg: "dir", enc: "A256GCM" }).encrypt(await sealKey(secret));
}

async function openVerifier(secret: string, sealed: string): Promise<string | null> {
  try {
    return dec.decode((await compactDecrypt(sealed, await sealKey(secret), { keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] })).plaintext);
  } catch (e) {
    if (e instanceof errors.JOSEError) return null;
    throw e;
  }
}

/** An ID token's subject and profile, verified by jose: signed under one of
 * the provider's keys, issued by it for this client, unexpired, and carrying
 * a nonce this browser was handed (`nonce` says which). Null on any doubt. */
export async function verifyIdToken(
  provider: string,
  token: string,
  keys: JWTVerifyGetKey,
  p: { issuer: string; issuers: string[]; client: string; nonce: (claimed: string) => Promise<boolean> },
): Promise<Profile | null> {
  let c: Record<string, unknown>;
  try {
    c = (await jwtVerify(token, keys, { algorithms: ["RS256", "ES256"], issuer: p.issuers, audience: p.client, requiredClaims: ["exp", "sub"] })).payload;
  } catch (e) {
    if (REFUSED.some((kind) => e instanceof kind)) return null;
    throw e;
  }
  // A token for several audiences names the one it was handed to (OIDC Core 3.1.3.7).
  if (Array.isArray(c.aud) && c.aud.length > 1 && c.azp !== p.client) return null;
  if (typeof c.nonce !== "string" || c.nonce === "" || !(await p.nonce(c.nonce))) return null;
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
  const stateName = (origin: string, name: string) => origin.startsWith("https://") ? `${STATE_COOKIE}_${name}` : PLAIN_STATE_COOKIE;
  // Lax reaches the callback: the provider sends the reader back by a
  // top-level GET.
  const stateCookie = (origin: string, name: string, value: string, age: number) =>
    `${stateName(origin, name)}=${value}; Path=${origin.startsWith("https://") ? "/" : `${PREFIX}/${name}/callback`}; HttpOnly; SameSite=Lax${secure(origin)}; Max-Age=${age}`;
  // A cross-site POST carries no Lax cookie, and the Origin a browser sends
  // is checked besides.
  const foreign = (req: Request) => {
    const origin = req.headers.get("origin");
    return origin !== null && origin !== cfg.origin(req);
  };

  /** Whom a start is for: the guest a POSTed start names by its token, as
   * OpenID Connect's `id_token_hint`, or with `add` the device's account a
   * way is added to; neither with none. */
  type For = { guest: string | null; owner: string | null; ret: string | null };
  async function startFor(req: Request): Promise<For | Response> {
    if (req.method === "GET") return { guest: null, owner: null, ret: new URL(req.url).searchParams.get("return") };
    const form = await req.formData();
    const r = form.get("return");
    const ret = typeof r === "string" ? r : null;
    if (form.has("add")) {
      const own = await owning(req);
      return own instanceof Response ? own : { guest: null, owner: own.owner, ret };
    }
    const guest = await guestOf(form.get("id_token_hint"));
    return guest === "refused" ? refuse(400, "id_token_hint is no guest's session") : { guest, owner: null, ret };
  }
  const owning = (req: Request) => cfg.adding ? cfg.adding(req) : Promise.resolve(refuse(404, "no way is added here"));

  async function guestOf(hint: FormDataEntryValue | null): Promise<string | null | "refused"> {
    if (hint === null) return null;
    const claims = typeof hint === "string" ? await verifyJwt(cfg.secret, hint) : null;
    if (!isSession(claims) || !isGuest(claims)) return "refused";
    return claims.sub;
  }

  /** The way a provider vouched for added to the account the start was for,
   * back at `ret` with what came of it, or refused where this device's
   * session is no longer that account's, or no longer recent. */
  async function added(req: Request, profile: Profile, owner: string, ret: string, cookies: string[]): Promise<Response> {
    const still = await owning(req);
    if (still instanceof Response) return still;
    if (still.owner !== owner) return refuse(409, "this device signed in to another account since");
    const outcome = await cfg.links.addTo(profile, owner, still);
    return redirect(`${ret.split("#")[0]}#ways=${outcome}`, cookies);
  }

  /** The device signed in as the person a provider vouched for, or held for
   * them where another account holds the subject and a guest was hinted. */
  async function enter(req: Request, name: string, p: Provider, profile: Profile, guest: string | null): Promise<string[]> {
    const found = await cfg.links.userFor(profile, guest);
    const way: Way = { kind: "provider", provider: name, issuer: p.issuer, sub: profile.sub };
    // Held, not signed in: the guest stays this device's until the reader
    // takes the account.
    return "taken" in found
      ? (await cfg.device.held(req, found.taken.id, way, profile.proof)).cookies
      : await cfg.device.signedIn(req, found.id, way, profile.proof);
  }

  // The provider's button proves the person in the page; the nonce it is
  // asked with is the hash of a secret only this browser's cookie holds, sent
  // to the credential's route alone, so a token taken elsewhere signs no one in.
  const nonceName = (origin: string, name: string) => origin.startsWith("https://") ? `${NONCE_COOKIE}_${name}` : PLAIN_NONCE_COOKIE;
  const nonceCookie = (origin: string, name: string, value: string, age: number) =>
    `${nonceName(origin, name)}=${value}; Path=${origin.startsWith("https://") ? "/" : `${PREFIX}/${name}/credential`}; HttpOnly; SameSite=Strict${secure(origin)}; Max-Age=${age}`;

  // A nonce asked to add a way is bound to the account it adds to, so a
  // credential the chooser hands back after the device signed in to another
  // account adds to neither; one asked to sign in adds to none.
  const nonceOf = (secret: string, owner: string | null) => sha256url(owner === null ? secret : `${secret}:add:${owner}`);
  async function credentialNonce(req: Request, name: string): Promise<Response> {
    const own = new URL(req.url).searchParams.has("add") ? await owning(req) : null;
    if (own instanceof Response) return own;
    const secret = random(16);
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    headers.append("set-cookie", nonceCookie(cfg.origin(req), name, secret, STATE_TTL_S));
    return new Response(JSON.stringify({ nonce: await nonceOf(secret, own?.owner ?? null) }), { status: 200, headers });
  }

  // Google's script assigns markup no Trusted Types policy vouches for, so it
  // never runs in the app's page: the panel frames this page, of the same
  // origin and a policy of its own, whose script draws the button and signs
  // the device in as the credential route does, then reloads the app.
  const BUTTON_SCRIPT = "https://accounts.google.com/gsi/client";
  function credentialButton(req: Request, name: string): Response {
    const q = new URL(req.url).searchParams;
    const locale = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(q.get("hl") ?? "") ? q.get("hl")! : "";
    const mode = q.has("prompt") ? "prompt" : q.has("add") ? "add" : "button";
    const html = `<!doctype html><html data-service="${PREFIX.slice(0, -"/oidc".length)}" data-provider="${name}" data-client="${cfg.providers[name].client}" data-locale="${locale}" data-mode="${mode}"><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}#button{display:flex;justify-content:center;overflow:hidden}iframe{display:block}</style></head><body><div id="button"></div><script type="module" src="${PREFIX}/${name}/button.js"></script></body></html>`;
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": [
          "default-src 'none'",
          `script-src 'self' ${BUTTON_SCRIPT}`,
          "style-src 'unsafe-inline' https://accounts.google.com/gsi/style",
          "frame-src https://accounts.google.com/gsi/",
          "connect-src 'self' https://accounts.google.com/gsi/",
          "img-src https://*.googleusercontent.com",
          "frame-ancestors 'self'",
          "base-uri 'none'",
        ].join("; "),
      },
    });
  }
  const BUTTON_JS = `const { service, provider, client, locale, mode } = document.documentElement.dataset;
await new Promise((resolve, reject) => {
  const script = document.createElement("script");
  script.src = "${BUTTON_SCRIPT}";
  script.addEventListener("load", resolve);
  script.addEventListener("error", () => reject(new Error("Google Identity Services did not load")));
  document.head.append(script);
});
const asked = await fetch(\`\${service}/oidc/\${provider}/nonce\${mode === "add" ? "?add" : ""}\`, { credentials: "same-origin" });
// Adding on a sign-in no longer recent, the panel says to sign in again.
if (!asked.ok && mode === "add") parent.postMessage({ way: "insufficient_user_authentication", provider }, location.origin);
if (!asked.ok) throw new Error(\`\${asked.status} GET \${service}/oidc/\${provider}/nonce\`);
const { nonce } = await asked.json();
google.accounts.id.initialize({
  client_id: client,
  nonce,
  auto_select: false,
  use_fedcm_for_button: true,
  use_fedcm_for_prompt: true,
  callback: async ({ credential }) => {
    // A guest with work goes with its token, as the panel's redirect would
    // send it: read now, since another tab may have written since this loaded.
    const held = JSON.parse(localStorage.getItem("pronto-token") ?? "null");
    const hint = mode !== "add" && held?.user?.guest && held.committed ? held.token : null;
    const signed = await fetch(\`\${service}/oidc/\${provider}/credential\`, {
      method: "POST",
      credentials: "same-origin",
      body: new URLSearchParams({ credential, ...(hint === null ? {} : { id_token_hint: hint }), ...(mode === "add" ? { add: "" } : {}) }),
    });
    const { error } = signed.ok ? {} : await signed.json();
    // This browser's nonce lapsed, or another tab asked anew: this page asks
    // for a fresh one, and the person picks again.
    if (signed.status === 409 && error !== "taken" && error !== "held") return location.reload();
    // Adding, the panel framing this page says what came of it.
    if (mode === "add" && (signed.ok || error === "taken" || error === "held" || error === "insufficient_user_authentication")) {
      return parent.postMessage({ way: signed.ok ? "added" : error, provider }, location.origin);
    }
    if (!signed.ok) throw new Error(\`\${signed.status} POST \${service}/oidc/\${provider}/credential\`);
    top.location.reload();
  },
});
if (mode === "prompt") google.accounts.id.prompt();
else {
  const avail = Math.floor(document.documentElement.clientWidth);
  google.accounts.id.renderButton(document.getElementById("button"), { type: "standard", theme: "outline", size: "large", text: "continue_with", shape: "pill", ...(avail >= 200 ? { width: Math.min(400, avail) } : {}), ...(locale === "" ? {} : { locale }) });
}
`;

  async function credentialSignIn(req: Request, name: string): Promise<Response> {
    if (foreign(req)) return refuse(403, "another origin");
    const p = cfg.providers[name];
    const origin = cfg.origin(req);
    const form = await req.formData();
    const token = form.get("credential");
    if (typeof token !== "string" || token === "") return refuse(400, "credential required");
    const own = form.has("add") ? await owning(req) : null;
    if (own instanceof Response) return own;
    const guest = own === null ? await guestOf(form.get("id_token_hint")) : null;
    if (guest === "refused") return refuse(400, "id_token_hint is no guest's session");
    // A nonce that lapsed, or that another tab asked over, is the page's to
    // ask anew (409); the token's claims are read unverified only to tell so.
    const bound = cookieOf(req, nonceName(origin, name));
    if (bound === null || bound === "") return refuse(409, "no nonce stands in this browser");
    const nonce = await nonceOf(bound, own?.owner ?? null);
    let claimed: unknown;
    try {
      claimed = decodeJwt(token).nonce;
    } catch {
      return refuse(401, "credential refused");
    }
    if (claimed !== nonce) return refuse(409, "the credential was asked with another nonce");
    const ends = await endpoints(p);
    const profile = await verifyIdToken(name, token, keys(ends.jwks), {
      issuer: p.issuer, issuers: p.issuers, client: p.client, nonce: (claimed) => Promise.resolve(claimed === nonce),
    });
    if (profile === null) return refuse(401, "credential refused");
    if (own !== null) {
      const outcome = await cfg.links.addTo(profile, own.owner, own);
      const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
      headers.append("set-cookie", nonceCookie(origin, name, "", 0));
      const [status, body] = outcome === "added" ? [200, { added: true }] : outcome === "revoked" ? [401, { error: "not signed in" }] : [409, { error: outcome }];
      return new Response(JSON.stringify(body), { status, headers });
    }
    const cookies = [...await enter(req, name, p, profile, guest), nonceCookie(origin, name, "", 0)];
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    for (const c of cookies) headers.append("set-cookie", c);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
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
    if (req.method === "GET" && q.get("return") === "native") {
      return cfg.providers[name].atproto === null ? nativeStart(req, name, q) : refuse(400, `${name} offers no native sign-in`);
    }
    // A guest's start is a POST, so its token leaves no trace in a URL; one
    // from another origin would give that origin's guest this reader's
    // subject.
    if (req.method === "POST" && foreign(req)) return refuse(403, "another origin");
    const hinted = await startFor(req);
    if (hinted instanceof Response) return hinted;
    const p = cfg.providers[name];
    const origin = cfg.origin(req);
    const ret = safeReturn(hinted.ret);
    const { to, cookies } = p.atproto === null
      ? await oidcStart(origin, name, p, ret, hinted)
      : await atprotoStart(origin, name, p, ret, hinted);
    if (cookies.some((c) => c.length > COOKIE_MAX)) return refuse(400, "the return address is too long to carry");
    // A guest's start, fetched: a form's redirect to the provider is one a
    // page's CSP (form-action 'self') refuses, so the page goes there itself.
    if (req.method === "POST" && (req.headers.get("accept") ?? "").includes("application/json")) {
      const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
      for (const c of cookies) headers.append("set-cookie", c);
      return new Response(JSON.stringify({ to }), { status: 200, headers });
    }
    return redirect(to, cookies);
  }

  // An unavailable server is no refusal of the person, so it fails loudly.
  function providerError(error: string): Response {
    if (UNAVAILABLE.has(error)) throw new Error(`the provider is unavailable: ${error}`);
    return refuse(401, `the provider refused: ${error}`);
  }

  const whom = ({ guest, owner }: For) => ({ ...(guest === null ? {} : { guest }), ...(owner === null ? {} : { owner }) });

  async function oidcStart(origin: string, name: string, p: Provider, ret: string, hinted: For) {
    const verifier = random(32);
    const nonce = random(16);
    const challenge = await sha256url(verifier);
    // The verifier stays in this browser's cookie; the state, which the
    // provider sees, carries only its hash.
    const state = await signJwt(cfg.secret, {
      purpose: "oidc",
      provider: name,
      issuer: p.issuer,
      nonce,
      bind: challenge,
      ret,
      ...whom(hinted),
      exp: now() + STATE_TTL_S,
    });
    return { to: await authorizeUrl(p, origin, name, state, nonce, challenge), cookies: [stateCookie(origin, name, verifier, STATE_TTL_S)] };
  }

  // AT Protocol's client is the origin's metadata document; the flow's state,
  // the library's, travels sealed in this browser's cookie, with the app's
  // own (where to return, which guest) signed inside it.
  const atprotoFor = (origin: string, name: string, p: Provider, carried: Carried | null, carry?: (c: Carried) => void) =>
    atprotoClient({ clientId: `${origin}${PREFIX}/${name}/client-metadata.json`, redirect: callbackOf(origin, name), atproto: p.atproto!, fetcher, addresses: cfg.addresses === undefined ? hostAddresses : cfg.addresses, carried, carry });

  async function atprotoStart(origin: string, name: string, p: Provider, ret: string, hinted: For) {
    const state = await signJwt(cfg.secret, { purpose: "oidc", provider: name, issuer: p.issuer, ret, ...whom(hinted), exp: now() + STATE_TTL_S });
    let carried: Carried | null = null;
    const to = await atprotoFor(origin, name, p, null, (c) => carried = c).authorize(p.atproto!.entryway, { state });
    if (carried === null) throw new Error("the AT Protocol client kept no state");
    return { to: to.toString(), cookies: [stateCookie(origin, name, await sealVerifier(cfg.secret, JSON.stringify(carried)), STATE_TTL_S)] };
  }

  async function atprotoCallback(req: Request, name: string, p: Provider): Promise<Response> {
    const origin = cfg.origin(req);
    const q = new URL(req.url).searchParams;
    if (q.has("error")) return providerError(q.get("error")!);
    const sealed = cookieOf(req, stateName(origin, name));
    const opened = sealed === null ? null : await openVerifier(cfg.secret, sealed);
    if (opened === null) return refuse(400, "state is another browser's");
    let done;
    try {
      done = await atprotoFor(origin, name, p, JSON.parse(opened) as Carried).callback(q);
    } catch (e) {
      if (refusedCallback(e)) return refuse(401, `the provider refused: ${e.message}`);
      throw e;
    }
    const state = done.state === null || done.state === undefined ? null : await verifyJwt(cfg.secret, done.state);
    if (state === null || state.purpose !== "oidc" || state.provider !== name || state.issuer !== p.issuer) return refuse(400, "invalid state");
    const did = done.session.did;
    const shown = await blueskyProfile(p.atproto!, did, fetcher);
    const profile: Profile = { provider: name, issuer: p.issuer, sub: did, given: null, name: shown.name, picture: shown.picture, email: null, proof: {} };
    const ret = safeReturn(typeof state.ret === "string" ? state.ret : null);
    if (typeof state.owner === "string") return added(req, profile, state.owner, ret, [stateCookie(origin, name, "", 0)]);
    const cookies = await enter(req, name, p, profile, typeof state.guest === "string" ? state.guest : null);
    return redirect(ret, [...cookies, stateCookie(origin, name, "", 0)]);
  }

  async function callback(req: Request, name: string): Promise<Response> {
    const p = cfg.providers[name];
    if (p.atproto !== null) return atprotoCallback(req, name, p);
    const origin = cfg.origin(req);
    const q = new URL(req.url).searchParams;
    if (q.has("error")) return providerError(q.get("error")!);
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
      verifier = cookieOf(req, stateName(origin, name));
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
    const profile = await verifyIdToken(name, idToken, keys(ends.jwks), { issuer: p.issuer, issuers: p.issuers, client, nonce: (claimed) => Promise.resolve(claimed === state.nonce) });
    if (profile === null) return refuse(401, "id token refused");
    if (native !== null) {
      const found = await cfg.links.userFor(profile, typeof state.promote === "string" ? state.promote : null);
      const ticket = random(32);
      await cfg.tickets!.issue({
        id: ticket,
        userId: "taken" in found ? found.taken.id : found.id,
        provider: name,
        issuer: p.issuer,
        sub: profile.sub,
        codeChallenge: native.challenge as string,
        proof: profile.proof,
        held: "taken" in found,
        ttlSeconds: NATIVE_TICKET_TTL_S,
      });
      return redirect(`${native.scheme as string}://auth/callback?ticket=${encodeURIComponent(ticket)}`, []);
    }
    const ret = safeReturn(typeof state.ret === "string" ? state.ret : null);
    if (typeof state.owner === "string") return added(req, profile, state.owner, ret, [stateCookie(origin, name, "", 0)]);
    const cookies = await enter(req, name, p, profile, typeof state.guest === "string" ? state.guest : null);
    return redirect(ret, [...cookies, stateCookie(origin, name, "", 0)]);
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
    const way = { kind: "provider" as const, provider: consumed.provider, issuer: consumed.issuer, sub: consumed.sub };
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
    // turns its program's on, a local stack none (OIDC_PROVIDERS). A
    // provider signing in by credential names the client its button asks with.
    if (req.method === "GET" && path === PREFIX) {
      const credential = Object.fromEntries(Object.entries(cfg.providers).filter(([, p]) => p.credential).map(([name, p]) => [name, p.client]));
      return Promise.resolve(Response.json({ providers: Object.keys(cfg.providers), credential }, { headers: { "cache-control": "no-store" } }));
    }
    if (req.method === "POST" && path === `${PREFIX}/session`) return nativeSession(req);
    const m = /^\/auth\/oidc\/([a-z][a-z0-9]*)\/(start|callback|nonce|credential|button|button\.js|client-metadata\.json)$/.exec(path);
    if (m === null || !Object.hasOwn(cfg.providers, m[1])) return null;
    // AT Protocol's authorization server reads the client from the document
    // at its id, this origin's.
    if (m[2] === "client-metadata.json") {
      if (cfg.providers[m[1]].atproto === null || req.method !== "GET") return null;
      const origin = cfg.origin(req);
      const metadata = clientMetadata(`${origin}${PREFIX}/${m[1]}/client-metadata.json`, callbackOf(origin, m[1]));
      return Promise.resolve(Response.json(metadata, { headers: { "cache-control": "public, max-age=300" } }));
    }
    // A provider signs in by its button or by redirect, never both.
    if (["nonce", "credential", "button", "button.js"].includes(m[2]) !== cfg.providers[m[1]].credential) return null;
    if (m[2] === "button") return req.method === "GET" ? Promise.resolve(credentialButton(req, m[1])) : null;
    if (m[2] === "button.js") {
      return req.method === "GET" ? Promise.resolve(new Response(BUTTON_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } })) : null;
    }
    if (m[2] === "nonce") return req.method === "GET" ? credentialNonce(req, m[1]) : null;
    if (m[2] === "credential") return req.method === "POST" ? credentialSignIn(req, m[1]) : null;
    if (m[2] === "start" && req.method === "POST") return start(req, m[1]);
    if (req.method !== "GET") return null;
    if (speculative(req)) return Promise.resolve(refuse(400, "not a navigation"));
    return m[2] === "start" ? start(req, m[1]) : callback(req, m[1]);
  };
}
