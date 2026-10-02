/// <reference lib="deno.worker" />
// The jobs' worker: started with no permissions, it runs one wasm job per
// message, each in a fresh instance (wasi.ts), and answers with what the job
// wrote, parsed.

import { runWasm } from "./wasi.ts";

let modules: Record<string, WebAssembly.Module>;

self.addEventListener("message", (event) => {
  const { data } = event as MessageEvent;
  if ("modules" in data) {
    modules = data.modules;
    return;
  }
  try {
    const out = runWasm(modules[data.wasm], new TextEncoder().encode(data.input), data.wasm);
    self.postMessage({ output: JSON.parse(new TextDecoder().decode(out)) });
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? e.stack ?? e.message : String(e) });
  }
});
