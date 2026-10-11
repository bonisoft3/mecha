// Each computation module named as an argument, loaded as the service loads
// it at startup, endowed with what follows its `=`: a module the service
// would refuse fails here first, naming its file and the rule.
//
//   deno run --config deno.json --frozen --unstable-worker-options --allow-read --allow-env admit.ts <file>[=<endowment>,...]...

import { admit } from "./workers.ts";

if (Deno.args.length === 0) throw new Error("usage: admit.ts <file>[=<endowment>,...]...");
for (const arg of Deno.args) {
  const [file, endowed] = arg.split("=");
  await admit(file, endowed === undefined || endowed === "" ? [] : endowed.split(","));
}
