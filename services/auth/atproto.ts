// Bluesky's sign-in: AT Protocol OAuth (atproto.com/specs/oauth), by its
// own client library. Unlike OpenID Connect there is no registered client and
// no ID token: the client is the app's origin, named by the metadata document
// it serves, and the person is the DID their authorization server vouches
// for, whatever server holds their account today.
import { OAuthCallbackError, OAuthClient, OAuthResponseError, type InternalStateData, type OAuthClientMetadataInput } from "@atproto/oauth-client";
import { WebcryptoKey } from "@atproto/jwk-webcrypto";

/** What a provider of AT Protocol's kind needs besides its name. */
export type Atproto = {
  /** Where every sign-in starts: the entryway of Bluesky's accounts, whose
   * own pages ask which account. A person names no server of their own, so
   * no request can send this service anywhere it does not already go. */
  entryway: string;
  /** The public AppView a person's display name and avatar are read from. */
  appview: string;
};

export const ATPROTO_DEFAULTS: Atproto = { entryway: "https://bsky.social", appview: "https://public.api.bsky.app" };

/** Who the links table knows a Bluesky person as: a DID names them alike
 * wherever their account moves, so no server is their issuer. */
export const ATPROTO_ISSUER = "atproto";

const SCOPE = "atproto";
const DPOP_ALG = { name: "ECDSA", namedCurve: "P-256" } as const;

/** The flow's state between start and callback, as the library keeps it,
 * with its DPoP key as a JWK so the state can travel sealed in a cookie. */
export type Carried = { key: string; state: Omit<InternalStateData, "dpopKey"> & { dpopJwk: JsonWebKey } };

/** The client metadata document an origin serves at its client id: a public
 * client, holding no secret, that asks for no more than who the person is. */
export function clientMetadata(clientId: string, redirect: string): OAuthClientMetadataInput {
  return {
    client_id: clientId,
    redirect_uris: [redirect],
    scope: SCOPE,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    application_type: "web",
    token_endpoint_auth_method: "none",
    dpop_bound_access_tokens: true,
  };
}

// Every address a sign-in reaches past the entryway comes from what a person
// publishes (their DID document, their server's metadata), so it is reached
// only over https on 443, at a public name whose addresses are all public,
// never following a redirect: Workers refuse `redirect: "error"`, which the
// library's own resolvers ask for.
const PRIVATE_NAME = /(^|\.)(localhost|local|internal|arpa|home|lan|corp)$/i;
export function publicHttps(url: URL): boolean {
  const host = url.hostname.replace(/\.$/, "");
  return url.protocol === "https:" && host.includes(".") && !PRIVATE_NAME.test(host) &&
    !/^[0-9.]+$/.test(host) && !host.startsWith("[") && url.port === "";
}

/** A host's addresses, to refuse one that names an address inside a network;
 * null where the runtime reaches the public internet alone (a Worker), so
 * none could be. A name may answer otherwise by the time it is reached, which
 * TLS then refuses: no certificate of an inside service names it. */
export type HostAddresses = ((host: string) => Promise<string[]>) | null;
export const hostAddresses: HostAddresses = typeof Deno === "undefined" ? null : async (host) => {
  const found: string[] = [];
  for (const kind of ["A", "AAAA"] as const) {
    try {
      found.push(...await Deno.resolveDns(host, kind));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  return found;
};

const v4 = (a: string) => a.split(".").map(Number);
export function publicAddress(address: string): boolean {
  if (address.includes(":")) {
    const a = address.toLowerCase();
    const mapped = /^::ffff:([0-9.]+)$/.exec(a);
    if (mapped) return publicAddress(mapped[1]);
    return !(a === "::" || a === "::1" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || a.startsWith("64:ff9b:") || a.startsWith("2001:db8:"));
  }
  const [x, y] = v4(address);
  return !(x === 0 || x === 10 || x === 127 || x >= 224 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || (x === 198 && (y === 18 || y === 19)) || (x === 192 && y === 0));
}

function guarded(fetcher: typeof fetch, addresses: HostAddresses): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, { ...init, redirect: "manual" });
    const url = new URL(req.url);
    if (!publicHttps(url)) throw new Error(`AT Protocol reached for ${req.url}, which is no public https address`);
    if (addresses !== null) {
      const found = await addresses(url.hostname.replace(/\.$/, ""));
      if (found.length === 0 || !found.every(publicAddress)) throw new Error(`AT Protocol reached for ${req.url}, which is no public https address`);
    }
    const res = await fetcher(req);
    if (res.status >= 300 && res.status < 400 || res.type === "opaqueredirect") throw new Error(`${req.url} redirected, which AT Protocol forbids`);
    return res;
  };
}

/** DID documents of the two methods AT Protocol admits, read through the
 * guarded fetch. */
function didResolver(fetcher: typeof fetch) {
  return {
    async resolve(did: string, options?: { signal?: AbortSignal }) {
      const at = did.startsWith("did:plc:")
        ? `https://plc.directory/${encodeURIComponent(did)}`
        : /^did:web:[a-z0-9.-]+$/i.test(did) ? `https://${did.slice("did:web:".length)}/.well-known/did.json` : null;
      if (at === null) throw new Error(`${did} is no DID AT Protocol resolves`);
      const res = await fetcher(at, { headers: { accept: "application/did+ld+json,application/json" }, signal: options?.signal });
      if (!res.ok) throw new Error(`${res.status} GET ${at}`);
      const doc = await res.json() as { id?: unknown };
      if (doc?.id !== did) throw new Error(`${at} is not ${did}'s document`);
      return doc as never;
    },
  };
}

