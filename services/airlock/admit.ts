// Every effect of the manifest named first, its handler read under the
// directory named second and admitted as the airlock admits it at startup: a
// handler the airlock would refuse fails here first, naming its effect.
//
//   deno run --config deno.json --frozen --unstable-worker-options --allow-read --allow-env admit.ts <effects.json> <dir>

import { admitAll } from "./handler.ts";

if (Deno.args.length !== 2) throw new Error("usage: admit.ts <effects.json> <dir>");
await admitAll(Deno.args[0], Deno.args[1]);
