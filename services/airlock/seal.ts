// A secret field's seal (pronto's #Field.secret), as Kubernetes' Sealed Secrets
// and libsodium's sealed box seal a value to its one reader: the screen
// encrypts what its reader typed to the airlock's public key, so only
// ciphertext crosses the door, crud, the database and its logs, and only the
// holder of the private key, the airlock, opens it, in memory, just before its
// handler's call. Both airlocks, the container's and the edge's dispatcher,
// open with this module; omnishell's data-sync.js seals with the same
// constants, and seal_test.ts holds the two to one envelope.
//
// RSA-OAEP with SHA-256 over a 3072-bit key: the one WebCrypto encryption
// every browser, Deno and workerd hold without a line of key schedule of our
// own, and the value fits one block (318 bytes), so no hybrid scheme, HPKE's
// included, buys anything for it. The OAEP label binds a sealed value to the
// table, field and row it was typed for, so it opens nowhere else.
//
// The private key is a deployment secret, AIRLOCK_SEAL_KEY: base64 PKCS#8, never
// in the program or the database. AIRLOCK_SEAL_KEY_PREVIOUS keeps the key a
// rotation replaced, for as long as a value sealed to it may still wait: the
// five minutes a sealed value lives. `deno run seal-key.ts` prints a new key.

export const SEAL_ALGORITHM = { name: "RSA-OAEP", hash: "SHA-256" } as const;
export const SEAL_BITS = 3072;
/** How long a sealed value waits for its effect: what typing a PIN is for. */
export const SEAL_TTL_SECONDS = 300;
/** `seal1.<kid>.<ciphertext>`, base64url without padding: the shape the
 * database's stash admits (pronto's #secretStashSql) and nothing else. */
export const SEALED = /^seal1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{512})$/;

export type SealKey = { kid: string; private: CryptoKey; public: JsonWebKey };
export type SealKeys = { current: SealKey; previous?: SealKey };

export class SealError extends Error {}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

/** The key's id: the first 96 bits of its public key's SPKI digest. */
export async function sealKid(publicJwk: JsonWebKey): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", publicJwk, SEAL_ALGORITHM, true, ["encrypt"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", key));
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", spki))).slice(0, 16);
}

/** One private key, base64 PKCS#8, with the public key it implies. */
export async function sealKey(pkcs8: string): Promise<SealKey> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = unb64(pkcs8.trim());
  } catch {
    throw new SealError("a seal key is base64 PKCS#8");
  }
  const extractable = await crypto.subtle.importKey("pkcs8", bytes, SEAL_ALGORITHM, true, ["decrypt"]);
  const jwk = await crypto.subtle.exportKey("jwk", extractable);
  if (jwk.kty !== "RSA" || !jwk.n || unb64(jwk.n).length * 8 !== SEAL_BITS) throw new SealError(`a seal key is ${SEAL_BITS}-bit RSA`);
  const pub: JsonWebKey = { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RSA-OAEP-256", ext: true, key_ops: ["encrypt"] };
  // Held unextractable from here on: nothing in the process can read it back.
  const priv = await crypto.subtle.importKey("pkcs8", bytes, SEAL_ALGORITHM, false, ["decrypt"]);
  return { kid: await sealKid(pub), private: priv, public: pub };
}

/** The id of the repository's development key (dev-seal.key), which the
 * local stack alone seals to: a key is known by its id, however its PKCS#8
 * is spelled. */
export const DEV_SEAL_KID = "vRlQ6_taRMJ1tb6v";

/** Whether this is the local stack, which alone seals to the development key:
 * it says so with AIRLOCK_SEAL_DEV=local. A release names itself with
 * AIRLOCK_RELEASE, and a release that also claims to be the local stack is
 * refused rather than believed, whichever of its environments said so. */
export function sealLocal(env: { get(name: string): string | undefined }): boolean {
  const dev = env.get("AIRLOCK_SEAL_DEV") ?? "";
  const release = env.get("AIRLOCK_RELEASE") ?? "";
  if (dev !== "" && release !== "") throw new SealError(`AIRLOCK_SEAL_DEV=${dev} in the ${release} release: only the local stack says so, and it seals to the development key`);
  return dev === "local";
}

