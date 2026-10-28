// The values a cage grants a module that declares them (language.ts's
// ENDOWABLE), and the refusal it reads for one it did not. Imported by a cage
// after realm.ts has locked the realm down.

import { Cheerio } from "./cheerio.ts";
import { Crypto } from "./crypto.ts";
import { endowable, ENDOWABLE } from "./language.ts";

const VALUES: Record<string, unknown> = { Crypto, TextEncoder, TextDecoder, URL, URLSearchParams, Cheerio };

/** A compartment's globals for a module declaring `names`: each declared
 * endowment, hardened, and a throwing getter for every endowable name it did
 * not declare, so a use fails loudly at the line that makes it. */
export function endow(names: unknown, who: string): PropertyDescriptorMap {
  const granted = new Set(endowable(names, who));
  const globals: PropertyDescriptorMap = {};
  for (const name of ENDOWABLE) {
    globals[name] = granted.has(name)
      ? { value: harden(VALUES[name]), enumerable: false, configurable: false, writable: false }
      : {
        get: () => {
          throw new TypeError(`${who}: ${name} is not endowed; declare it among the module's endowments`);
        },
        enumerable: false,
        configurable: false,
      };
  }
  return globals;
}
