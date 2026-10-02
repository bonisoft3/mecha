// Each computation module named as an argument, loaded as the service loads
// it at startup: a module the service would refuse fails here first, naming
// its file and the rule.
//
//   deno run --config deno.json --frozen --unstable-worker-options --allow-read --allow-env admit.ts <file>...

import { admit } from "./workers.ts";

if (Deno.args.length === 0) throw new Error("usage: admit.ts <file>...");
for (const file of Deno.args) await admit(file);
