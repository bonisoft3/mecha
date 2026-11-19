/// <reference lib="deno.worker" />
// The jobs' worker: started with no permissions, it runs one wasm job per
// message, each in a fresh instance (wasi.ts), and answers with what the job
// wrote, parsed.

import { projectOutput } from "./wasm-select.ts";
import { runWasm } from "./wasi.ts";

let modules: Record<string, WebAssembly.Module>;

self.addEventListener("message", (event) => {
  const { data } = event as MessageEvent;
  if ("modules" in data) {
    modules = data.modules;
    return;
  }
  try {
    const out = runWasm(
      modules[data.wasm],
      new TextEncoder().encode(data.input),
      data.wasm,
    );
    const json = projectOutput(new TextDecoder().decode(out), data.select);
    self.postMessage({ json });
  } catch (e) {
    self.postMessage({
      error: e instanceof Error ? e.stack ?? e.message : String(e),
    });
  }
});
