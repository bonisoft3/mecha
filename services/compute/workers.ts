// The workers a computation runs in: a fresh cage (cage.ts) per run for its
// module, and one runner (job.ts) for every wasm job, all without permissions;
// and the module's admission, compiled once and loaded in a cage.

import { ModuleSource } from "@endo/module-source";

/** A job as the runner takes it: the wasm module's name and its stdin, JSON. */
export type Job = { wasm: string; input: string };

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

  /** The module, as `compile` made it, loaded: its reads and queries, as data. */
  async load(compiled: ModuleSource): Promise<{ reads: unknown; queries: unknown }> {
    const { reads, queries } = await this.ask({ source: compiled, file: this.file });
    return { reads, queries };
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
export type Admitted = { compiled: ModuleSource; reads: string[]; queries: Record<string, string> };

/** A table name the service quotes nowhere. */
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The module at `file` as the service loads it. */
export async function admit(file: string): Promise<Admitted> {
  const compiled = compile(file, await Deno.readTextFile(file));
  const cage = new Cage(file);
  let declared: { reads: unknown; queries: unknown };
  try {
    declared = await cage.load(compiled);
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
  return { compiled, reads, queries: queries as Record<string, string> };
}

/** The worker running wasm jobs, one at a time, each in a fresh instance.
 * Outputs are in job order. */
export class Runner {
  private worker = new Worker(new URL("./job.ts", import.meta.url), NONE);

  constructor(modules: Record<string, WebAssembly.Module>) {
    this.worker.postMessage({ modules });
  }

  async run(jobs: Job[]): Promise<unknown[]> {
    const outputs: unknown[] = [];
    for (const [index, job] of jobs.entries()) {
      const answer = await reply(this.worker, job);
      if ("error" in answer) throw new Error(`job ${index} (${job.wasm}): ${answer.error}`);
      outputs.push(answer.output);
    }
    return outputs;
  }

  close() {
    this.worker.terminate();
  }
}
