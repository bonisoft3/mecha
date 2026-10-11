/// <reference lib="deno.worker" />
// The worker a computation's module runs in. The host starts it with no
// permissions, and realm.ts locks the realm down. The module
// runs in a Compartment whose global holds the language (language.ts) and
// nothing of the host, and imports nothing: a computation is one file.
// What is left is a pure function's world: the inputs the host hands in,
// frozen, and whatever the module computes from them. The language is
// main.ts's.
//
// The host trusts nothing that comes back: it checks every message as data.

import "./realm.ts";
import { compartment } from "./compartment.ts";

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


// One request, one reply: {source, file, endowments} loads the module, compiled by the
// host (workers.ts), and answers its reads and queries; {inputs, seed} answers
// plan's jobs before any ran; {outputs, plan: true} its jobs given those
// outputs; {outputs} finish's sinks. A throw is answered as {error}, its stack naming the file.
addEventListener("message", async (event) => {
  const { data } = event as MessageEvent;
  try {
    if ("source" in data) {
      const { file } = data;
      const { namespace } = await compartment(file, data.source, data.endowments, "a computation").import(file);
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
      postMessage({ jobs: await module.plan(inputs, seed, harden([])) });
    } else if (data.plan) {
      postMessage({ jobs: await module.plan(inputs, seed, harden(data.outputs)) });
    } else {
      postMessage({ out: await module.finish(inputs, harden(data.outputs)) });
    }
  } catch (e) {
    postMessage({ error: e instanceof Error ? e.stack ?? e.message : String(e) });
  }
});
