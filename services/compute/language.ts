// A computation's global (main.ts's language): ECMAScript's globals as SES
// permits them, less what answers from the host: Intl's locale and zone,
// Temporal's clock, WeakRef's and FinalizationRegistry's collector, and the
// shared memory no second thread here could use.
export const LANGUAGE: ReadonlySet<string> = new Set([
  "globalThis", "Infinity", "NaN", "undefined", "eval", "isFinite", "isNaN", "parseFloat", "parseInt",
  "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "unescape",
  "Object", "Function", "Array", "Number", "Boolean", "String", "Symbol", "BigInt", "Date", "Promise", "RegExp",
  "Error", "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
  "JSON", "Math", "Reflect", "Proxy", "Map", "Set", "WeakMap", "WeakSet", "Iterator",
  "ArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float16Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
]);

// What a module may be endowed with past the language, each only where its
// declaration names it, as pronto endows an omnishell module with Intl. The
// values are endowments.ts's; a name here a module did not declare reads as a
// refusal, not as undefined.
export const ENDOWABLE: ReadonlySet<string> = new Set(["Crypto", "TextEncoder", "TextDecoder", "URL", "URLSearchParams", "Cheerio"]);

/** `names` checked as endowments a module may declare. */
export function endowable(names: unknown, who: string): string[] {
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string" && ENDOWABLE.has(n))) {
    throw new TypeError(`${who}: endowments ${JSON.stringify(names)} are not a list drawn from ${[...ENDOWABLE].join(", ")}`);
  }
  return names;
}
