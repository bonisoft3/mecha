// The host side of an effect's handler: its admission, one fresh cage
// (cage.ts) per call, and the only network the handler has: its sink's fetch,
// which the host performs as a call of the effect's output binding on the
// airlock's daprd.
//
// The handler names a path, never a URL, and the host names only its own
// effect's binding. The daprd allows the bindings API and nothing else (the
// cluster's allowlist), and each binding's target is the program's
// declaration, so nothing here can reach an origin the program did not
// declare.

import { compile } from "../compute/workers.ts";
import { endowable } from "../compute/language.ts";
import { type Answer, type Effect, parseManifest } from "./reentry.ts";

const NONE = { type: "module", deno: { permissions: "none" } } as const;

/** What a handler's sink.fetch returns: the status, and the body parsed when
 * the sink answers JSON, its text otherwise. */
export type Response = { status: number; body: unknown };

/** One request to an effect's sink. */
export type Transport = (
  endpoint: string,
  path: string,
  init: { method: string; body?: unknown },
  key: string,
  headers: Record<string, string>,
) => Promise<Response>;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
// A path's characters, then optionally a query; no `%` in the path, no empty
// segment and no dot segment, so what the binding appends to its declared base
// URL stays beneath it.
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

/** Nothing one sink call is worth waiting on longer than this. */
const CALL_TIMEOUT_MS = 45_000;

/**
 * The real transport: the effect's HTTP output binding on the airlock's daprd.
 * Metadata named with a capital letter goes out as a header, so the host alone
 * sets them: the idempotency key, and the content type when there is a body.
 * The binding answers the sink's status in `Metadata.statuscode`, because the
 * cluster declares it with errorIfNot2XX off; a status from daprd itself other
 * than 200 means the sink was never answered, and is no answer.
 */
export function bindingsTransport(mesh: string): Transport {
  return async (binding, path, init, key, headers) => {
    const res = await fetch(`${mesh}/v1.0/bindings/${binding}`, {
      method: "POST",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: init.method.toLowerCase(),
        ...(init.body === undefined ? {} : { data: init.body }),
        // Metadata past the binding's own reaches the sink as headers: the
        // ledger key, and the credential the effect declares, which the host
        // alone holds.
        metadata: {
          ...headers,
          path: sinkPath(path),
          "Idempotency-Key": key,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
      }),
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`binding ${binding}: daprd answered ${res.status} ${text}`);
    const status = Number(res.headers.get("metadata.statuscode"));
    if (!Number.isInteger(status) || status < 100) throw new Error(`binding ${binding}: no sink status in daprd's answer`);
    const json = (res.headers.get("metadata.content-type") ?? "").includes("json");
    return { status, body: json && text !== "" ? JSON.parse(text) : text };
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
    return new Handler(name, file, compiled, timeoutMs, endowments);
  }

  /** One run of issue or reconcile against the sink, its answer checked, the
   * handler handed the values of the effect's secrets. */
  async call(fn: "issue" | "reconcile", input: unknown, key: string, transport: Transport, secrets: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<Answer> {
    const worker = new Worker(new URL("./cage.ts", import.meta.url), NONE);
    const serve = async (data: Record<string, unknown>) => {
      const id = data.id;
      try {
        const { path, method, body } = data.fetch as { path: unknown; method: unknown; body: unknown };
        if (typeof method !== "string" || !METHODS.has(method)) throw new TypeError(`sink method ${JSON.stringify(method)}`);
        worker.postMessage({ id, answer: await transport(this.name, sinkPath(path), { method, body }, key, headers) });
      } catch (e) {
        worker.postMessage({ id, failure: e instanceof Error ? e.message : String(e) });
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`effect ${this.name}: ${fn} gave no answer in ${this.timeoutMs}ms`)), this.timeoutMs);
    });
    const run = async () => {
      await exchange(worker, { source: this.compiled, file: this.file, endowments: this.endowments }, serve);
      return (await exchange(worker, { call: fn, input, key, secrets }, serve)).result;
    };
    try {
      return checked(this.name, fn, await Promise.race([run(), timeout]));
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
      if ("fetch" in data) return onHostCall(data);
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
