// The one Compartment a cage builds around a module: the language
// (language.ts) and nothing of the host, what the module declares
// (endowments.ts), and no imports, since a module is one file. A
// Compartment's global starts with SES's own powers, harden and Compartment
// among them; the module keeps the language alone. Imported by a cage after
// realm.ts has locked the realm down.

import { CagedDate } from "./realm.ts";
import { endow } from "./endowments.ts";
import { LANGUAGE } from "./language.ts";

/** `kind` names the module in the refusal of an import: "a computation". */
export function compartment(file: string, source: object, endowments: unknown, kind: string): Compartment {
  const refuse = (specifier: string): never => {
    throw new TypeError(`${file} imports ${JSON.stringify(specifier)}: ${kind} is one file`);
  };
  const cell = new Compartment({
    __options__: true,
    noAggregateLoadErrors: true,
    name: file,
    // The realm's Math, whose random realm.ts refused.
    globals: { Date: CagedDate, Math },
    modules: { [file]: { source } },
    resolveHook: refuse,
    importHook: refuse,
  });
  for (const name of Object.getOwnPropertyNames(cell.globalThis)) {
    if (!LANGUAGE.has(name)) delete (cell.globalThis as Record<string, unknown>)[name];
  }
  Object.defineProperties(cell.globalThis, endow(endowments, file));
  harden(cell.globalThis);
  return cell;
}
