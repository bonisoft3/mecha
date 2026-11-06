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
  /** The fields the ledger key is made of: the instance's primary key and
   * whatever else names one invocation of it, so a row back in its invoking
   * state for another invocation is that one's. */
  key: string[];
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
  /** The bridge the sink is: the release targets its container runs on, and
   * whether the local stack runs a simulator in its place. Anywhere else no
   * call is made and the effect fails. */
  bridge?: { name: string; targets: string[]; simulated: boolean };
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

/** How long one call outside may take: a sink call, or storing one blob. */
export const CALL_TIMEOUT_MS = 45_000;

export function outcome(effect: Effect, answer: Answer | "unknown", reconciled: boolean): Outcome {
  if (answer === "unknown") return { target: effect.onError, kind: "unknown", data: null, reconciled };
  if ("done" in answer) return { target: effect.onDone, kind: "done", data: answer.done, reconciled };
  if ("failed" in answer) return { target: effect.onError, kind: "failed", data: answer.failed, reconciled };
  throw new Error("an absent answer is no outcome: the sink has no record, so the effect is issued");
}

/** The target the local stack's airlock stands on: launch's and the checks'. */
export const LOCAL = "local";

/** The outcome of an effect whose bridge is not deployed on `target`, or
 * null where it is: a permanent failure, settled without a handler or sink
 * call, so it spends no run and leaves no dead letter. On the local stack a
 * bridge is deployed as its simulator; on a release target, where it names
 * that target. */
export function undeployed(effect: Effect, target: string | undefined): Outcome | null {
  if (effect.bridge === undefined) return null;
  if (target === undefined) throw new Error(`the bridge ${effect.bridge.name} names its targets, and this airlock is told none`);
  if (target === LOCAL ? effect.bridge.simulated : effect.bridge.targets.includes(target)) return null;
  return { target: effect.onError, kind: "failed", data: { bridge: effect.bridge.name, target, reason: "not deployed" }, reconciled: false };
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
const HEADER_VALUE = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/;

/** The headers a handler sets on one sink call, checked: names daprd forwards,
 * none HTTP or the host sets (the idempotency key, the effect's credential),
 * and visible ASCII values. Both airlocks take them, so one handler sets them
 * in either. */
export function sinkHeaders(headers: unknown, host: string[] = []): Record<string, string> {
  if (headers === undefined) return {};
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new TypeError(`sink headers must be an object of strings, got ${JSON.stringify(headers)}`);
  }
  for (const [name, value] of Object.entries(headers)) {
    const taken = RESERVED_HEADERS.has(name.toLowerCase()) || host.some((h) => h.toLowerCase() === name.toLowerCase());
    if (!HEADER.test(name) || taken) {
      throw new TypeError(`sink header ${JSON.stringify(name)}: a name daprd forwards (uppercase first) that neither HTTP nor the host sets`);
    }
    if (typeof value !== "string" || !HEADER_VALUE.test(value)) {
      throw new TypeError(`sink header ${name}: the value is visible ASCII, got ${JSON.stringify(value)}`);
    }
  }
  return headers as Record<string, string>;
}
/** The effect's name is also its Dapr binding's. */
const ENDPOINT = /^[a-z][a-z0-9-]*$/;

/** The ledger key a row's current fields make, as the guard's claim spells it
 * (pronto's emit.cue #ledgerKeySql): one field as it is, several as a JSON
 * array, so a ':' in a value cannot make two instances read as one. A settle
 * moves only the row whose key is still the ledger's, never one that entered
 * the invoking state again for another invocation. */
export function ledgerKeySql(name: string, effect: Effect): string {
  if (!ENDPOINT.test(name)) throw new Error(`effect ${JSON.stringify(name)} is not a DNS label`);
  const fields = effect.key.map((f) => `"${f.replaceAll('"', '""')}"::text`);
  return fields.length === 1 ? `('${name}:' || ${fields[0]})` : `('${name}:' || jsonb_build_array(${fields.join(", ")})::text)`;
}

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
    if (!Array.isArray(e.key) || e.key.length === 0 || !e.key.every((c) => IDENTIFIER.test(c))) bad("key is not a list of identifiers");
    if (typeof e.idempotent !== "boolean") bad("idempotent is not a boolean");
    if (e.idempotent && e.reentry !== undefined) bad("an idempotent sink declares no reentry");
    if (!e.idempotent) {
      const r = e.reentry;
      if (r !== "reconcile" && r !== "unknown" && r !== "repeat") bad("reentry is not reconcile, unknown or repeat");
    }
    if (!Number.isInteger(e.attempts) || e.attempts < 1) bad("attempts is not a positive integer");
    if (e.endowments !== undefined) endowable(e.endowments, `effects.json: effect ${name}`);
    if (e.bridge !== undefined) {
      const b = e.bridge;
      if (
        typeof b !== "object" || b === null || !ENDPOINT.test(b.name) || typeof b.simulated !== "boolean" ||
        !Array.isArray(b.targets) || !b.targets.every((t) => typeof t === "string" && ENDPOINT.test(t) && t !== LOCAL)
      ) {
        bad("bridge is not {name, targets, simulated}: DNS labels, release targets only, and a boolean");
      }
    }
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
