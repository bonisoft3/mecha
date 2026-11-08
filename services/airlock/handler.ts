// The host side of an effect's handler: its admission, one fresh cage
// (cage.ts) per call, and the only network the handler has: its sink's fetch,
// which the host performs as an invocation of the effect's HTTPEndpoint on the
// airlock's daprd.
//
// The handler names a path, never a URL, and the host names only its own
// effect's endpoint. The daprd admits those endpoints and nothing else (the
// cluster's wall), and each endpoint's target is the program's declaration, so
// nothing here can reach an origin the program did not declare.

import { compile } from "../compute/workers.ts";
import { endowable } from "../compute/language.ts";
import { type Answer, CALL_TIMEOUT_MS, type Effect, encodedBody, parseManifest, sinkHeaders } from "./reentry.ts";
import { type BlobStore, contentBlob } from "./blobs.ts";

const NONE = { type: "module", deno: { permissions: "none" } } as const;

/** What a handler's sink.fetch returns: the status, and the body parsed when
 * the sink answers JSON, its text otherwise. */
export type Response = { status: number; body: unknown };

/** One request to an effect's sink. */
export type Transport = (
  endpoint: string,
  path: string,
  init: { method: string; body?: unknown; headers?: Record<string, string>; contentType?: string },
  key: string,
  headers: Record<string, string>,
) => Promise<Response>;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
// A path's characters, then optionally a query; no `%` in the path, no empty
// segment and no dot segment, so what daprd appends to the endpoint's declared
// base URL stays beneath it.
const PATH = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@/]*(\?[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]*)?$/;
const DOT_SEGMENT = /(^|\/)\.\.?(\/|\?|$)/;

/** `path` checked as one the sink may be asked: absolute, in the safe
 * characters, with no dot segment. */
export function sinkPath(path: unknown): string {
  const segments = typeof path === "string" ? path.split("?")[0] : "";
  if (typeof path !== "string" || !PATH.test(path) || DOT_SEGMENT.test(segments) || segments.includes("//")) {
    throw new TypeError(`sink path ${JSON.stringify(path)}: an absolute path in plain characters, with no empty or dot segment`);
  }
  return path;
}

/** The cluster a handler runs in, as the host hands it over. */
export type Place = { blobs?: BlobStore; origin?: string };

/** The sink's breaker is open: daprd called nothing, so this is no run. */
export class BreakerOpen extends Error {}

/**
 * The real transport: the effect's HTTPEndpoint on the airlock's daprd, which
 * hands the body, the headers and the sink's status through as they are. Only
 * the host sets the idempotency key and the content type.
 *
 * daprd's own failure is also a 500, told from a sink's by its error code, and
 * says whether the sink was called: an open breaker did not; anything else may
 * have reached it.
 */
