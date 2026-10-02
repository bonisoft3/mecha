/// <reference lib="deno.worker" />
// The worker a computation's module runs in. The host starts it with no
// permissions; SES locks the realm down, freezing every intrinsic, and takes
// the clock, randomness, time zone and locale out of the language. The module
// runs in a Compartment whose global holds the language (language.ts) and
// nothing of the host, and imports nothing: a computation is one file.
// What is left is a pure function's world: the inputs the host hands in,
// frozen, and whatever the module computes from them. The language is
// main.ts's.
//
// The host trusts nothing that comes back: it checks every message as data.

import "ses";
import { LANGUAGE } from "./language.ts";

const { apply, construct } = Reflect;

// Every option is spelled out, so no LOCKDOWN_* variable changes the realm.
// Errors keep their stacks: a failure names the module's file.
repairIntrinsics({
  errorTaming: "unsafe",
  errorTrapping: "none",
  unhandledRejectionTrapping: "none",
  reporting: "none",
  regExpTaming: "safe",
  localeTaming: "safe",
  consoleTaming: "unsafe",
  overrideTaming: "moderate",
  overrideDebug: [],
  stackFiltering: "verbose",
  domainTaming: "safe",
  evalTaming: "safe-eval",
  legacyRegeneratorRuntimeTaming: "safe",
  __hardenTaming__: "safe",
});

// Until hardenIntrinsics, the intrinsics stay writable: what the cage changes
// in them here is frozen with the rest.
const HostDate = globalThis.Date;
const unclocked = () => {
  throw new TypeError("a computation has no clock: date a value from its inputs");
};
// The host's zone and locale reach the language through more than Intl: every
// local-time Date method, and every toLocale* and localeCompare, which the
// engine answers from its own locale data whether or not Intl is a global.
// SES's locale taming answers the toLocale* forms in the default locale; a
// computation is told instead.
const unplaced = (what: string) => () => {
  throw new TypeError(`a computation has no time zone or locale: ${what} reads the host's; use the UTC forms`);
};
const refuse = (proto: object, names: string[]) => {
  for (const name of names) Object.defineProperty(proto, name, { value: unplaced(name) });
};
refuse(HostDate.prototype, [
  "getFullYear", "getYear", "getMonth", "getDate", "getDay", "getHours", "getMinutes", "getSeconds",
  "getMilliseconds", "getTimezoneOffset", "setFullYear", "setYear", "setMonth", "setDate", "setHours",
  "setMinutes", "setSeconds", "setMilliseconds", "toString", "toDateString", "toTimeString", "toLocaleString",
  "toLocaleDateString", "toLocaleTimeString",
]);
refuse(Number.prototype, ["toLocaleString"]);
refuse(BigInt.prototype, ["toLocaleString"]);
refuse(Array.prototype, ["toLocaleString"]);
refuse(Object.getPrototypeOf(Uint8Array.prototype), ["toLocaleString"]);
refuse(String.prototype, ["localeCompare", "toLocaleUpperCase", "toLocaleLowerCase"]);

