import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { type BlobStore, contentBlob, stowed } from "./blobs.ts";

const plane = () => {
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  const store: BlobStore = {
    put: (key, bytes, type) => Promise.resolve(void objects.set(key, { bytes, type })),
    get: (key) => Promise.resolve(objects.get(key)?.bytes ?? Promise.reject(new Error(`no ${key}`))),
    url: (key) => `/img/insecure/plain/s3://bucket/${key}`,
  };
  return { objects, store };
};

// A level's pictures settled inline as data URLs, and the edge's database, held
// in its object's memory, outgrew the object: an answer's bytes go to the plane.
Deno.test("an answer's blob is stored in the plane and settles as the URL it is served at", async () => {
  const { objects, store } = plane();
  const answer = await stowed({ done: { image: { $blob: { base64: btoa("png bytes"), type: "image/png" } }, word: "Caju" } }, "illustrate-card:k1", store);
  const url = (answer as { done: { image: string } }).done.image;
  assertMatch(url, /^\/img\/insecure\/plain\/s3:\/\/bucket\/effects\/[0-9a-f]{64}\.png$/);
  assertEquals((answer as { done: { word: string } }).done.word, "Caju");
  const object = objects.get(url.slice("/img/insecure/plain/s3://bucket/".length))!;
  assertEquals([new TextDecoder().decode(object.bytes), object.type], ["png bytes", "image/png"]);
});

Deno.test("a run that retries writes the same object, and other bytes another", async () => {
  const { objects, store } = plane();
  const blob = (text: string) => ({ done: { image: { $blob: { base64: btoa(text), type: "image/jpeg" } } } });
  const first = await stowed(blob("x"), "illustrate-card:k1", store);
  assertEquals(await stowed(blob("x"), "illustrate-card:k1", store), first);
  await stowed(blob("y"), "illustrate-card:k1", store);
  assertEquals(objects.size, 2);
});

// The print file was stored under its ledger key, which no handler could read:
// the mails that attach it rebuilt it from the artwork.
Deno.test("an answer's blob is read by a later effect whose input carries its key", async () => {
  const { store } = plane();
  const pdf = new TextEncoder().encode("%PDF-1.7");
  const answer = await stowed({ done: { file: { $blob: { bytes: pdf, type: "application/pdf" } } } }, "print-session:k1", store);
  const key = (answer as { done: { file: string } }).done.file.slice("/blobs/mecha-objects/".length);
  assertEquals(await contentBlob(store, key), pdf);
});

// A print file is made in the cage, which has no btoa, and is no image.
Deno.test("a handler's own bytes are stored as they are, a PDF among them", async () => {
  const { objects, store } = plane();
  const pdf = new TextEncoder().encode("%PDF-1.7");
  const answer = await stowed({ done: { file: { $blob: { bytes: pdf, type: "application/pdf" } } } }, "print-session:k1", store);
  const url = (answer as { done: { file: string } }).done.file;
  // Regression: a PDF's URL was the image route's, which tried to transform it.
  assertMatch(url, /^\/blobs\/mecha-objects\/effects\/[0-9a-f]{64}\.pdf$/);
  assertEquals(objects.get(url.slice("/blobs/mecha-objects/".length)), { bytes: pdf, type: "application/pdf" });
  await assertRejects(() => stowed({ done: { file: { $blob: { bytes: new Uint8Array(), type: "application/pdf" } } } }, "k", store), Error, "carries no bytes");
});

Deno.test("a blob with no plane to hold it, or of a type the plane does not serve, is refused", async () => {
  await assertRejects(() => stowed({ done: { image: { $blob: { base64: btoa("x"), type: "image/png" } } } }, "k", undefined), Error, "no blob plane");
  await assertRejects(() => stowed({ done: { image: { $blob: { base64: btoa("x"), type: "text/html" } } } }, "k", plane().store), Error, "does not serve");
  assertEquals(await stowed({ done: { n: 1 } }, "k", undefined), { done: { n: 1 } });
});

const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");

Deno.test("a handler reads a blob by the hash of its bytes, and nothing else", async () => {
  const { objects, store } = plane();
  const bytes = new TextEncoder().encode("card artwork");
  const key = `${await sha256(bytes)}.jpg`;
  objects.set(key, { bytes, type: "image/jpeg" });
  assertEquals(await contentBlob(store, key), bytes);
  const suffixed = key.replace(".jpg", "-0f2a.jpg");
  objects.set(suffixed, { bytes, type: "image/jpeg" });
  assertEquals(await contentBlob(store, suffixed), bytes);
  await assertRejects(() => contentBlob(store, "3f1c.jpg"), TypeError, "only a content key");
  await assertRejects(() => contentBlob(store, `seed/${key}`), TypeError, "only a content key");
  await assertRejects(() => contentBlob(undefined, key), Error, "no blob plane");
});

// Regression: on Compose the claimant can still write its key again, so a
// repeated run could read other bytes than the first one did.
Deno.test("bytes that no longer hash to their key stop the run", async () => {
  const { objects, store } = plane();
  const key = `${await sha256(new TextEncoder().encode("first"))}.jpg`;
  objects.set(key, { bytes: new TextEncoder().encode("replaced"), type: "image/jpeg" });
  await assertRejects(() => contentBlob(store, key), Error, "its bytes hash to");
});
