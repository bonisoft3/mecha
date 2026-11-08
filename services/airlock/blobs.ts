// An answer's bytes, kept out of the database. A handler states a blob as
// {"$blob": {base64, type}} or {"$blob": {bytes, type}} anywhere in its answer; the host stores each in the
// cluster's blob plane before the outcome settles, and the outcome carries the
// URL the plane serves it at. A level's pictures once settled inline as data
// URLs: the ledger and the row each held every one, and the edge's database,
// which lives in its object's memory, outgrew the object.
import { type Answer, base64Of, CALL_TIMEOUT_MS } from "./reentry.ts";

/** Where a cluster keeps an effect's bytes: the plane's put and get, and the URL a key is served at. */
export type BlobStore = {
  put(key: string, bytes: Uint8Array, type: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  url(key: string): string;
};

// A key named by its bytes (docs/decisions/2026-11-05-content-addressed-blobs.md):
// the SHA-256 of what it holds, in hex, then optionally a writer's own suffix, so
// two claimants of the same bytes each hold a key, and an extension. Under
// effects/, which no claim can name, it is an answer the host stored.
const CONTENT_KEY = /^(?:effects\/)?([0-9a-f]{64})(?:-[0-9a-z]{1,40})?\.[a-z0-9]{1,12}$/;

/** The bytes a handler asked for by a content key: refused unless the key is
 * one, and unless the bytes hash to it, so a run that is repeated reads what
 * the first one read or stops. */
export async function contentBlob(store: BlobStore | undefined, key: unknown): Promise<Uint8Array> {
  const named = typeof key === "string" ? CONTENT_KEY.exec(key) : null;
  if (named === null) throw new TypeError(`blob ${JSON.stringify(key)}: a handler reads only a content key, <sha256 hex>[-<suffix>].<extension>`);
  const plane = store ?? die(`blob ${key}: this cluster has no blob plane`);
  const bytes = await bounded(plane.get(key as string), `reading the blob ${key}`);
  const hash = await hex(bytes);
  if (hash !== named[1]) throw new Error(`blob ${key}: its bytes hash to ${hash}`);
  return bytes;
}

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
};
// The door's raw route on every tier; the image route would try to transform a PDF.
const RAW_ROUTE = "/blobs/mecha-objects/";

// A handler that made its bytes in the cage, which has no btoa, hands them as they are.
type Blob = { $blob: { base64: string; type: string } | { bytes: Uint8Array; type: string } };
const isBlob = (v: unknown): v is Blob =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && "$blob" in v;

const hex = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The answer with each blob stored and named by its URL. The object's key is
 * its content key, so a later effect whose input carries it reads it with
 * sink.blob. A run that retries with the same bytes writes the same object; a
 * handler whose bytes differ by attempt leaves one per attempt, read by none.
 */
export async function stowed(answer: Answer, ledgerKey: string, store: BlobStore | undefined): Promise<Answer> {
  const walk = async (v: unknown, at: string): Promise<unknown> => {
    if (isBlob(v)) {
      const { type } = v.$blob;
      const extension = Object.hasOwn(EXTENSION, type) ? EXTENSION[type] : die(`${ledgerKey}: a blob at ${at} is ${JSON.stringify(type)}, which the plane does not serve`);
      const bytes = "bytes" in v.$blob
        ? v.$blob.bytes instanceof Uint8Array ? v.$blob.bytes : die(`${ledgerKey}: a blob at ${at} names bytes that are no Uint8Array`)
        : typeof v.$blob.base64 === "string" ? Uint8Array.from(atob(v.$blob.base64), (c) => c.charCodeAt(0)) : die(`${ledgerKey}: a blob at ${at} carries no bytes`);
      if (bytes.length === 0) die(`${ledgerKey}: a blob at ${at} carries no bytes`);
      const plane = store ?? die(`${ledgerKey}: the answer carries a blob at ${at}, and this cluster has no blob plane`);
      const key = `effects/${await hex(bytes)}.${extension}`;
      // Each put bounded alone: a store that never answers held its job, and every
      // effect behind it, forever.
      await bounded(plane.put(key, bytes, type), `${ledgerKey}: storing the blob at ${at}`);
      return type.startsWith("image/") ? plane.url(key) : `${RAW_ROUTE}${key}`;
    }
    if (Array.isArray(v)) return Promise.all(v.map((x, i) => walk(x, `${at}[${i}]`)));
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = await walk(x, `${at}.${k}`);
      return out;
    }
    return v;
  };
  return await walk(answer, "") as Answer;
}

function bounded<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

function die(message: string): never {
  throw new Error(message);
}

/**
 * The container tier's plane: rclone-s3 through the airlock's daprd, as dapr's
 * S3 output binding named `blobs` (the airlock reaches nothing else), with
 * imgproxy serving each key under `url`.
 */
export function daprBlobs(mesh: string, url: string): BlobStore {
  return {
    async put(key, bytes) {
      const res = await fetch(`${mesh}/v1.0/bindings/blobs`, {
        method: "POST",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "create", data: base64Of(bytes), metadata: { key } }),
      });
      const text = await res.text();
      if (res.status !== 200 && res.status !== 204) throw new Error(`binding blobs: daprd answered ${res.status} ${text}`);
    },
    async get(key) {
      const res = await fetch(`${mesh}/v1.0/bindings/blobs`, {
        method: "POST",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "get", metadata: { key } }),
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (res.status !== 200) throw new Error(`binding blobs: daprd answered ${res.status} ${new TextDecoder().decode(bytes)}`);
      return bytes;
    },
    url: (key) => `${url}${key}`,
  };
}
