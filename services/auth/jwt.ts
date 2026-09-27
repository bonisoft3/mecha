// HS256 over WebCrypto for the auth service's tokens, and the shape predicate
// the browser cluster shares: one derivation of a `where`, so the CRUD path
// and the shape path cannot disagree about a subject's reach.
import { decodeBase64Url, encodeBase64Url } from "jsr:@std/encoding@1.0.7/base64url";

const enc = new TextEncoder();

const keys = new Map<string, Promise<CryptoKey>>();
function key(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (k === undefined) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, k);
  }
  return k;
}

export async function signJwt(secret: string, claims: Record<string, unknown>): Promise<string> {
  const head = encodeBase64Url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = encodeBase64Url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(`${head}.${payload}`)));
  return `${head}.${payload}.${encodeBase64Url(sig)}`;
}

/** The claims a token carries, or null for anything that is not a live token of this secret. */
export async function verifyJwt(secret: string, token: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await key(secret), decodeBase64Url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
    if (typeof claims.exp !== "number") return null;
    if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

/** The `where` a shape may carry, canonical so the gate compares by equality.
 * Built from `subject_scopes`, the same function `app_pre_request` uses for
 * the CRUD path: one derivation, two deliveries, so the paths cannot disagree
 * about a subject's reach without disagreeing here first. */
export function shapeWhere(scopes: string[]): string {
  // `IN ()` is no SQL; a subject with no scope reaches no row.
  if (scopes.length === 0) return "false";
  return `scope_id IN (${scopes.map((s) => `'${s.replaceAll("'", "''")}'`).join(",")})`;
}
