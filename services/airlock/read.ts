// A read: an effect that is an HTTP GET. A GET is safe (RFC 9110 §9.2.1), so
// nothing claims it: no ledger row, no idempotency key, no reentry, and no
// count of attempts that ends in `unknown`, since asking again changes nothing
// at the sink. The declaration is the request and the sink's answer is the
// outcome; there is no handler.
//
// got performs it, configured and not wrapped: its retry (408, 429, 5xx and
// network errors, honouring Retry-After) and timeouts are the program's to
// tune in got's own option shapes, and its cache is HTTP's (RFC 9111), an
// in-memory LRU in this process. It calls the same daprd endpoint a write's
// handler does, so a read stays behind the wall: it names a path, never a URL,
// and follows no redirect itself.
//
// A read is a machine's: its interpreter enqueues it as a row enters the
// invoking state, as a write's is, and its answer arrives as the machine's
// onDone or onError (airlock.ts). A screen asks one by writing the row.

import got from "got";
import http from "node:http";
import QuickLRU from "quick-lru";
import { sinkPath } from "./handler.ts";
import { CREDENTIAL, credentialChecked } from "./reentry.ts";

/** got's retry, as far as JSON spells it (got's RetryOptions). */
export type Retry = { limit?: number; statusCodes?: number[]; errorCodes?: string[]; backoffLimit?: number; noise?: number; maxRetryAfter?: number };
/** got's timeouts, in milliseconds (got's Delays). */
export type Timeout = { lookup?: number; connect?: number; secureConnect?: number; socket?: number; send?: number; response?: number; read?: number; request?: number };

/** A read as pronto emits it into effects.json's `reads`. */
export type Read = {
  /** RFC 9110's request line: the method, and the path as an RFC 6570
   * template over the input (`{var}` in the path, `{?var,...}` in the query). */
  request: { method: "GET"; path: string };
  /** Where its answer lands: the row's state field and the state it waits
   * in, the targets, the primary key, `count`, the column counting the row's
   * entries into the state, and `incarnation`, the column naming the row
   * apart from one made again under its key. Its input comes with each job. */
  invoke: { table: string; field: string; state: string; onDone: string; onError: string; row: string[]; count: string; incarnation: string };
  /** Freshness, in Cache-Control's syntax, for an answer the sink sends none for. */
  cacheControl?: string;
  got?: { retry?: Retry; timeout?: Timeout };
  credential?: { header: string; scheme?: string; secret: string };
};

/** A couple of quick retries; a request well inside the read's own bound. */
const RETRY: Retry = { limit: 2, backoffLimit: 1_000, maxRetryAfter: 5_000 };
const TIMEOUT: Timeout = { request: 5_000 };
/** The longest a read takes, its retries included. */
export const READ_TIMEOUT_MS = 20_000;
/** A connection per read to the daprd beside it: on a kept-alive socket
 * Deno's node:http sent a timed-out GET a second time and got's timeout never
 * fired (measured, Deno 2.9.7, got 16.2.0). */
const AGENT = { http: new http.Agent({ keepAlive: false }) };
/** Answers stored, and the largest stored; past it, or of no stated
 * Content-Length, an answer is not kept. */
const CACHE_ENTRIES = 1_000;
const CACHE_BYTES = 1 << 20;

/** RFC 9110 §15.1: the status codes a cache may give a heuristic freshness,
 * which is what a declared default stands in for. */
const HEURISTIC = new Set([200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501]);

const NAME = /^[a-z][a-z0-9-]*$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VARS = "[A-Za-z_][A-Za-z0-9_]*(?:,[A-Za-z_][A-Za-z0-9_]*)*";
const EXPRESSION = new RegExp(`\\{([?&]?)(${VARS})\\}`, "g");
/** The template's literal characters are a sink path's (handler.ts); its
 * expressions are RFC 6570's simple and form-style query ones. */
