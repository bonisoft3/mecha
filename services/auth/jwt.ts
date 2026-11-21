import { errors, jwtVerify, SignJWT } from "jose";

// The auth service's own tokens, HS256 through jose, and the encodings and
// lists its routes share.

const enc = new TextEncoder();

/** The `iss` every token the stack itself signs carries: the auth service's
 * people and guests, the edge's, and the service token. The tenancy floor
 * (rls.sql's mecha.stack_issuer(), which states the same value) admits the
 * cluster's own roles only from a token naming it, and a declared token role
 * only from one naming another issuer. One value for every app: the secret
 * already tells one app's tokens from another's, and the claim only tells the
 * stack's tokens from an outside issuer's. */
export const STACK_ISSUER = "mecha:stack";

// JWS's unpadded base64url over the btoa and atob every runtime that runs this
// file has: the auth service's Deno, the page, and workerd, whose bundler
// resolves no jsr: specifier.
export function encodeBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export const randomToken = (bytes = 32): string => encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
export const sha256url = async (text: string): Promise<string> =>
  encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));

const ANDROID_APK_PREFIX = "android:apk-key-hash:";
const FORBIDDEN_NATIVE_SCHEMES = new Set([
  "http",
  "https",
  "ws",
  "wss",
  "javascript",
  "data",
  "file",
  "about",
  "blob",
  "vbscript",
]);

function splitList(raw: string | readonly string[] | undefined): string[] {
  if (raw === undefined) return [];
  const items = typeof raw === "string" ? raw.split(",") : raw;
  return items.map((s) => s.trim()).filter((s) => s !== "");
}

/** Android CredentialManager WebAuthn origins (`android:apk-key-hash:<sha256-b64url>`)
 * from a comma-separated list of bare or prefixed SHA-256 hashes. */
export function androidOrigins(raw: string | readonly string[] | undefined): string[] {
  const origins = new Set<string>();
  for (const item of splitList(raw)) {
    const hash = item.startsWith(ANDROID_APK_PREFIX) ? item.slice(ANDROID_APK_PREFIX.length) : item;
    const unpadded = hash.replace(/=+$/, "");
    let valid = /^[A-Za-z0-9_-]{43}=?$/.test(hash);
    if (valid) {
      try {
        valid = decodeBase64Url(unpadded).length === 32;
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      throw new Error(`ANDROID_APK_KEY_HASHES entry ${item} is not a base64url SHA-256 hash`);
    }
    origins.add(`${ANDROID_APK_PREFIX}${unpadded}`);
  }
  return [...origins];
}

/** Custom URI schemes admitted as native OIDC redirect targets (`<scheme>://auth/callback`). */
export function nativeSchemesFrom(raw: string | readonly string[] | undefined): string[] {
  const schemes = new Set<string>();
  for (const item of splitList(raw)) {
    if (!/^[a-z][a-z0-9+.-]*$/.test(item) || FORBIDDEN_NATIVE_SCHEMES.has(item)) {
      throw new Error(`NATIVE_SCHEMES entry ${item} is not a custom URI scheme`);
    }
    schemes.add(item);
  }
  return [...schemes];
}

const keys = new Map<string, Uint8Array>();
const key = (secret: string): Uint8Array => {
  let k = keys.get(secret);
  if (k === undefined) keys.set(secret, k = enc.encode(secret));
  return k;
};

export async function signJwt(secret: string, claims: Record<string, unknown>): Promise<string> {
  return await new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(key(secret));
}

/** The claims a token carries, or null for anything that is not a live token of this secret. */
export async function verifyJwt(secret: string, token: string): Promise<Record<string, unknown> | null> {
  try {
    return (await jwtVerify(token, key(secret), { algorithms: ["HS256"], requiredClaims: ["exp"] })).payload;
  } catch (e) {
    if (e instanceof errors.JOSEError) return null;
    throw e;
  }
}

/** Whether claims are a session's: a shape token is none. */
export function isSession<C extends Record<string, unknown>>(claims: C | null): claims is C & { sub: string } {
  return claims !== null && claims.role === "app_user" && typeof claims.sub === "string";
}
