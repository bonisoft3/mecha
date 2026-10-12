/// <reference lib="deno.worker" />
// The worker an effect's handler runs in: compute's realm (../compute/realm.ts),
// no permissions, and a Compartment holding the language and nothing of the
// host. What the handler gets past the language is three arguments: the
// input the interpreter froze into the ledger; a sink whose `fetch` takes a path,
// which crosses here as a message so the host decides where it goes
// (handler.ts); and the values of the secrets the effect declares, read by the
// host and never written to the ledger. The sink's `key` is the ledger key,
// which the host also sends as the request's Idempotency-Key. A handler that
// signs does so itself, with Crypto where its effect declares it.

import "../compute/realm.ts";
import { compartment } from "../compute/compartment.ts";

type Module = {
  issue: (input: unknown, sink: unknown, secrets: unknown) => unknown;
  reconcile?: (input: unknown, sink: unknown, secrets: unknown) => unknown;
};
let module: Module;


// A host call in flight waits on the reply carrying its id.
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 0;

function ask(message: Record<string, unknown>) {
  const id = nextId++;
  postMessage({ ...message, id });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject })).then((r) => harden(r));
}

function sink(key: string) {
  return harden({
    key,
    fetch(path: unknown, init: unknown = {}) {
      const { method = "GET", body } = (init ?? {}) as { method?: unknown; body?: unknown };
      return ask({ fetch: { path, method, body } });
    },
  });
}

// {source, file, endowments} loads the module and answers its exports' names; {call,
// input, key, secrets} runs issue or reconcile and answers {result}; {id,
// answer} and {id, failure} settle a fetch. A throw is answered as {error}.
addEventListener("message", async (event) => {
  const { data } = event as MessageEvent;
  if ("answer" in data || "failure" in data) {
    const waiter = pending.get(data.id);
    if (waiter === undefined) throw new Error(`no host call ${data.id} is waiting`);
    pending.delete(data.id);
    if ("answer" in data) waiter.resolve(data.answer);
    else waiter.reject(new Error(data.failure));
    return;
  }
  try {
    if ("source" in data) {
      const { namespace } = await compartment(data.file, data.source, data.endowments, "a handler").import(data.file);
      module = namespace as Module;
      postMessage({ exports: Object.keys(namespace).sort() });
    } else {
      const fn = module[data.call as "issue" | "reconcile"];
      if (typeof fn !== "function") throw new TypeError(`the handler exports no ${data.call} function`);
      postMessage({ result: await fn(harden(data.input), sink(data.key), harden(data.secrets)) });
    }
  } catch (e) {
    postMessage({ error: e instanceof Error ? e.stack ?? e.message : String(e) });
  }
});
