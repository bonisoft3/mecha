import { compile, strictJson } from "./workers.ts";
import { endowable } from "./language.ts";

export type StepQuery = { path: string[]; sql: string; orderBy: string };
export type StepHost = {
  query(sql: string): Promise<Record<string, unknown>[]>;
  wasm(name: string, input: unknown): Promise<unknown>;
  wasmFromQuery(
    name: string,
    input: unknown,
    query: StepQuery,
  ): Promise<unknown>;
  seed: number;
};
export type StepResult = {
  checkpoint: unknown;
  writes: Record<string, Record<string, unknown>[]>;
  statements?: string[];
  done: boolean;
};

const LIMIT = 8 * 1024 * 1024;
const REPLY_LIMIT = 16 * 1024 * 1024;
function encode(value: unknown, limit = LIMIT): string {
  const json = strictJson(value);
  if (new TextEncoder().encode(json).byteLength > limit) {
    throw new RangeError(`step message exceeds ${limit / (1024 * 1024)} MiB`);
  }
  return json;
}

/** App source crosses as a compiled module; host capabilities cross as RPC names. */
export class StepCage {
  private worker: Worker;
  private closed = false;
  private active?: {
    host: StepHost;
    resolve: (result: StepResult) => void;
    reject: (error: Error) => void;
  };

  constructor(
    private options: { file: string; source: string; endowments: string[] },
  ) {
    const source = compile(options.file, options.source);
    const endowments = endowable(options.endowments, options.file);
    this.worker = new Worker(new URL("./step-worker.ts", import.meta.url), {
      type: "module",
      deno: { permissions: "none" },
    });
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new Error(event.message));
    };
    this.worker.onmessageerror = () =>
      this.fail(new Error("step worker message could not be decoded"));
    this.worker.onmessage = (event) => {
      this.receive(event.data).catch((error) =>
        this.fail(error instanceof Error ? error : new Error(String(error)))
      );
    };
    this.worker.postMessage({
      kind: "load",
      source,
      file: options.file,
      endowments,
    });
  }

  advance(host: StepHost, checkpoint: unknown): Promise<StepResult> {
    if (this.closed) return Promise.reject(new Error("step cage is closed"));
    if (this.active) {
      return Promise.reject(new Error("step cage already has an active step"));
    }
    return new Promise((resolve, reject) => {
      const json = encode({ seed: host.seed, checkpoint });
      this.active = { host, resolve, reject };
      this.worker.postMessage({ kind: "advance", json });
    });
  }

  private async receive(
    message: { kind: string; id?: number; json?: string; error?: string },
  ) {
    if (this.closed) return;
    if (message.kind === "error") throw new Error(message.error);
    const active = this.active;
    if (!active) throw new Error("step worker replied without an active step");
    if (
      typeof message.json !== "string" ||
      new TextEncoder().encode(message.json).byteLength > LIMIT
    ) {
      throw new RangeError("invalid or oversized step worker message");
    }
    const data = JSON.parse(message.json);
    if (message.kind === "result") {
      this.active = undefined;
      active.resolve(data);
      return;
    }
    if (message.kind !== "call" || !Number.isSafeInteger(message.id)) {
      throw new Error("unknown step worker message");
    }
    try {
      const { method, args } = data;
      if (!Array.isArray(args)) {
        throw new TypeError("invalid step host arguments");
      }
      let result: unknown;
      switch (method) {
        case "query":
          if (args.length !== 1 || typeof args[0] !== "string") {
            throw new TypeError("invalid query arguments");
          }
          result = await active.host.query(args[0]);
          break;
        case "wasm":
          if (args.length !== 2 || typeof args[0] !== "string") {
            throw new TypeError("invalid wasm arguments");
          }
          result = await active.host.wasm(args[0], args[1]);
          break;
        case "wasmFromQuery":
          if (
            args.length !== 3 || typeof args[0] !== "string" ||
            !args[2] || typeof args[2].sql !== "string" ||
            typeof args[2].orderBy !== "string" ||
            !Array.isArray(args[2].path) ||
            !args[2].path.every((part: unknown) => typeof part === "string")
          ) {
            throw new TypeError("invalid wasmFromQuery arguments");
          }
          result = await active.host.wasmFromQuery(args[0], args[1], args[2]);
          break;
        default:
          throw new TypeError(`unknown step host method ${method}`);
      }
      const json = encode(result, method === "query" ? LIMIT : REPLY_LIMIT);
      if (!this.closed) {
        this.worker.postMessage({ kind: "reply", id: message.id, json });
      }
    } catch (error) {
      if (!this.closed) {
        this.worker.postMessage({
          kind: "reply",
          id: message.id,
          error: String(error),
        });
      }
    }
  }

  private fail(error: Error) {
    this.active?.reject(
      new Error(`computation ${this.options.file}: ${error.message}`, {
        cause: error,
      }),
    );
    this.active = undefined;
    this.closed = true;
    this.worker.terminate();
  }

  close() {
    if (!this.closed) this.fail(new Error("step cage is closed"));
  }

  [Symbol.dispose]() {
    this.close();
  }
}
