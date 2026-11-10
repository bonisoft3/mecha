/// <reference lib="deno.worker" />
import "./realm.ts";
import { compartment } from "./compartment.ts";

const LIMIT = 8 * 1024 * 1024;
const REPLY_LIMIT = 16 * 1024 * 1024;
function encode(value: unknown): string {
  const json = JSON.stringify(value, function (key, value) {
    const held = this[key];
    if (
      held === undefined ||
      ["function", "symbol", "bigint"].includes(typeof held) ||
      (typeof held === "number" && !Number.isFinite(held))
    ) throw new TypeError("step messages must be JSON data");
    return value;
  });
  if (new TextEncoder().encode(json).byteLength > LIMIT) {
    throw new RangeError("step message exceeds 8 MiB");
  }
  return json;
}
function decode(json: string, limit = LIMIT): unknown {
  if (
    typeof json !== "string" ||
    new TextEncoder().encode(json).byteLength > limit
  ) {
    throw new RangeError("invalid or oversized step message");
  }
  return harden(JSON.parse(json));
}
let loaded: { file: string; source: object; endowments: string[] } | undefined;
let running = false;
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
const call = (method: string, args: unknown[]) =>
  new Promise((resolve, reject) => {
    const json = encode({ method, args });
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    postMessage({ kind: "call", id, json });
  });

addEventListener("message", async (event) => {
  const { data } = event as MessageEvent;
  try {
    if (data.kind === "reply") {
      const request = pending.get(data.id);
      if (!request) throw new Error("unknown step host reply");
      pending.delete(data.id);
      if (typeof data.error === "string") request.reject(new Error(data.error));
      else request.resolve(decode(data.json, REPLY_LIMIT));
      return;
    }
    if (data.kind === "load") {
      if (loaded) throw new Error("step worker already loaded");
      loaded = data;
      return;
    }
    if (data.kind !== "advance" || !loaded || running) {
      throw new Error("invalid step worker request");
    }
    running = true;
    const { seed, checkpoint } = decode(data.json) as {
      seed: number;
      checkpoint: unknown;
    };
    const host = harden({
      seed,
      query: (sql: string) => call("query", [sql]),
      wasm: (name: string, input: unknown) => call("wasm", [name, input]),
      wasmFromQuery: (
        name: string,
        input: unknown,
        query: { path: string[]; sql: string; orderBy: string },
      ) => call("wasmFromQuery", [name, input, query]),
    });
    const { namespace } = await compartment(
      loaded.file,
      loaded.source,
      loaded.endowments,
      "a computation",
    ).import(loaded.file);
    if (
      Object.keys(namespace).sort().join() !== "finish,plan,queries,reads" ||
      typeof namespace.plan !== "function" ||
      typeof namespace.finish !== "function"
    ) {
      throw new TypeError(`${loaded.file}: invalid computation exports`);
    }
    const result = await namespace.plan(host, seed, checkpoint);
    if (pending.size) throw new Error("step returned with pending host calls");
    const json = encode(result);
    running = false;
    postMessage({ kind: "result", json });
  } catch (error) {
    postMessage({
      kind: "error",
      error: error instanceof Error
        ? error.stack ?? error.message
        : String(error),
    });
    close();
  }
});