export function meshTransport(mesh: string): Transport {
  return async (endpoint, path, init, key, headers) => {
    const res = await fetch(`${mesh}/v1.0/invoke/${endpoint}/method${sinkPath(path)}`, {
      method: init.method,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        ...init.headers,
        ...headers,
        "Idempotency-Key": key,
        ...(init.body === undefined ? {} : { "Content-Type": init.contentType ?? "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: encodedBody(init.contentType, init.body) }),
    });
    const text = await res.text();
    const json = (res.headers.get("content-type") ?? "").includes("json");
    const body = json && text !== "" ? JSON.parse(text) : text;
    // The daprd's own error, whatever its status: a wall or an API rule that
    // refused the call is the mesh's to fix, not a provider's refusal.
    if (typeof body?.errorCode === "string" && body.errorCode.startsWith("ERR_")) {
      if (/err: (circuit breaker is open|too many requests)$/.test(body.message ?? "")) throw new BreakerOpen(`effect ${endpoint}: ${body.message}`);
      throw new Error(`effect ${endpoint}: daprd answered ${text}`);
    }
    return { status: res.status, body };
  };
}

/** The longest one call of a handler may take, its sink calls included, before
 * it counts as no answer. */
const HANDLER_TIMEOUT_MS = 90_000;

/** An effect's handler, admitted: compiled once, run in a fresh cage per call. */
export class Handler {
  private constructor(
    readonly name: string,
    private file: string,
    private compiled: object,
    private timeoutMs: number,
    private endowments: string[],
    private contentType?: string,
  ) {}

  /** The handler at `file`, refused unless it exports `issue`, and `reconcile`
   * where its effect reconciles, and nothing else. */
  static async admit(name: string, file: string, effect: Effect, timeoutMs = HANDLER_TIMEOUT_MS): Promise<Handler> {
    const endowments = endowable(effect.endowments ?? [], `effect ${name}`);
    const compiled = compile(file, await Deno.readTextFile(file));
    const worker = new Worker(new URL("./cage.ts", import.meta.url), NONE);
    let exports: string[];
    try {
      exports = (await exchange(worker, { source: compiled, file, endowments }, () => {})).exports as string[];
    } finally {
      worker.terminate();
    }
    const reconciles = !effect.idempotent && effect.reentry === "reconcile";
    const wanted = reconciles ? ["issue", "reconcile"] : ["issue"];
    if (exports.join() !== wanted.join()) {
      throw new Error(`effect ${name}: ${file} must export exactly ${wanted.join(", ")}; it exports ${exports.join(", ") || "nothing"}`);
    }
    return new Handler(name, file, compiled, timeoutMs, endowments, effect.contentType);
  }

  /** One run of issue or reconcile against the sink, its answer checked, the
   * handler handed the values of the effect's secrets; `place` is the cluster
   * it runs in: the blob plane its content keys are read from, and the origin
   * its door answers at. */
  async call(fn: "issue" | "reconcile", input: unknown, key: string, transport: Transport, secrets: Record<string, string> = {}, headers: Record<string, string> = {}, place: Place = {}): Promise<Answer> {
    const worker = new Worker(new URL("./cage.ts", import.meta.url), NONE);
    // Ends the call rather than reach the handler, which could catch it: only
    // a call that asked nothing of the sink may be given back to the ledger.
    // Counted when it starts, not when it settles: one in flight beside the
    // breaker may already have reached the sink.
    let started = 0;
    let refuse: (e: BreakerOpen) => void;
    const refused = new Promise<never>((_, reject) => (refuse = reject));
    const serve = async (data: Record<string, unknown>) => {
      const id = data.id;
      if ("blob" in data) {
        // A read of the plane, not of the sink: it calls nothing.
        try {
          worker.postMessage({ id, answer: await contentBlob(place.blobs, data.blob) });
        } catch (e) {
          worker.postMessage({ id, failure: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      try {
        const { path, method, body, headers: asked } = data.fetch as { path: unknown; method: unknown; body: unknown; headers: unknown };
        if (typeof method !== "string" || !METHODS.has(method)) throw new TypeError(`sink method ${JSON.stringify(method)}`);
        const own = sinkHeaders(asked, Object.keys(headers));
        started++;
        const answer = await transport(this.name, sinkPath(path), { method, body, headers: own, ...(this.contentType ? { contentType: this.contentType } : {}) }, key, headers);
        worker.postMessage({ id, answer });
      } catch (e) {
        if (e instanceof BreakerOpen && started === 1) return refuse(e);
        worker.postMessage({ id, failure: e instanceof Error ? e.message : String(e) });
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`effect ${this.name}: ${fn} gave no answer in ${this.timeoutMs}ms`)), this.timeoutMs);
    });
    const run = async () => {
      await exchange(worker, { source: this.compiled, file: this.file, endowments: this.endowments }, serve);
      return (await exchange(worker, { call: fn, input, key, secrets, origin: place.origin }, serve)).result;
    };
    try {
      return checked(this.name, fn, await Promise.race([run(), timeout, refused]));
    } finally {
      clearTimeout(timer);
      worker.terminate();
    }
  }
}

/** issue answers {done} or {failed}; reconcile may also answer {absent: true}. */
function checked(name: string, fn: "issue" | "reconcile", answer: unknown): Answer {
  const keys = typeof answer === "object" && answer !== null && !Array.isArray(answer) ? Object.keys(answer) : [];
  const ok = keys.length === 1 &&
    (keys[0] === "done" || keys[0] === "failed" ||
      (fn === "reconcile" && keys[0] === "absent" && (answer as { absent: unknown }).absent === true));
  if (!ok) {
    throw new Error(`effect ${name}: ${fn} answered ${JSON.stringify(answer)}, not {done} or {failed}${fn === "reconcile" ? " or {absent: true}" : ""}`);
  }
  return answer as Answer;
}

/** One request to the cage, answered once; the cage's fetches are served on the
 * way. */
function exchange(
  worker: Worker,
  message: unknown,
  onHostCall: (data: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const data = e.data as Record<string, unknown>;
      if ("fetch" in data || "blob" in data) return onHostCall(data);
      if ("error" in data) return reject(new Error(String(data.error)));
      resolve(data);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      reject(new Error(e.message));
    };
    worker.postMessage(message);
  });
}

/** Every effect of the manifest at `manifest`, its handler read under `dir`
 * and admitted: the airlock's startup and pronto's lint both go through here. */
export async function admitAll(manifest: string, dir: string): Promise<{ effects: Record<string, Effect>; handlers: Record<string, Handler> }> {
  const effects = parseManifest(await Deno.readTextFile(manifest));
  const handlers = Object.fromEntries(
    await Promise.all(Object.entries(effects).map(async ([name, e]) => [name, await Handler.admit(name, `${dir}/${e.handler}`, e)] as const)),
  );
  return { effects, handlers };
}