const TEMPLATE = new RegExp(`^/(?:[A-Za-z0-9\\-._~!$&'()*+,;=:@/?]|\\{[?&]?${VARS}\\})*$`);
const DIRECTIVE = /^[a-z-]+(=("[^"]*"|[0-9]+|[a-z-]+))?$/;
const RETRY_KEYS = ["limit", "statusCodes", "errorCodes", "backoffLimit", "noise", "maxRetryAfter"];
const TIMEOUT_KEYS = ["lookup", "connect", "secureConnect", "socket", "send", "response", "read", "request"];

/** The variables a template names, in order. */
export function templateVariables(path: string): string[] {
  return [...path.matchAll(EXPRESSION)].flatMap((m) => m[2].split(","));
}

/** A value the request cannot carry: the row asked wrongly, not the sink. */
export class Unsendable extends Error {}

// RFC 6570's unreserved set: everything else is percent-encoded.
const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function scalar(name: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return String(v);
  throw new Unsendable(`${name} is ${JSON.stringify(v)}: a read sends strings, numbers and booleans`);
}

/** A percent-encoded octet a segment may not carry: one decoding to `/`, `\`,
 * `.` or `%` could climb out of its segment or decode again at the sink, and
 * NUL is no character of a path. */
const UNSAFE_OCTET = /%(?:2F|5C|2E|25|00)/i;
const OCTET = /%[0-9A-F]{2}/gi;

/** The path RFC 6570 expands `template` to, checked as a sink path: `{var}`
 * is one segment, its other characters percent-encoded, so a value can name
 * `São Paulo` or an address but never another segment; `{?a,b}` and `{&a,b}`
 * leave out what is undefined. */
export function expand(template: string, values: Record<string, unknown>): string {
  const path = template.replace(EXPRESSION, (_, op: string, names: string) => {
    const vars = names.split(",");
    if (op === "") {
      return vars.map((n) => {
        const v = scalar(n, values[n]);
        if (v === undefined || v === "") throw new Unsendable(`${n} is missing, and the path needs it`);
        return pct(v);
      }).join(",");
    }
    const pairs = vars.flatMap((n) => {
      const v = scalar(n, values[n]);
      return v === undefined ? [] : [`${pct(n)}=${pct(v)}`];
    });
    return pairs.length === 0 ? "" : op + pairs.join("&");
  });
  const segments = path.split("?")[0];
  if (UNSAFE_OCTET.test(segments)) throw new Unsendable(`sink path ${JSON.stringify(path)}: a value would escape its segment`);
  try {
    // Checked as the write path's is, each safe octet standing as a letter.
    sinkPath(segments.replace(OCTET, "A") + path.slice(segments.length));
    return path;
  } catch (e) {
    throw new Unsendable((e as Error).message);
  }
}

/** effects.json's reads, checked: the airlock dies on a manifest it would misread. */
export function parseReads(text: string): Record<string, Read> {
  const reads = JSON.parse(text)?.reads ?? {};
  if (typeof reads !== "object" || reads === null || Array.isArray(reads)) throw new Error("effects.json: `reads` is not a map");
  for (const [name, r] of Object.entries(reads as Record<string, Read>)) {
    const bad = (why: string): never => {
      throw new Error(`effects.json: read ${name}: ${why}`);
    };
    if (!NAME.test(name)) bad("the name is not a DNS label");
    const known = ["request", "invoke", "cacheControl", "got", "credential"];
    for (const k of Object.keys(r)) if (!known.includes(k)) bad(`${k} is no word of a read`);
    if (r.request?.method !== "GET" || typeof r.request.path !== "string" || !TEMPLATE.test(r.request.path) || Object.keys(r.request).length !== 2) {
      bad("request is not {method: GET, path}: an absolute path in plain characters with RFC 6570 {var} and {?var} expressions");
    }
    const i = r.invoke;
    if (typeof i !== "object" || i === null) bad("invoke is not where its answer lands");
    for (const k of ["table", "field", "count", "incarnation"] as const) if (!IDENTIFIER.test(i[k])) bad(`invoke.${k} is not an identifier`);
    for (const k of ["state", "onDone", "onError"] as const) if (typeof i[k] !== "string" || i[k] === "") bad(`invoke has no ${k}`);
    if (!Array.isArray(i.row) || i.row.length === 0 || !i.row.every((c) => IDENTIFIER.test(c))) bad("invoke.row is not a list of identifiers");
    if (r.cacheControl !== undefined) {
      const ds = typeof r.cacheControl === "string" ? r.cacheControl.split(",").map((d) => d.trim().toLowerCase()) : [];
      if (ds.length === 0 || !ds.every((d) => DIRECTIVE.test(d))) bad("cacheControl is not Cache-Control's directives");
      if (ds.includes("private")) bad("cacheControl says private, and the airlock's cache is shared by every row's read");
    }
    if (r.got !== undefined) {
      const g = r.got;
      const plain = (o: unknown, keys: string[]) =>
        typeof o === "object" && o !== null && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));
      if (!plain(g, ["retry", "timeout"]) || (g.retry !== undefined && !plain(g.retry, RETRY_KEYS)) || (g.timeout !== undefined && !plain(g.timeout, TIMEOUT_KEYS))) {
        bad(`got is not {retry?: {${RETRY_KEYS.join(", ")}}, timeout?: {${TIMEOUT_KEYS.join(", ")}}}`);
      }
    }
    if (r.credential !== undefined && !credentialChecked(r.credential)) bad(CREDENTIAL);
  }
  return reads as Record<string, Read>;
}

type Store = { get(k: string): unknown; set(k: string, v: unknown, ttl?: number): boolean; delete(k: string): boolean; clear(): void };

/** The process's cache: one LRU of answers, shared by every row's read and
 * so keeping no private answer (RFC 9111 §5.2.2.7), partitioned by the
 * request's own path: got's key is the URL as normalize-url rewrites it,
 * which drops utm_ parameters and spells a space as `+`, so two requests HTTP
 * tells apart could share it. */
