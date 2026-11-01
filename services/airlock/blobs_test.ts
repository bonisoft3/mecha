import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { type BlobStore, stowed } from "./blobs.ts";

const plane = () => {
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  const store: BlobStore = {
    put: (key, bytes, type) => Promise.resolve(void objects.set(key, { bytes, type })),
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

Deno.test("a run that retries writes the same object, and another key another", async () => {
  const { objects, store } = plane();
  const blob = { done: { image: { $blob: { base64: btoa("x"), type: "image/jpeg" } } } };
  const first = await stowed(blob, "illustrate-card:k1", store);
  assertEquals(await stowed(blob, "illustrate-card:k1", store), first);
  await stowed(blob, "illustrate-card:k2", store);
  assertEquals(objects.size, 2);
});

Deno.test("a blob with no plane to hold it, or of a type the plane does not serve, is refused", async () => {
  await assertRejects(() => stowed({ done: { image: { $blob: { base64: btoa("x"), type: "image/png" } } } }, "k", undefined), Error, "no blob plane");
  await assertRejects(() => stowed({ done: { image: { $blob: { base64: btoa("x"), type: "text/html" } } } }, "k", plane().store), Error, "does not serve");
  assertEquals(await stowed({ done: { n: 1 } }, "k", undefined), { done: { n: 1 } });
});
