// Crypto against the published answers (FIPS 180-2's SHA-256, RFC 4231's
// HMAC-SHA256), each operation it admits shown to give the same bytes twice, and
// each it refuses refused. Keys are made by the test with the host's own
// SubtleCrypto, as a secret would be made outside the realm.

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Crypto } from "./crypto.ts";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)));
const host = crypto.subtle;
const msg = enc.encode("Booking b1 confirmed.");
const twice = async (f: () => Promise<ArrayBuffer>) => {
  const [a, b] = [hex(await f()), hex(await f())];
  assertEquals(a, b);
  return a;
};

Deno.test("digest gives FIPS 180-2's answers", async () => {
  assertEquals(hex(await Crypto.digest("SHA-256", enc.encode(""))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assertEquals(hex(await Crypto.digest("SHA-256", enc.encode("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assertEquals(
    hex(await Crypto.digest({ name: "sha-256" }, enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

Deno.test("HMAC-SHA256 gives RFC 4231's answers", async () => {
  const cases: [Uint8Array, Uint8Array, string][] = [
    [fromHex("0b".repeat(20)), enc.encode("Hi There"), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"],
    [enc.encode("Jefe"), enc.encode("what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"],
    [fromHex("aa".repeat(20)), fromHex("dd".repeat(50)), "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"],
    [fromHex("aa".repeat(131)), enc.encode("Test Using Larger Than Block-Size Key - Hash Key First"), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"],
  ];
  for (const [raw, data, mac] of cases) {
    const key = await Crypto.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    assertEquals(hex(await Crypto.sign("HMAC", key, data)), mac);
  }
});

Deno.test("what it admits gives the same bytes twice", async () => {
  const rsa = { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const pkcs1 = await host.generateKey({ name: "RSASSA-PKCS1-v1_5", ...rsa }, false, ["sign"]);
  await twice(() => Crypto.sign("RSASSA-PKCS1-v1_5", pkcs1.privateKey, msg));
  const pss = await host.generateKey({ name: "RSA-PSS", ...rsa }, false, ["sign"]);
  await twice(() => Crypto.sign({ name: "RSA-PSS", saltLength: 0 }, pss.privateKey, msg));
  const ed = await host.generateKey({ name: "Ed25519" }, false, ["sign"]) as CryptoKeyPair;
  await twice(() => Crypto.sign("Ed25519", ed.privateKey, msg));
  const aes = await Crypto.importKey("raw", new Uint8Array(32).fill(7), "AES-GCM", false, ["encrypt"]);
  await twice(() => Crypto.encrypt({ name: "AES-GCM", iv: new Uint8Array(12).fill(1) }, aes, msg));
  const pw = await Crypto.importKey("raw", enc.encode("pw"), "PBKDF2", false, ["deriveBits"]);
  await twice(() => Crypto.deriveBits({ name: "PBKDF2", salt: enc.encode("s"), iterations: 1000, hash: "SHA-256" }, pw, 256));
  const ikm = await Crypto.importKey("raw", enc.encode("seed"), "HKDF", false, ["deriveBits"]);
  // Randomness a computation needs, derived from its inputs: the same seed and label, the same bytes.
  await twice(() => Crypto.deriveBits({ name: "HKDF", salt: enc.encode(""), info: enc.encode("nonce"), hash: "SHA-256" }, ikm, 96));
});

Deno.test("what is random by its specification is refused, and the realm has no entropy", async () => {
  const rsa = { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const ec = await host.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  assertThrows(() => Crypto.sign({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, msg), TypeError, "ECDSA is not deterministic");
  const pss = await host.generateKey({ name: "RSA-PSS", ...rsa }, false, ["sign"]);
  assertThrows(() => Crypto.sign({ name: "RSA-PSS", saltLength: 32 }, pss.privateKey, msg), TypeError, "give saltLength 0");
  const oaep = await host.generateKey({ name: "RSA-OAEP", ...rsa }, false, ["encrypt", "decrypt", "wrapKey"]);
  assertThrows(() => Crypto.encrypt({ name: "RSA-OAEP" }, oaep.publicKey, msg), TypeError, "RSA-OAEP is not deterministic");
  const aes = await host.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  assertThrows(() => Crypto.wrapKey("raw", aes, oaep.publicKey, { name: "RSA-OAEP" }), TypeError, "RSA-OAEP");
  assertThrows(() => Crypto.generateKey(), TypeError, "a new key is entropy");
  assertThrows(() => Crypto.digest("MD5", msg), TypeError, "not an algorithm the realm admits");
  assertEquals(["getRandomValues", "randomUUID", "subtle"].filter((n) => n in Crypto), []);
  assertEquals(Object.isFrozen(Crypto), true);
  // A refusal is the facade's, before WebCrypto runs: an admitted algorithm's own errors stay WebCrypto's.
  await assertRejects(() => Crypto.verify({ name: "ECDSA", hash: "SHA-256" }, ec.privateKey, new Uint8Array(64), msg));
});

Deno.test("an algorithm is read once, so a getter cannot pass the check with one value and reach WebCrypto with another", async () => {
  // Each call's object answers what passes the check first and a randomized
  // choice after; the facade hands WebCrypto what it checked.
  const rsa = { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const pss = await host.generateKey({ name: "RSA-PSS", ...rsa }, false, ["sign"]);
  const saltAfterCheck = () => {
    let reads = 0;
    return { name: "RSA-PSS", get saltLength() { return reads++ === 0 ? 0 : 32; } };
  };
  await twice(() => Crypto.sign(saltAfterCheck(), pss.privateKey, msg));
  const oaep = await host.generateKey({ name: "RSA-OAEP", ...rsa }, false, ["encrypt", "decrypt"]);
  const oaepAfterCheck = () => {
    let reads = 0;
    return { get name() { return reads++ === 0 ? "AES-GCM" : "RSA-OAEP"; }, iv: new Uint8Array(12) };
  };
  // Handed AES-GCM, WebCrypto refuses the RSA key rather than encrypt by RSA-OAEP.
  await assertRejects(() => Crypto.encrypt(oaepAfterCheck(), oaep.publicKey, msg));
});

Deno.test("answers settle in call order, so a race between two says nothing about the host's threads", async () => {
  const data = new Uint8Array(1 << 16);
  for (let i = 0; i < 100; i++) {
    const first = await Promise.race([Crypto.digest("SHA-256", data).then(() => 0), Crypto.digest("SHA-256", data).then(() => 1)]);
    assertEquals(first, 0);
  }
});
