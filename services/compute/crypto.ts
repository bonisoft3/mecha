// The realm's cryptography: WebCrypto's SubtleCrypto, endowed as the frozen
// global `Crypto`, admitting only what is deterministic by specification. A
// realm with no clock and no entropy can hold an operation only if the same
// inputs give the same bytes on every engine, so the rule is the spec, not the
// engine this runs on: Deno's ECDSA happens to use RFC 6979 nonces, Node's does
// not, and the WebCrypto spec leaves it open, so ECDSA signs nowhere here.
//
// Admitted: digest; sign by HMAC, RSASSA-PKCS1-v1_5, Ed25519, and RSA-PSS with
// saltLength 0; every verify and decrypt; encrypt by AES-GCM, AES-CBC and
// AES-CTR, whose IV or counter the caller gives; deriveBits and deriveKey by
// PBKDF2, HKDF, ECDH and X25519; importKey, exportKey, wrapKey by AES-KW and
// the AES modes, unwrapKey. Refused: generateKey, ECDSA sign, RSA-PSS with a
// salt, RSA-OAEP encrypt and wrap, and getRandomValues and randomUUID, which
// are not here. A key comes in as a secret and is imported; randomness a
// computation needs is derived from its inputs (HKDF of a seed and a label).
//
// Everything answers a promise, as WebCrypto does; a computation's plan and
// finish may return one. An algorithm is read once, into a frozen copy that is
// both what is checked and what WebCrypto is handed, so a getter cannot pass
// the check with one value and reach WebCrypto with another. Each call's
// promise settles after every earlier call's, so racing two answers says
// nothing about the host's threads.

const subtle = crypto.subtle;

let tail: Promise<unknown> = Promise.resolve();
function ordered<T>(p: Promise<T>): Promise<T> {
  const settled = tail.then(() => p);
  tail = settled.then(() => {}, () => {});
  return settled;
}

const CANONICAL = new Map(
  [
    "SHA-1", "SHA-256", "SHA-384", "SHA-512", "HMAC", "RSASSA-PKCS1-v1_5", "RSA-PSS", "RSA-OAEP", "ECDSA", "ECDH",
    "Ed25519", "X25519", "AES-GCM", "AES-CBC", "AES-CTR", "AES-KW", "PBKDF2", "HKDF",
  ].map((n) => [n.toUpperCase(), n]),
);

type Algorithm = Readonly<Record<string, unknown> & { name: string }>;

/** The algorithm as read once: each own property's value, the name made
 * canonical, frozen. */
function snapshot(algorithm: unknown, what: string): Algorithm {
  const copy: Record<string, unknown> = {};
  if (typeof algorithm === "string") copy.name = algorithm;
  else if (typeof algorithm === "object" && algorithm !== null) {
    for (const key of Object.keys(algorithm)) copy[key] = (algorithm as Record<string, unknown>)[key];
  }
  const raw = copy.name;
  const name = typeof raw === "string" ? CANONICAL.get(raw.toUpperCase()) : undefined;
  if (name === undefined) throw new TypeError(`Crypto.${what}: ${JSON.stringify(raw)} is not an algorithm the realm admits`);
  return Object.freeze({ ...copy, name });
}

function admit(what: string, algorithm: unknown, allowed: string[], refusal = "is not deterministic by its specification"): Algorithm {
  const a = snapshot(algorithm, what);
  if (!allowed.includes(a.name)) throw new TypeError(`Crypto.${what}: ${a.name} ${refusal}`);
  if (a.name === "RSA-PSS" && a.saltLength !== 0) {
    throw new TypeError(`Crypto.${what}: RSA-PSS with a salt is not deterministic; give saltLength 0`);
  }
  return a;
}

const AES = ["AES-GCM", "AES-CBC", "AES-CTR"];
const DERIVING = ["PBKDF2", "HKDF", "ECDH", "X25519"];

// The callers are a sandboxed module's, untyped; WebCrypto checks the rest.
type A = never;

export const Crypto = Object.freeze({
  digest: (algorithm: unknown, data: unknown) => ordered(subtle.digest(snapshot(algorithm, "digest") as A, data as A)),
  sign: (algorithm: unknown, key: unknown, data: unknown) =>
    ordered(subtle.sign(admit("sign", algorithm, ["HMAC", "RSASSA-PKCS1-v1_5", "Ed25519", "RSA-PSS"]) as A, key as A, data as A)),
  verify: (algorithm: unknown, key: unknown, signature: unknown, data: unknown) =>
    ordered(subtle.verify(snapshot(algorithm, "verify") as A, key as A, signature as A, data as A)),
  encrypt: (algorithm: unknown, key: unknown, data: unknown) => ordered(subtle.encrypt(admit("encrypt", algorithm, AES) as A, key as A, data as A)),
  decrypt: (algorithm: unknown, key: unknown, data: unknown) => ordered(subtle.decrypt(snapshot(algorithm, "decrypt") as A, key as A, data as A)),
  deriveBits: (algorithm: unknown, baseKey: unknown, length: unknown) =>
    ordered(subtle.deriveBits(admit("deriveBits", algorithm, DERIVING) as A, baseKey as A, length as A)),
  deriveKey: (algorithm: unknown, baseKey: unknown, derivedKeyType: unknown, extractable: unknown, usages: unknown) =>
    ordered(subtle.deriveKey(
      admit("deriveKey", algorithm, DERIVING) as A,
      baseKey as A,
      snapshot(derivedKeyType, "deriveKey") as A,
      extractable as A,
      usages as A,
    )),
  importKey: (format: unknown, keyData: unknown, algorithm: unknown, extractable: unknown, usages: unknown) =>
    ordered(subtle.importKey(format as A, keyData as A, snapshot(algorithm, "importKey") as A, extractable as A, usages as A)),
  exportKey: (format: unknown, key: unknown) => ordered(subtle.exportKey(format as A, key as A)),
  wrapKey: (format: unknown, key: unknown, wrappingKey: unknown, algorithm: unknown) =>
    ordered(subtle.wrapKey(format as A, key as A, wrappingKey as A, admit("wrapKey", algorithm, ["AES-KW", ...AES]) as A)),
  unwrapKey: (
    format: unknown,
    wrapped: unknown,
    unwrappingKey: unknown,
    algorithm: unknown,
    unwrappedKeyType: unknown,
    extractable: unknown,
    usages: unknown,
  ) =>
    ordered(subtle.unwrapKey(
      format as A,
      wrapped as A,
      unwrappingKey as A,
      snapshot(algorithm, "unwrapKey") as A,
      snapshot(unwrappedKeyType, "unwrapKey") as A,
      extractable as A,
      usages as A,
    )),
  generateKey: () => {
    throw new TypeError("Crypto.generateKey: a new key is entropy; a key comes in as a secret and is imported");
  },
});