export class ReadCache {
  #answers = new QuickLRU<string, unknown>({ maxSize: CACHE_ENTRIES });
  #partitions = new QuickLRU<string, Store>({ maxSize: CACHE_ENTRIES });

  /** got keeps a store's state per store object, so each partition is one. */
  partition(path: string): Store {
    let store = this.#partitions.get(path);
    if (store === undefined) {
      const answers = this.#answers;
      const at = (k: string) => `${path}\u0000${k}`;
      store = {
        get: (k) => answers.get(at(k)),
        set: (k, v, ttl) => (answers.set(at(k), v, ttl === undefined ? undefined : { maxAge: ttl }), true),
        delete: (k) => answers.delete(at(k)),
        clear: () => {
          for (const k of [...answers.keys()]) if (k.startsWith(`${path}\u0000`)) answers.delete(k);
        },
      };
      this.#partitions.set(path, store);
    }
    return store;
  }

  /** What the cache is keyed by: method and URL, never a header. */
  keys(): string[] {
    return [...this.#answers.keys()];
  }
}

/** Where a read goes: the airlock's daprd, the header its credential adds,
 * and the cache. */
export type Reach = { mesh: string; headers: Record<string, string>; cache: ReadCache };

/** A sink's answer as it came, or as the cache kept it. */
export type Answer = { status: number; headers: Record<string, string>; body: Uint8Array<ArrayBuffer>; fromCache: boolean };

/** The headers with the read's default freshness where the sink gave none
 * (no Cache-Control, no Expires) and RFC 9110 lets a cache give one. */
function freshened(headers: Record<string, string | string[] | undefined>, status: number, cacheControl: string | undefined) {
  if (cacheControl !== undefined && headers["cache-control"] === undefined && headers["expires"] === undefined && HEURISTIC.has(status)) {
    headers["cache-control"] = cacheControl;
  }
}

/** One GET of the read's sink, through got and its cache. A daprd failure, a
 * timeout or a network error past got's retries throws: no answer. */
export async function get(name: string, read: Read, values: Record<string, unknown>, reach: Reach): Promise<Answer> {
  const path = expand(read.request.path, values);
  const res = await got(`${reach.mesh}/v1.0/invoke/${name}/method${path}`, {
    method: "GET",
    headers: { accept: "application/json", ...reach.headers },
    // Duck-typed by got's Keyv: get, set, delete and clear.
    cache: reach.cache.partition(path) as unknown as Map<string, unknown>,
    cacheOptions: { shared: true },
    hooks: {
      // What the cache stores, not what the row is handed: the default
      // freshness is applied before the cache judges the answer storable.
      beforeCache: [(response) => {
        freshened(response.headers, response.statusCode ?? 0, read.cacheControl);
        // Only a body whose size is known before it is read: a chunked one
        // could be any size.
        const length = Number(response.headers["content-length"]);
        if (!Number.isInteger(length) || length > CACHE_BYTES) return false;
      }],
    },
    retry: { ...RETRY, ...read.got?.retry, methods: ["GET"] },
    timeout: { ...TIMEOUT, ...read.got?.timeout },
    // A redirect is the sink's answer: followed here, it would leave the
    // daprd's endpoint for a URL the wall never saw.
    followRedirect: false,
    agent: AGENT,
    throwHttpErrors: false,
    responseType: "buffer",
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  const headers: Record<string, string | string[] | undefined> = { ...res.headers };
  freshened(headers, res.statusCode, read.cacheControl);
  const body = new Uint8Array(res.rawBody);
  // daprd's own failure to invoke (README's ERR_DIRECT_INVOKE, a 500): the
  // mesh's to fix, not the sink's answer. A sink's own errorCode is its answer.
  if (res.statusCode === 500 && String(headers["content-type"] ?? "").includes("json")) {
    let code: unknown;
    try {
      code = JSON.parse(new TextDecoder().decode(body))?.errorCode;
    } catch {
      code = undefined;
    }
    if (code === "ERR_DIRECT_INVOKE") throw new Error(`read ${name}: daprd answered ${new TextDecoder().decode(body)}`);
  }
  return {
    status: res.statusCode,
    headers: Object.fromEntries(Object.entries(headers).flatMap(([k, v]) => v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v]])),
    body,
    fromCache: res.isFromCache,
  };
}

/** The answer's body: parsed when the sink answers JSON, its text otherwise. */
export function bodyOf(answer: Answer): unknown {
  const text = new TextDecoder().decode(answer.body);
  return (answer.headers["content-type"] ?? "").includes("json") && text !== "" ? JSON.parse(text) : text;
}

/** A machine's outcome: a 2xx is done, anything else the sink answered is
 * failed with its status. `unknown` is no read's: a GET changed nothing. */
export function readOutcome(invoke: Read["invoke"], answer: Answer): { target: string; kind: "done" | "failed"; data: unknown } {
  const body = bodyOf(answer);
  return answer.status >= 200 && answer.status < 300
    ? { target: invoke.onDone, kind: "done", data: body }
    : { target: invoke.onError, kind: "failed", data: { status: answer.status, body } };
}
