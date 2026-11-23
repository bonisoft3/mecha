// The workers a computation runs in: a fresh cage (cage.ts) per run for its
// module, and a bounded worker pool (job.ts) for wasm jobs, all without
// permissions; and the module's admission, compiled once and loaded in a cage.

import { validateQueryStages, type StagedQueries } from "./query-stages.ts";
import { ModuleSource } from "npm:@endo/module-source@1.4.0";
import { endowable } from "./language.ts";
import { normalizeSelect } from "./wasm-select.ts";
export { normalizeSelect } from "./wasm-select.ts";

const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const hashText = (text: string) => sha256(new TextEncoder().encode(text));

export async function executionVersion(): Promise<string> {
  const host = await Promise.all(["./job.ts", "./wasm-select.ts", "./wasi.ts"].map(async (file) =>
    await sha256(await Deno.readFile(new URL(file, import.meta.url)))
  ));
  return await hashText(JSON.stringify({ protocol: 2, host, runtime: Deno.version, target: Deno.build.target }));
}

/** A job as the runner takes it: the wasm module's name and its stdin, JSON. */
export type Job = { wasm: string; input: string; select?: readonly string[] };

export interface JobCache {
  get(keys: string[]): Promise<Map<string, string>>;
  put(key: string, result: string): Promise<void>;
}

export const jobKey = (version: string, job: Job): Promise<string> => {
  const select = normalizeSelect(job.select);
  return hashText(JSON.stringify(select ? [version, job.wasm, job.input, select] : [version, job.wasm, job.input]));
};

const NONE = { type: "module", deno: { permissions: "none" } } as const;

export { strictJson } from "../../packages/compute-snapshot/src/json.ts";

function reply(worker: Worker, message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.onerror = (e) => {
      e.preventDefault();
      reject(new Error(e.message));
    };
    worker.postMessage(message);
  });
}

/** One run of a computation's module: loaded, asked, and terminated. */
export class Cage {
  private worker = new Worker(new URL("./cage.ts", import.meta.url), NONE);

  constructor(private file: string) {}

  async ask(message: unknown): Promise<Record<string, unknown>> {
    const answer = await reply(this.worker, message);
    if ("error" in answer) throw new Error(`computation ${this.file}: ${answer.error}`);
    return answer;
  }

  /** The module, as `compile` made it, loaded with the endowments it declares:
   * its reads and queries, as data. */
  async load(compiled: ModuleSource, endowments: string[]): Promise<{ reads: unknown; queries: unknown; queryStages?: unknown }> {
    const { reads, queries, queryStages } = await this.ask({ source: compiled, file: this.file, endowments });
    return { reads, queries, ...(queryStages === undefined ? {} : { queryStages }) };
  }

  close() {
    this.worker.terminate();
  }
}

/** `source` compiled for the cage. Compiled here: Babel reads the environment,
 * which the cage cannot. What the cage gets is data, a program it evaluates in
 * its compartment. */
export function compile(file: string, source: string): ModuleSource {
  try {
    return new ModuleSource(source, file);
  } catch (e) {
    throw new Error(`computation ${file}: ${e}`, { cause: e });
  }
}

/** A module the cage admits: compiled, loaded, exporting the contract's
 * names, its reads table names and its queries SQL (main.ts). */
export type Admitted = { compiled: ModuleSource; reads: string[]; queries: Record<string, string>; queryStages?: StagedQueries };

/** A table name the service quotes nowhere. */
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The module at `file`, endowed with what its computation declares, as the
 * service loads it. */
export async function admit(file: string, endowments: string[]): Promise<Admitted> {
  const compiled = compile(file, await Deno.readTextFile(file));
  const cage = new Cage(file);
  let declared: { reads: unknown; queries: unknown; queryStages?: unknown };
  try {
    declared = await cage.load(compiled, endowable(endowments, `computation ${file}`));
  } finally {
    cage.close();
  }
  const { reads, queries } = declared;
  if (!Array.isArray(reads) || !reads.every((t) => typeof t === "string" && IDENTIFIER.test(t))) {
    throw new Error(`computation ${file}: exports no \`reads\` list of table names`);
  }
  if (
    typeof queries !== "object" || queries === null || Array.isArray(queries) ||
    !Object.values(queries).every((q) => typeof q === "string")
  ) {
    throw new Error(`computation ${file}: exports no \`queries\` map of SQL`);
  }
  const queryStages = validateQueryStages(declared.queryStages, queries as Record<string, string>);
  return { compiled, reads, queries: queries as Record<string, string>, ...(queryStages ? { queryStages } : {}) };
}

function defaultConcurrency(): number {
  const available = typeof navigator !== "undefined" && Number.isSafeInteger(navigator.hardwareConcurrency)
    ? navigator.hardwareConcurrency
    : 1;
  return Math.max(1, Math.min(16, available));
}

/** Bounded worker pool running pure wasm jobs, each in a fresh WASI instance.
 * Outputs are returned in job order. */