/** A handle's DID, as the AppView resolves it, to check the handle a DID
 * document claims; null for a handle that names no one. */
function handleResolver(appview: string, fetcher: typeof fetch) {
  return {
    async resolve(handle: string, options?: { signal?: AbortSignal }) {
      const at = `${appview}/xrpc/com.atproto.identity.resolveHandle?${new URLSearchParams({ handle })}`;
      const res = await fetcher(at, { signal: options?.signal });
      if (res.status === 400) return null;
      if (!res.ok) throw new Error(`${res.status} GET ${appview}/xrpc/com.atproto.identity.resolveHandle`);
      const { did } = await res.json() as { did?: unknown };
      return typeof did === "string" ? did as never : null;
    },
  };
}

/** Whether a failed callback is the server or the protocol refusing the
 * person (401) rather than a server out of reach or overloaded, which is no
 * refusal. */
export function refusedCallback(e: unknown): e is OAuthCallbackError {
  if (!(e instanceof OAuthCallbackError)) return false;
  const cause = e.cause;
  if (cause === undefined) return !UNAVAILABLE.has(e.params.get("error") ?? "");
  return (cause instanceof OAuthResponseError && cause.status < 500 && cause.status !== 429) ||
    (cause instanceof TypeError && cause.message === "Issuer mismatch");
}

/** The authorization errors that say the server is unavailable, not that
 * it refused the person (RFC 6749 §4.1.2.1). */
export const UNAVAILABLE = new Set(["temporarily_unavailable", "server_error"]);

async function restoreKey(jwk: JsonWebKey): Promise<WebcryptoKey> {
  const { d: _d, key_ops: _ops, ...pub } = jwk;
  return await WebcryptoKey.fromKeypair({
    privateKey: await crypto.subtle.importKey("jwk", jwk, DPOP_ALG, true, ["sign"]),
    publicKey: await crypto.subtle.importKey("jwk", pub, DPOP_ALG, true, ["verify"]),
  });
}

/** A client for one request: what it is asked to keep between start and
 * callback is handed back (`carry`) or read from what the browser brought
 * (`carried`), so no server holds a flow. Sessions it makes are never kept:
 * the sign-in needs only the DID. */
export function atprotoClient(opts: {
  clientId: string;
  redirect: string;
  atproto: Atproto;
  fetcher: typeof fetch;
  addresses: HostAddresses;
  carried?: Carried | null;
  carry?: (c: Carried) => void;
}): OAuthClient {
  const fetcher = guarded(opts.fetcher, opts.addresses);
  return new OAuthClient({
    responseMode: "query",
    fetch: fetcher,
    handleResolver: handleResolver(opts.atproto.appview, fetcher),
    didResolver: didResolver(fetcher),
    clientMetadata: clientMetadata(opts.clientId, opts.redirect),
    runtimeImplementation: {
      // No session is reused, so none is refreshed concurrently.
      requestLock: (_name, fn) => fn(),
      // ES256 alone, the one curve the callback restores.
      createKey: (algs) => {
        if (!algs.includes("ES256")) throw new Error(`the authorization server takes DPoP keys of ${algs.join(", ")}, not ES256`);
        return WebcryptoKey.generate(["ES256"], undefined, { extractable: true });
      },
      getRandomValues: (n) => crypto.getRandomValues(new Uint8Array(n)),
      digest: async (bytes, alg) => new Uint8Array(await crypto.subtle.digest(`SHA-${alg.name.slice(3)}`, bytes)),
    },
    stateStore: {
      set: async (key, { dpopKey, ...state }) => {
        const dpopJwk = (dpopKey as unknown as { privateJwk?: JsonWebKey }).privateJwk;
        if (dpopJwk === undefined) throw new Error("the DPoP key is not extractable");
        opts.carry!({ key, state: { ...state, dpopJwk } });
      },
      get: async (key) => {
        if (!opts.carried || opts.carried.key !== key) return undefined;
        const { dpopJwk, ...state } = opts.carried.state;
        return { ...state, dpopKey: await restoreKey(dpopJwk) };
      },
      del: async () => {},
    },
    sessionStore: { set: async () => {}, get: async () => undefined, del: async () => {} },
  });
}

/** The person's display name and avatar, as the public AppView shows them;
 * the handle stands for a name they never set. */
export async function blueskyProfile(atproto: Atproto, did: string, fetcher: typeof fetch): Promise<{ name: string; picture: string | null }> {
  const res = await fetcher(`${atproto.appview}/xrpc/app.bsky.actor.getProfile?${new URLSearchParams({ actor: did })}`);
  if (!res.ok) throw new Error(`${res.status} GET ${atproto.appview}/xrpc/app.bsky.actor.getProfile`);
  const p = await res.json() as { handle?: unknown; displayName?: unknown; avatar?: unknown };
  const handle = typeof p.handle === "string" ? p.handle : did;
  return {
    name: typeof p.displayName === "string" && p.displayName.trim() !== "" ? p.displayName : handle,
    picture: typeof p.avatar === "string" ? p.avatar : null,
  };
}
