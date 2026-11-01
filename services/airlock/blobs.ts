// An answer's bytes, kept out of the database. A handler states a blob as
// {"$blob": {base64, type}} anywhere in its answer; the host stores each in the
// cluster's blob plane before the outcome settles, and the outcome carries the
// URL the plane serves it at. A level's pictures once settled inline as data
// URLs: the ledger and the row each held every one, and the edge's database,
// which lives in its object's memory, outgrew the object.
import { type Answer, CALL_TIMEOUT_MS } from "./reentry.ts";

/** Where a cluster keeps an effect's bytes: the plane's put, and the URL a key is served at. */
export type BlobStore = {
  put(key: string, bytes: Uint8Array, type: string): Promise<void>;
  url(key: string): string;
};

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

type Blob = { $blob: { base64: string; type: string } };
const isBlob = (v: unknown): v is Blob =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && "$blob" in v;

async function digest(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The answer with each blob stored and named by its URL. The object's key is
 * the ledger key's and the blob's place in the answer: a run that retries
 * writes the same object again rather than leaving one per attempt.
 */
export async function stowed(answer: Answer, ledgerKey: string, store: BlobStore | undefined): Promise<Answer> {
  const walk = async (v: unknown, at: string): Promise<unknown> => {
    if (isBlob(v)) {
      const { base64, type } = v.$blob;
      const extension = Object.hasOwn(EXTENSION, type) ? EXTENSION[type] : die(`${ledgerKey}: a blob at ${at} is ${JSON.stringify(type)}, which the plane does not serve`);
      if (typeof base64 !== "string" || base64 === "") die(`${ledgerKey}: a blob at ${at} carries no bytes`);
      const plane = store ?? die(`${ledgerKey}: the answer carries a blob at ${at}, and this cluster has no blob plane`);
      const key = `effects/${await digest(`${ledgerKey}\n${at}`)}.${extension}`;
      // Each put bounded alone: a store that never answers held its job, and every
      // effect behind it, forever.
      await bounded(plane.put(key, Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)), type), `${ledgerKey}: storing the blob at ${at}`);
      return plane.url(key);
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

// In slices: spreading a picture's bytes into one call overflows the stack.
function base64Of(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
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
    url: (key) => `${url}${key}`,
  };
}