/** The keys, refused where either is the development key and the stack is not
 * the local one (sealLocal). */
export function refuseDevKey(keys: SealKeys, local: boolean): SealKeys {
  if (local) return keys;
  for (const [name, key] of [["AIRLOCK_SEAL_KEY", keys.current], ["AIRLOCK_SEAL_KEY_PREVIOUS", keys.previous]] as const) {
    if (key?.kid === DEV_SEAL_KID) throw new SealError(`${name} is the development key in the repository, which only the local stack seals to: give this deployment a key of its own (seal-key.ts prints one)`);
  }
  return keys;
}

/** The current key and the one a rotation replaced, as the environment names them. */
export async function sealKeys(current: string, previous?: string): Promise<SealKeys> {
  return { current: await sealKey(current), ...(previous ? { previous: await sealKey(previous) } : {}) };
}

/** What a sealed value is bound to: the row it was typed for, by its key. */
export function sealLabel(table: string, field: string, pk: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`pronto-secret\n${table}\n${field}\n${pk}`);
}

/** The value sealed to a public key: what the screen sends, here for tests
 * and tools. */
export async function seal(publicJwk: JsonWebKey, value: string, label: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", publicJwk, SEAL_ALGORITHM, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP", label }, key, new TextEncoder().encode(value)));
  return `seal1.${await sealKid(publicJwk)}.${b64url(ciphertext)}`;
}

/** The value a sealed envelope holds, opened by whichever key it names. A
 * value sealed to a key this airlock does not hold, to another row, or
 * tampered with, does not open. */
export async function openSealed(keys: SealKeys, envelope: string, label: Uint8Array<ArrayBuffer>): Promise<string> {
  const m = SEALED.exec(envelope);
  if (!m) throw new SealError("not a sealed value");
  const key = [keys.current, keys.previous].find((k) => k?.kid === m[1]);
  if (!key) throw new SealError(`sealed to key ${m[1]}, which this airlock does not hold`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await crypto.subtle.decrypt({ name: "RSA-OAEP", label }, key.private, unb64(m[2])));
  } catch {
    throw new SealError("the sealed value does not open for this row");
  }
}

/** A row's secret fields opened, or why one is missing: never written, past
 * its five minutes, or sealed to no key this airlock holds or to another row.
 * The missing is what a failed outcome records. */
export type Opened = { values: Record<string, string>; missing?: { secrets: string[]; reason: "absent" | "unsealable" } };

/** Each of `fields` opened from `sealed`, the row's sealed values by field, for
 * the row it was sealed to; both airlocks open here. */
export async function openFields(keys: SealKeys, table: string, pk: string, fields: string[], sealed: Record<string, string>): Promise<Opened> {
  const absent = fields.filter((f) => !(f in sealed));
  if (absent.length > 0) return { values: {}, missing: { secrets: absent, reason: "absent" } };
  const values: Record<string, string> = {};
  const unsealable: string[] = [];
  for (const field of fields) {
    try {
      values[field] = await openSealed(keys, sealed[field], sealLabel(table, field, pk));
    } catch (e) {
      if (!(e instanceof SealError)) throw e;
      console.error(`${table} ${pk}: secret field ${field} does not open: ${e.message}`);
      unsealable.push(field);
    }
  }
  return unsealable.length > 0 ? { values: {}, missing: { secrets: unsealable, reason: "unsealable" } } : { values };
}

/** A new private key, base64 PKCS#8: what a release sets AIRLOCK_SEAL_KEY to. */
export async function generateSealKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ ...SEAL_ALGORITHM, modulusLength: SEAL_BITS, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["encrypt", "decrypt"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let text = "";
  for (let i = 0; i < pkcs8.length; i += 0x8000) text += String.fromCharCode(...pkcs8.subarray(i, i + 0x8000));
  return btoa(text);
}