export class Runner {
  readonly concurrency: number;
  private allWorkers = new Set<Worker>();
  private idle: Worker[] = [];
  private busy = new Map<Worker, (error: Error) => void>();
  private waiters: { resolve: (worker: Worker) => void; reject: (error: Error) => void }[] = [];
  private inflight = new Map<string, Promise<string>>();
  private closed = false;
  private memo?: { cache: JobCache; versions: Record<string, string> };

  constructor(
    private modules: Record<string, WebAssembly.Module>,
    options: { concurrency?: number } = {},
  ) {
    const concurrency = options.concurrency ?? defaultConcurrency();
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("Runner concurrency must be a positive safe integer");
    }
    this.concurrency = concurrency;
  }

  static async cached(
    modules: Record<string, Uint8Array<ArrayBuffer>>,
    cache: JobCache,
    options: { concurrency?: number } = {},
  ): Promise<Runner> {
    const engine = await executionVersion();
    const entries = await Promise.all(Object.entries(modules).map(async ([name, bytes]) => {
      const source = bytes.slice();
      return {
        name,
        module: await WebAssembly.compile(source),
        version: await hashText(JSON.stringify([engine, await sha256(source)])),
      };
    }));
    const runner = new Runner(Object.fromEntries(entries.map(({ name, module }) => [name, module])), options);
    runner.memo = { cache, versions: Object.fromEntries(entries.map(({ name, version }) => [name, version])) };
    return runner;
  }

  private spawn(): Worker {
    const worker = new Worker(new URL("./job.ts", import.meta.url), NONE);
    worker.postMessage({ modules: this.modules });
    this.allWorkers.add(worker);
    return worker;
  }

  private acquire(): Promise<Worker> {
    if (this.closed) return Promise.reject(new Error("WASM runner is closed"));
    const ready = this.idle.pop();
    if (ready) return Promise.resolve(ready);
    if (this.allWorkers.size < this.concurrency) {
      return Promise.resolve(this.spawn());
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private release(worker: Worker, healthy: boolean) {
    if (!healthy || this.closed) {
      this.allWorkers.delete(worker);
      worker.terminate();
      if (!this.closed && this.waiters.length > 0 && this.allWorkers.size < this.concurrency) {
        this.waiters.shift()!.resolve(this.spawn());
      }
      return;
    }
    const next = this.waiters.shift();
    if (next) next.resolve(worker);
    else this.idle.push(worker);
  }

  private async execute(job: Job, index: number): Promise<string> {
    const select = normalizeSelect(job.select);
    const worker = await this.acquire();
    let healthy = false;
    try {
      const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const settle = (fn: () => void) => {
          this.busy.delete(worker);
          worker.onmessage = null;
          worker.onerror = null;
          fn();
        };
        this.busy.set(worker, (err) => settle(() => reject(err)));
        worker.onmessage = (e) => settle(() => resolve(e.data));
        worker.onerror = (e) => {
          e.preventDefault();
          settle(() => reject(new Error(e.message)));
        };
        worker.postMessage(select ? { wasm: job.wasm, input: job.input, select } : { wasm: job.wasm, input: job.input });
      });
      healthy = true;
      if ("error" in answer) throw new Error(`job ${index} (${job.wasm}): ${answer.error}`);
      return answer.json as string;
    } finally {
      this.release(worker, healthy);
    }
  }

  async run(jobs: Job[]): Promise<unknown[]> {
    if (this.closed) throw new Error("WASM runner is closed");
    if (jobs.length === 0) return [];
    const memo = this.memo;
    const keys = memo ? await Promise.all(jobs.map((job) => {
      const version = memo.versions[job.wasm];
      if (!version) throw new Error(`no WASM execution identity for ${job.wasm}`);
      // argv[0], stdin bytes, and any output field projection determine the answer.
      return jobKey(version, job);
    })) : [];
    const retained = memo ? await memo.cache.get([...new Set(keys)]) : new Map<string, string>();
    const jsons = await Promise.all(jobs.map(async (job, index) => {
      if (!memo) return await this.execute(job, index);
      const key = keys[index];
      const hit = retained.get(key);
      if (hit !== undefined) return hit;
      let pending = this.inflight.get(key);
      if (!pending) {
        pending = (async () => {
          try {
            const json = await this.execute(job, index);
            await memo.cache.put(key, json);
            return json;
          } finally {
            this.inflight.delete(key);
          }
        })();
        this.inflight.set(key, pending);
      }
      return await pending;
    }));
    return jsons.map((json) => JSON.parse(json));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new Error("WASM runner is closed"));
    }
    for (const reject of [...this.busy.values()]) {
      reject(new Error("WASM runner is closed"));
    }
    this.idle.length = 0;
    for (const worker of this.allWorkers) worker.terminate();
    this.allWorkers.clear();
  }

  [Symbol.dispose]() {
    this.close();
  }
}
