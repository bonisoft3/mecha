import { assertEquals, assertMatch, assertRejects, assertThrows } from "@std/assert";
import { DEV_SEAL_KID, generateSealKey, openSealed, refuseDevKey, seal, SEALED, SealError, sealKeys, sealLabel } from "./seal.ts";

const label = sealLabel("payment", "pin", "00000000-0000-0000-0000-000000000001");

Deno.test("a value sealed to the airlock's public key opens with its private key, for the row it was sealed to", async () => {
  const keys = await sealKeys(await generateSealKey());
  const sealed = await seal(keys.current.public, "4321", label);
  assertMatch(sealed, SEALED);
  assertEquals(await openSealed(keys, sealed, label), "4321");
  // Bound to the row: another row's label, field or table opens nothing.
  for (const other of [sealLabel("payment", "pin", "00000000-0000-0000-0000-000000000002"), sealLabel("payment", "otp", "00000000-0000-0000-0000-000000000001"), sealLabel("refund", "pin", "00000000-0000-0000-0000-000000000001")]) {
    await assertRejects(() => openSealed(keys, sealed, other), SealError, "does not open");
  }
  // OAEP draws fresh randomness each time: two seals of one PIN differ.
  assertEquals(sealed === await seal(keys.current.public, "4321", label), false);
});

Deno.test("a rotation keeps the replaced key for what was sealed to it, and no other", async () => {
  const old = await generateSealKey();
  const before = await sealKeys(old);
  const sealed = await seal(before.current.public, "4321", label);
  const rotated = await sealKeys(await generateSealKey(), old);
  assertEquals(await openSealed(rotated, sealed, label), "4321");
  const stranger = await sealKeys(await generateSealKey());
  await assertRejects(() => openSealed(stranger, sealed, label), SealError, "does not hold");
});

Deno.test("what is not a sealed value, or was tampered with, never opens", async () => {
  const keys = await sealKeys(await generateSealKey());
  const sealed = await seal(keys.current.public, "4321", label);
  for (const bad of ["4321", sealed.slice(0, -1), sealed.slice(0, -2) + (sealed.endsWith("A") ? "BA" : "AA")]) {
    await assertRejects(() => openSealed(keys, bad, label), SealError);
  }
  await assertRejects(() => sealKeys("not a key"), Error);
});

Deno.test("the development key is refused outside the local stack however its PKCS#8 is spelled", async () => {
  const dev = (await Deno.readTextFile(new URL("./dev-seal.key", import.meta.url))).trim();
  const keys = await sealKeys(dev);
  assertEquals(keys.current.kid, DEV_SEAL_KID, "the development key's id");
  // The same RSA key with the algorithm identifier's optional NULL left out,
  // and the lengths around it shortened to match.
  const der = Uint8Array.from(atob(dev), (c) => c.charCodeAt(0));
  const alg = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const at = der.findIndex((_, i) => alg.every((b, j) => der[i + j] === b));
  const bare = new Uint8Array([...der.slice(0, at), 0x30, 0x0b, ...alg.slice(2, 13), ...der.slice(at + alg.length)]);
  assertEquals([bare[1], bare[2]], [0x82, der[2]]);
  const length = (der[2] << 8 | der[3]) - 2;
  bare[2] = length >> 8;
  bare[3] = length & 0xff;
  const respelled = btoa(String.fromCharCode(...bare));
  assertEquals((await sealKeys(respelled)).current.kid, DEV_SEAL_KID);
  for (const spelling of [dev, respelled, dev.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")]) {
    assertThrows(() => refuseDevKey(keys, false), SealError, "development key");
    await assertRejects(async () => refuseDevKey(await sealKeys(spelling), false), SealError, "development key");
    await assertRejects(async () => refuseDevKey(await sealKeys(await generateSealKey(), spelling), false), SealError, "AIRLOCK_SEAL_KEY_PREVIOUS");
    refuseDevKey(await sealKeys(spelling), true);
  }
  refuseDevKey(await sealKeys(await generateSealKey()), false);
});
