// What a handler run does, decided from the ledger alone: no clock, no
// network, no database. The shell (airlock.ts) reads the row, asks here, and
// writes what this answers.
//
// The ledger counts handler runs begun, the counter committing before the
// call. A count of one is the first run, which never reached the sink before.
// Past one, an earlier run may have reached it and died before the outcome was
// written, so the effect's declaration decides: an idempotent sink is called
// again with the same key; otherwise its `reentry` says reconcile, give up as
// unknown, or repeat, the program's note saying why a duplicate is acceptable.

import { endowable } from "../compute/language.ts";

/** What the program declared for an effect, as pronto emits it into
 * effects.json. */
export type Effect = {
  table: string;
  field: string;
  state: string;
  onDone: string;
  onError: string;
  row: string[];
  idempotent: boolean;
  reentry?: "reconcile" | "unknown" | "repeat";
  attempts: number;
  handler: string;
  /** The environment variables whose values the handler is handed. */
  secrets?: string[];
  /** A header the airlock adds to every call of the sink, its value the
   * named variable's (prefixed by `scheme`), which the handler never holds. */
  credential?: { header: string; scheme?: string; secret: string };
  /** What the handler may use past the language (compute's language.ts). */
  endowments?: string[];
};

export type Step = "issue" | "reconcile" | "unknown";

export function step(effect: Effect, entered: number): Step {
  if (entered < 1) throw new Error(`entered ${entered}: the counter commits before a run`);
  if (entered === 1 || effect.idempotent) return "issue";
  const reentry = effect.reentry;
  if (reentry === undefined) throw new Error("a sink that is not idempotent declares its reentry");
  if (reentry === "reconcile" || reentry === "unknown") return reentry;
  return "issue";
}

/** A handler's answer: the sink acted (`done`), refused (`failed`), or — from
 * reconcile only — has no record of the key (`absent`). */
export type Answer = { done: unknown } | { failed: unknown } | { absent: true };

/** The ledger's outcome, and the machine's next state with it. `unknown` is no
 * answer at all: the sink may have acted. */
export type Outcome = {
  target: string;
  kind: "done" | "failed" | "unknown";
  data: unknown;
  reconciled: boolean;
};

export function outcome(effect: Effect, answer: Answer | "unknown", reconciled: boolean): Outcome {
  if (answer === "unknown") return { target: effect.onError, kind: "unknown", data: null, reconciled };
  if ("done" in answer) return { target: effect.onDone, kind: "done", data: answer.done, reconciled };
  if ("failed" in answer) return { target: effect.onError, kind: "failed", data: answer.failed, reconciled };
  throw new Error("an absent answer is no outcome: the sink has no record, so the effect is issued");
}

/** A name the shell quotes into SQL: what the manifest may hold, and nothing
 * the quoting would have to escape. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** What a secret is named by: an environment variable. */
const TOKEN = /^[A-Za-z][A-Za-z0-9-]*$/;
// Daprd forwards a metadata key as a header only when its first letter is
// uppercase; and a credential never takes a header the host or HTTP sets.
const HEADER = /^[A-Z][A-Za-z0-9-]*$/;
const RESERVED_HEADERS = new Set(["idempotency-key", "content-type", "content-length", "accept", "host", "transfer-encoding", "traceparent", "tracestate", "baggage"]);
const SECRET = /^[A-Z][A-Z0-9_]*$/;
/** The effect's name is also its Dapr binding's. */
const ENDPOINT = /^[a-z][a-z0-9-]*$/;

/** effects.json, checked: the airlock dies on a manifest it would misread. */
export function parseManifest(text: string): Record<string, Effect> {
  const doc = JSON.parse(text);
  const effects = doc?.effects;
  if (typeof effects !== "object" || effects === null || Array.isArray(effects)) {
    throw new Error("effects.json: no `effects` map");
  }
  for (const [name, e] of Object.entries(effects as Record<string, Effect>)) {
    const bad = (why: string): never => {
      throw new Error(`effects.json: effect ${name}: ${why}`);
    };
    if (!ENDPOINT.test(name)) bad("the name is not a DNS label");
    for (const k of ["table", "field"] as const) if (!IDENTIFIER.test(e[k])) bad(`${k} ${JSON.stringify(e[k])} is not an identifier`);
    for (const k of ["state", "onDone", "onError", "handler"] as const) if (typeof e[k] !== "string" || e[k] === "") bad(`no ${k}`);
    if (!Array.isArray(e.row) || e.row.length === 0 || !e.row.every((c) => IDENTIFIER.test(c))) bad("row is not a list of identifiers");
    if (typeof e.idempotent !== "boolean") bad("idempotent is not a boolean");
    if (e.idempotent && e.reentry !== undefined) bad("an idempotent sink declares no reentry");
    if (!e.idempotent) {
      const r = e.reentry;
      if (r !== "reconcile" && r !== "unknown" && r !== "repeat") bad("reentry is not reconcile, unknown or repeat");
    }
    if (!Number.isInteger(e.attempts) || e.attempts < 1) bad("attempts is not a positive integer");
    if (e.endowments !== undefined) endowable(e.endowments, `effects.json: effect ${name}`);
    if (e.secrets !== undefined && (!Array.isArray(e.secrets) || !e.secrets.every((s) => typeof s === "string" && SECRET.test(s)))) {
      bad("secrets is not a list of environment variables' names");
    }
    if (e.credential !== undefined) {
      const c = e.credential;
      const token = (v: unknown) => typeof v === "string" && TOKEN.test(v);
      const header = (v: unknown) => typeof v === "string" && HEADER.test(v) && !RESERVED_HEADERS.has(v.toLowerCase());
      if (typeof c !== "object" || c === null || !header(c.header) || typeof c.secret !== "string" || !SECRET.test(c.secret) || (c.scheme !== undefined && !token(c.scheme))) {
        bad("credential is not {header, scheme?, secret}: a header name daprd forwards (uppercase first) that is neither the host's nor HTTP's own, a scheme word and an environment variable's name");
      }
    }
  }
  return effects;
}
