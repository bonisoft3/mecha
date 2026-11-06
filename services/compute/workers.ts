// The workers a computation runs in: a fresh cage (cage.ts) per run for its
// module, and one runner (job.ts) for every wasm job, all without permissions;
// and the module's admission, compiled once and loaded in a cage.

import { validateQueryStages, type StagedQueries } from "./query-stages.ts";
import { ModuleSource } from "@endo/module-source";
import { endowable } from "./language.ts";

const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const hashText = (text: string) => sha256(new TextEncoder().encode(text));

export async function executionVersion(): Promise<string> {
  const host = await Promise.all(["./workers.ts", "./job.ts", "./wasi.ts", "./query-stages.ts"].map(async (file) =>
    await sha256(await Deno.readFile(new URL(file, import.meta.url)))
  ));
  return await hashText(JSON.stringify({ protocol: 1, host, runtime: Deno.version, target: Deno.build.target }));
}

/** A job as the runner takes it: the wasm module's name and its stdin, JSON. */
export type Job = { wasm: string; input: string };

export interface JobCache {
  get(keys: string[]): Promise<Map<string, string>>;
  put(key: string, result: string): Promise<void>;
}

export const jobKey = (version: string, job: Job): Promise<string> =>
  hashText(JSON.stringify([version, job.wasm, job.input]));

const NONE = { type: "module", deno: { permissions: "none" } } as const;

/** The JSON text of `value`, refusing what JSON would silently change:
 * a non-finite number, undefined, a bigint, a function, a symbol. */
export function strictJson(value: unknown, sortKeys = false): string {
  return JSON.stringify(value, function (key, v) {
    const held = (this as Record<string, unknown>)[key];
    if (typeof held === "number" && !Number.isFinite(held)) throw new TypeError(`${key}: ${held} is no JSON number`);
    if (held === undefined || typeof held === "bigint" || typeof held === "function" || typeof held === "symbol") {
      throw new TypeError(`${key}: a ${typeof held} is no JSON value`);
    }
    if (sortKeys && typeof v === "object" && v !== null && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
}

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

/** The worker running wasm jobs, one at a time, each in a fresh instance.
 * Outputs are in job order. */
export class Runner {
  private worker = new Worker(new URL("./job.ts", import.meta.url), NONE);
  private memo?: { cache: JobCache; versions: Record<string, string> };

  constructor(modules: Record<string, WebAssembly.Module>) {
    this.worker.postMessage({ modules });
  }

  static async cached(modules: Record<string, Uint8Array<ArrayBuffer>>, cache: JobCache): Promise<Runner> {
    const engine = await executionVersion();
    const entries = await Promise.all(Object.entries(modules).map(async ([name, bytes]) => {
      const source = bytes.slice();
      return {
        name,
        module: await WebAssembly.compile(source),
        version: await hashText(JSON.stringify([engine, await sha256(source)])),
      };
    }));
    const runner = new Runner(Object.fromEntries(entries.map(({ name, module }) => [name, module])));
    runner.memo = { cache, versions: Object.fromEntries(entries.map(({ name, version }) => [name, version])) };
    return runner;
  }

  async run(jobs: Job[]): Promise<unknown[]> {
    const memo = this.memo;
    const keys = memo ? await Promise.all(jobs.map((job) => {
      const version = memo.versions[job.wasm];
      if (!version) throw new Error(`no WASM execution identity for ${job.wasm}`);
      // argv[0] and the exact stdin bytes are observable by a WASI command.
      return jobKey(version, job);
    })) : [];
    const retained = memo ? await memo.cache.get(keys) : new Map<string, string>();
    const outputs: unknown[] = [];
    for (const [index, job] of jobs.entries()) {
      const key = keys[index];
      if (retained.has(key)) {
        outputs.push(JSON.parse(retained.get(key)!));
        continue;
      }
      const answer = await reply(this.worker, job);
      if ("error" in answer) throw new Error(`job ${index} (${job.wasm}): ${answer.error}`);
      const json = answer.json as string;
      const output = JSON.parse(json);
      if (memo) {
        await memo.cache.put(key, json);
        retained.set(key, json);
      }
      outputs.push(output);
    }
    return outputs;
  }

  close() {
    this.worker.terminate();
  }

  [Symbol.dispose]() {
    this.close();
  }
}
