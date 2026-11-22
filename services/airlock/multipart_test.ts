// The multipart/form-data encoding: checked against the platform's own
// parser (Request.formData), byte for byte where the bytes are not text.

import { assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert";
import { boundary, canonicalBase64, mediaType, MULTIPART, multipartBody, parts } from "./multipart.ts";
import { base64Of, encodedBody, parseManifest, sinkMethod } from "./reentry.ts";
import { contentBlob, type BlobStore } from "./blobs.ts";

const noBlobs = (k: string): Promise<Uint8Array> => Promise.reject(new Error(`unexpected read of ${k}`));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

// Every byte value, none of them valid UTF-8 past 0x7f on its own.
const BINARY = Uint8Array.from({ length: 256 }, (_, i) => 255 - i);

async function parsed(bytes: Uint8Array<ArrayBuffer>, contentType: string): Promise<FormData> {
  return await new Request("http://sink/", { method: "POST", body: bytes, headers: { "content-type": contentType } }).formData();
}

Deno.test("text fields and a base64 file encode as RFC 7578, the boundary the airlock's", async () => {
  const { bytes, contentType } = await multipartBody([
    { name: "to", value: "ana@example.com" },
    { name: "file", filename: "invoice.pdf", type: "application/pdf", bytes: base64Of(BINARY) },
  ], noBlobs, "BOUNDARY");
  assertEquals(contentType, "multipart/form-data; boundary=BOUNDARY");
  const head = text(bytes.subarray(0, 200));
  assertEquals(
    head.startsWith('--BOUNDARY\r\nContent-Disposition: form-data; name="to"\r\n\r\nana@example.com\r\n--BOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="invoice.pdf"\r\nContent-Type: application/pdf\r\n\r\n'),
    true,
    head,
  );
  assertEquals(text(bytes.subarray(bytes.length - 16)), "\r\n--BOUNDARY--\r\n");
  const form = await parsed(bytes, contentType);
  assertEquals(form.get("to"), "ana@example.com");
  const file = form.get("file") as File;
  assertEquals([file.name, file.type], ["invoice.pdf", "application/pdf"]);
  assertEquals(new Uint8Array(await file.arrayBuffer()), BINARY);
});

Deno.test("a file names no type and goes as application/octet-stream, as FormData sends one", async () => {
  for (const type of [undefined, ""]) {
    const { bytes, contentType } = await multipartBody([{ name: "f", filename: "a.bin", bytes: "AAE=", ...(type === undefined ? {} : { type }) }], noBlobs);
    const file = (await parsed(bytes, contentType)).get("f") as File;
    assertEquals(file.type, "application/octet-stream");
    assertEquals(new Uint8Array(await file.arrayBuffer()), new Uint8Array([0, 1]));
  }
});

Deno.test("a blob part is read by its content key, and only a content key that hashes right", async () => {
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", BINARY))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `effects/${hash}.pdf`;
  const reads: string[] = [];
  const store: BlobStore = { put: () => Promise.reject(new Error("put")), get: (k) => (reads.push(k), Promise.resolve(BINARY)), url: (k) => k };
  const read = (k: string) => contentBlob(store, k);
  const { bytes, contentType } = await multipartBody([{ name: "file", filename: "r.pdf", type: "application/pdf", blob: key }], read);
  assertEquals(reads, [key]);
  assertEquals(new Uint8Array(await ((await parsed(bytes, contentType)).get("file") as File).arrayBuffer()), BINARY);
  await assertRejects(() => multipartBody([{ name: "f", filename: "x", blob: "invoice.pdf" }], read), TypeError, "only a content key");
  await assertRejects(() => multipartBody([{ name: "f", filename: "x", blob: `${"0".repeat(64)}.pdf` }], read), Error, "hash to");
});

Deno.test("names and filenames escape quote, CR and LF as the WHATWG encoding does", async () => {
  const { bytes } = await multipartBody([
    { name: 'a"b\nc', value: "line\none\rtwo" },
    { name: "f", filename: 'x"\r\ny.txt', bytes: "" },
  ], noBlobs, "B");
  const body = text(bytes);
  assertEquals(body.includes('name="a%22b%0D%0Ac"\r\n\r\nline\r\none\r\ntwo\r\n'), true, body);
  assertEquals(body.includes('filename="x%22%0D%0Ay.txt"\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--B--'), true, body);
});

Deno.test("each call picks its own boundary", async () => {
  assertNotEquals(boundary(), boundary());
  const a = await multipartBody([{ name: "a", value: "1" }], noBlobs);
  const b = await multipartBody([{ name: "a", value: "1" }], noBlobs);
  assertNotEquals(a.contentType, b.contentType);
  assertEquals(/^multipart\/form-data; boundary=[0-9a-z-]{41}$/.test(a.contentType), true, a.contentType);
});

Deno.test("a part the airlock cannot encode is a TypeError naming it", () => {
  const refused: [unknown, string][] = [
    [{ file: "x" }, "a list of parts"],
    [["x"], "an object"],
    [[{ name: "a" }], "exactly one of value, bytes or blob, got none"],
    [[{ name: "a", value: "1", bytes: "AA==" }], "exactly one of value, bytes or blob, got value, bytes"],
    [[{ name: "a", value: 1 }], "value is a string"],
    [[{ name: "a", value: "1", filename: "x" }], "a text field is {name, value}"],
    [[{ value: "1" }], "name is a string"],
    [[{ name: "f", bytes: "AA==" }], "names its filename"],
    [[{ name: "f", filename: "x", bytes: "AA=" }], "canonical base64"],
    [[{ name: "f", filename: "x", bytes: "AA-_" }], "canonical base64"],
    [[{ name: "f", filename: "x", bytes: "AAAA\nAAAA" }], "canonical base64"],
    [[{ name: "f", filename: "x", bytes: [0, 1] }], "canonical base64"],
    [[{ name: "f", filename: "x", type: "text/plain\r\nX-Evil: 1", bytes: "" }], "type is a media type"],
    [[{ name: "f", filename: "x", blob: 1 }], "blob is a content key"],
    [[{ name: "f", filename: "x", bytes: "", headers: {} }], "a file is {name, filename, type?, bytes}"],
  ];
  for (const [body, message] of refused) assertThrows(() => parts(body), TypeError, message);
  assertEquals(parts([{ name: "f", filename: "x", type: "text/plain; charset=utf-8", bytes: "" }]).length, 1);
});

Deno.test("a manifest declares multipart/form-data bare, and no other of its family", () => {
  const manifest = (contentType: string) =>
    JSON.stringify({ effects: { mail: { table: "t", field: "s", state: "a", onDone: "b", onError: "c", row: ["id"], key: ["id"], idempotent: true, attempts: 1, handler: "h.js", contentType } } });
  assertEquals(parseManifest(manifest(MULTIPART)).mail.contentType, MULTIPART);
  for (const bad of ["multipart/form-data; boundary=x", "multipart/mixed", "multipart/related"]) assertThrows(() => parseManifest(manifest(bad)), Error, "contentType");
});

Deno.test("the transport sends the encoded bytes as they are, and nothing else under a boundary", () => {
  assertEquals(encodedBody("multipart/form-data; boundary=B", BINARY), BINARY);
  assertThrows(() => encodedBody("multipart/form-data; boundary=B", [{ name: "a", value: "1" }]), TypeError, "the airlock's encoding");
  assertThrows(() => encodedBody("application/pdf", BINARY), TypeError, "encoded string");
});

Deno.test("a file's type is an RFC 9110 media type of visible ASCII: no CTL reaches the part's header", () => {
  const file = (type: string) => parts([{ name: "f", filename: "x", type, bytes: "" }]);
  for (const ok of ["application/pdf", "text/plain; charset=utf-8", 'text/plain; a="b\\"c"', "a/b ;\tc=d", "application/vnd.ms-excel"]) file(ok);
  for (const bad of ["text/plain\r\nX-Evil: 1", "text/plain;\nx=y", "text/plain;\rx=y", 'text/plain; a="\u0001"', 'text/plain; a="\n"', "text/plain\u0000", "text/pláin", "text", "text/plain; =x", "text/plain; a=b c"]) {
    assertThrows(() => file(bad), TypeError, "type is a media type", JSON.stringify(bad));
  }
});

Deno.test("base64 is canonical: padding in place and the unused bits zero, at any size", () => {
  assertEquals(canonicalBase64("AA=="), new Uint8Array([0]));
  assertEquals(canonicalBase64("AAE="), new Uint8Array([0, 1]));
  assertEquals(canonicalBase64(base64Of(Uint8Array.from({ length: 256 }, (_, i) => i))), Uint8Array.from({ length: 256 }, (_, i) => i));
  // AB== and AAB= decode as AA== and AAA= do, so neither is the canonical spelling.
  for (const bad of ["AB==", "AAB=", "A===", "=AAA", "AA=A", "AAA", "AAAA=", "AAAA====", "AA\u00e9="]) assertEquals(canonicalBase64(bad), null, bad);
  // 12 MiB, past where a regular expression's backtracking overflowed.
  const big = new Uint8Array(12 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4093) big[i] = i & 0xff;
  const text = base64Of(big);
  assertEquals(text.length, 16_777_216);
  const [part] = parts([{ name: "f", filename: "big.bin", bytes: text }]);
  assertEquals((part as { bytes: Uint8Array }).bytes, big);
});

Deno.test("the parts are the airlock's frozen copies: a handler that changes one while a blob is read changes nothing sent", async () => {
  const later: Record<string, unknown> = { name: "f", filename: "x.txt", type: "text/plain", bytes: "AQI=" };
  let typeReads = 0;
  const sly = { name: "g", filename: "y.txt", get type() { return typeReads++ === 0 ? "text/plain" : "text/plain\r\nX-Evil: 1"; }, bytes: "" };
  const body = [{ name: "first", filename: "a.pdf", blob: "k" }, later, sly];
  const read = () => {
    later.type = "text/plain\r\nX-Evil: 1";
    later.bytes = "AAAA";
    body.push({ name: "extra", value: "1" } as never);
    return Promise.resolve(new Uint8Array([9]));
  };
  const { bytes, contentType } = await multipartBody(body, read);
  const sent = text(bytes);
  assertEquals(sent.includes("X-Evil"), false, sent);
  const form = await parsed(bytes, contentType);
  assertEquals([...form.keys()], ["first", "f", "g"]);
  assertEquals(new Uint8Array(await (form.get("f") as File).arrayBuffer()), new Uint8Array([1, 2]));
  const checked = parts([{ name: "a", value: "1" }]);
  assertEquals([Object.isFrozen(checked), Object.isFrozen(checked[0])], [true, true]);
});

Deno.test("one method rule for both airlocks: a body only with POST, PUT or PATCH", () => {
  for (const m of ["POST", "PUT", "PATCH"]) assertEquals(sinkMethod(m, [{ name: "a", value: "1" }]), m);
  for (const m of ["GET", "DELETE"]) {
    assertEquals(sinkMethod(m, undefined), m);
    assertThrows(() => sinkMethod(m, "x"), TypeError, "takes no body");
  }
  for (const m of ["HEAD", "OPTIONS", "get", 1]) assertThrows(() => sinkMethod(m, undefined), TypeError, "sink method");
});

Deno.test("a media type is read in one pass: a pathological one is refused at once", () => {
  for (const ok of ["a/b", "a/b;", "a/b ; ;\tc=d", 'a/b; c="x\\"y z"', "a/b;c=d;e=f"]) assertEquals(mediaType(ok), true, ok);
  for (const bad of ["a/b ", "a/b; c", "a/b; c=", "a/b; c=\"x", "/b", "a/", "a/b; c=d e", 'a/b; c="\\\u0001"']) assertEquals(mediaType(bad), false, bad);
  // "  ;  " fifteen times took the regular expression this replaced past a minute.
  const shapes = [`text/plain${"  ;  ".repeat(20_000)}\u0001`, `text/plain${" ;".repeat(50_000)}\u0001`, `text/plain${"; ".repeat(50_000)}=`, `text/plain;${" ".repeat(100_000)}x`, `text/plain${"; a=b".repeat(20_000)}; a="${"\\ ".repeat(20_000)}`];
  for (const bad of shapes) {
    const started = performance.now();
    assertThrows(() => parts([{ name: "f", filename: "x", type: bad, bytes: "" }]), TypeError, "type is a media type");
    const ms = performance.now() - started;
    assertEquals(ms < 50, true, `${bad.length} characters took ${ms}ms`);
  }
});

Deno.test("only a part's own enumerable fields count, as a structured clone carries them into the cage", async () => {
  const inherited = Object.assign(Object.create({ type: "application/pdf", filename: "x.pdf" }), { name: "f", filename: "a.bin", bytes: "AQI=" });
  const hidden = { name: "g", filename: "b.bin", bytes: "" };
  Object.defineProperty(hidden, "type", { value: "application/pdf", enumerable: false });
  const { bytes, contentType } = await multipartBody([inherited, hidden], noBlobs);
  const form = await parsed(bytes, contentType);
  assertEquals([(form.get("f") as File).type, (form.get("f") as File).name, (form.get("g") as File).type], ["application/octet-stream", "a.bin", "application/octet-stream"]);
  // What the container's cage receives is the clone, and it encodes the same.
  const cloned = await multipartBody(structuredClone([inherited, hidden]), noBlobs, contentType.split("boundary=")[1]);
  assertEquals(cloned.bytes, bytes);
  // An inherited filename is no filename.
  assertThrows(() => parts([Object.assign(Object.create({ filename: "x" }), { name: "f", bytes: "" })]), TypeError, "names its filename");
});