// ISO 8601 that names its zone, or a bare date, which the language reads as
// UTC: a date-time with no offset, and every other form, is read as local.
const PLACED = /^(?:[+-]\d{6}|\d{4})(?:-\d\d(?:-\d\d)?)?(?:T\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d))?$/;
const placed = (text: string) => {
  if (!PLACED.test(text)) unplaced(`the date ${JSON.stringify(text)}`)();
  return text;
};
const timeValue = HostDate.prototype.getTime;
// A Date's own value, or undefined for anything else: the constructor's first
// branch, which reads the slot and runs nothing of the argument's.
const dated = (value: unknown): number | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return apply(timeValue, value, []);
  } catch (e) {
    if (e instanceof TypeError) return undefined;
    throw e;
  }
};
// ECMAScript's ToPrimitive with hint "default", which the constructor applies
// to every other argument before it decides whether to parse one.
const primitive = (value: unknown): unknown => {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return value;
  const exotic = (value as { [Symbol.toPrimitive]?: unknown })[Symbol.toPrimitive];
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic !== "function") throw new TypeError("Symbol.toPrimitive is not a function");
    const result = apply(exotic, value, ["default"]);
    if ((typeof result === "object" && result !== null) || typeof result === "function") {
      throw new TypeError("Cannot convert object to primitive value");
    }
    return result;
  }
  for (const name of ["valueOf", "toString"] as const) {
    const method = (value as Record<string, unknown>)[name];
    if (typeof method !== "function") continue;
    const result = apply(method, value, []);
    if ((typeof result !== "object" || result === null) && typeof result !== "function") return result;
  }
  throw new TypeError("Cannot convert object to primitive value");
};
function CagedDate(this: unknown, ...args: unknown[]) {
  if (new.target === undefined || args.length === 0) unclocked();
  if (args.length > 1) unplaced("new Date(year, month, …)")();
  // Converted here once and handed on converted, so what is checked is what
  // is parsed and a conversion with effects runs once.
  const value = dated(args[0]) ?? primitive(args[0]);
  if (typeof value === "string") placed(value);
  return construct(HostDate, [value], new.target);
}
Object.defineProperties(CagedDate, {
  prototype: { value: HostDate.prototype },
  parse: { value: (text: unknown) => HostDate.parse(placed(String(text))) },
  UTC: { value: HostDate.UTC },
  now: { value: unclocked },
});
Object.defineProperty(HostDate.prototype, "constructor", { value: CagedDate });
Object.defineProperty(Math, "random", {
  value: () => {
    throw new TypeError("a computation's randomness is its seed");
  },
});

hardenIntrinsics();
harden(CagedDate);

const EXPORTS = ["finish", "plan", "queries", "reads"];

type Module = {
  reads: unknown;
  queries: unknown;
  plan: (inputs: unknown, seed: number, outputs: unknown) => unknown;
  finish: (inputs: unknown, outputs: unknown) => unknown;
};
let module: Module;
let inputs: unknown;
let seed: number;

// A Compartment's global starts with SES's own powers, harden and Compartment
// among them; the module keeps the language alone.
function compartment(file: string, source: object) {
  const refuse = (specifier: string): never => {
    throw new TypeError(`${file} imports ${JSON.stringify(specifier)}: a computation is one file`);
  };
  const cell = new Compartment({
    __options__: true,
    noAggregateLoadErrors: true,
    name: file,
    // The realm's Math, whose random the cage refused above.
    globals: { Date: CagedDate, Math },
    modules: { [file]: { source } },
    resolveHook: refuse,
    importHook: refuse,
  });
  for (const name of Object.getOwnPropertyNames(cell.globalThis)) {
    if (!LANGUAGE.has(name)) delete (cell.globalThis as Record<string, unknown>)[name];
  }
  harden(cell.globalThis);
  return cell;
}

// One request, one reply: {source, file} loads the module, compiled by the
// host (workers.ts), and answers its reads and queries; {inputs, seed} answers
// plan's jobs before any ran; {outputs, plan: true} its jobs given those
// outputs; {outputs} finish's sinks. A throw is answered as {error}, its stack naming the file.
addEventListener("message", async (event) => {
  const { data } = event as MessageEvent;
  try {
    if ("source" in data) {
      const { file } = data;
      const { namespace } = await compartment(file, data.source).import(file);
      const names = Object.keys(namespace).sort();
      if (names.join() !== EXPORTS.join()) {
        throw new TypeError(`${file} must export exactly ${EXPORTS.join(", ")}; it exports ${names.join(", ")}`);
      }
      if (typeof namespace.plan !== "function" || typeof namespace.finish !== "function") {
        throw new TypeError(`${file}: plan and finish must be functions`);
      }
      module = namespace as Module;
      postMessage({ reads: module.reads, queries: module.queries });
    } else if ("inputs" in data) {
      inputs = harden(data.inputs);
      seed = data.seed;
      postMessage({ jobs: module.plan(inputs, seed, harden([])) });
    } else if (data.plan) {
      postMessage({ jobs: module.plan(inputs, seed, harden(data.outputs)) });
    } else {
      postMessage({ out: module.finish(inputs, harden(data.outputs)) });
    }
  } catch (e) {
    postMessage({ error: e instanceof Error ? e.stack ?? e.message : String(e) });
  }
});
