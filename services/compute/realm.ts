// The realm every mecha cage runs in, locked down on import: SES freezes every
// intrinsic and takes the clock, randomness, time zone and locale out of the
// language. A cage (this service's cage.ts, the airlock's) imports it first and
// builds its Compartment from CagedDate, the realm's Math and LANGUAGE.

import "ses";

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
export function CagedDate(this: unknown, ...args: unknown[]) {
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
