import { compartment } from "./compartment.ts";

type Program = (link: {
  imports: (imports: unknown[]) => void;
  onceVar: Record<string, (value: unknown) => unknown>;
  liveVar: Record<string, (value: unknown) => void>;
}) => unknown;

/** Only descriptors emitted by static-build.ts may cross this boundary. */
export type StaticFactory = {
  create: (
    globals: Record<string, unknown>,
    lexicals: Record<string, unknown>,
  ) => Program;
  fixed: Record<string, readonly string[]>;
  live: Record<string, readonly [string, boolean]>;
};

type Module = {
  reads: unknown;
  queries: unknown;
  queryStages?: unknown;
  plan: (inputs: unknown, seed: number, outputs: unknown) => unknown;
  finish: (inputs: unknown, outputs: unknown) => unknown;
};

const copy = <T>(value: T): T => structuredClone(value);

/** A fresh lexical module instance in the same tamed realm as the worker cage.
 * Its factory is compiled at deployment; loading it never evaluates a string. */
export class StaticCage {
  private module?: Module;
  private inputs?: unknown;
  private seed?: number;
  private closed = false;

  constructor(
    private file: string,
    private factory: StaticFactory,
    private endowments: string[],
  ) {}

  async load(): Promise<{ reads: unknown; queries: unknown; queryStages?: unknown }> {
    if (this.closed || this.module) {
      throw new Error(`computation ${this.file}: cage is closed or loaded`);
    }
    // SES constructs safe globals without creating its evaluator until import
    // or evaluate is called. Start-realm Error retains host stack hooks.
    const globals =
      compartment(this.file, {}, this.endowments, "a computation").globalThis;
    const values: Record<string, unknown> = Object.create(null);
    const onceVar: Record<string, (value: unknown) => unknown> = Object.create(
      null,
    );
    const liveVar: Record<string, (value: unknown) => void> = Object.create(
      null,
    );
    const lexicals: Record<string, unknown> = Object.create(null);
    for (const [local] of Object.values(this.factory.fixed)) {
      onceVar[local] = (value: unknown) => {
        if (Object.hasOwn(values, local)) {
          throw new TypeError(`${this.file}: ${local} initialized twice`);
        }
        values[local] = value;
        return value;
      };
    }
    for (const [local, trap] of Object.values(this.factory.live)) {
      liveVar[local] = (value: unknown) => {
        values[local] = value;
      };
      if (trap && !Object.hasOwn(lexicals, local)) {
        Object.defineProperty(lexicals, local, {
          get() {
            if (!Object.hasOwn(values, local)) {
              throw new ReferenceError(`${local} is uninitialized`);
            }
            return values[local];
          },
          set(value: unknown) {
            if (!Object.hasOwn(values, local)) {
              throw new ReferenceError(`${local} is uninitialized`);
            }
            values[local] = value;
          },
        });
      }
    }
    const imports = (names: unknown[]) => {
      if (names.length) {
        throw new TypeError(`${this.file}: a computation is one file`);
      }
    };
    await this.factory.create(harden(globals), harden(lexicals))(
      harden({ imports, onceVar, liveVar }),
    );
    const namespace: Record<string, unknown> = Object.create(null);
    for (
      const [name, [local]] of Object.entries({
        ...this.factory.fixed,
        ...this.factory.live,
      })
    ) {
      Object.defineProperty(namespace, name, {
        enumerable: true,
        get: () => {
          if (!Object.hasOwn(values, local)) {
            throw new ReferenceError(`${this.file}: ${local} is uninitialized`);
          }
          return values[local];
        },
      });
    }
    if (
      Object.keys(namespace).filter(name => name !== "queryStages").sort().join() !== "finish,plan,queries,reads" ||
      typeof namespace.plan !== "function" ||
      typeof namespace.finish !== "function"
    ) {
      throw new TypeError(`${this.file}: invalid computation exports`);
    }
    this.module = namespace as Module;
    return copy({ reads: this.module.reads, queries: this.module.queries, ...(Object.hasOwn(this.module, "queryStages") ? { queryStages: this.module.queryStages } : {}) });
  }

  async ask(
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.closed || !this.module) {
      throw new Error(`computation ${this.file}: cage is closed or unloaded`);
    }
    const data = copy(message);
    if ("inputs" in data) {
      this.inputs = harden(data.inputs);
      this.seed = data.seed as number;
      return copy({
        jobs: await this.module.plan(this.inputs, this.seed, harden([])),
      });
    }
    if (this.seed === undefined) {
      throw new Error(`${this.file}: plan has no inputs`);
    }
    if (data.plan) {
      return copy({
        jobs: await this.module.plan(
          this.inputs,
          this.seed,
          harden(data.outputs),
        ),
      });
    }
    return copy({
      out: await this.module.finish(this.inputs, harden(data.outputs)),
    });
  }

  async advance(host: Record<string, unknown>, checkpoint: unknown): Promise<unknown> {
    if (this.closed || !this.module) throw new Error(`${this.file}: cage is closed or unloaded`);
    return copy(await this.module.plan(harden(host), 0, harden(copy(checkpoint))));
  }

  close() {
    this.closed = true;
    this.module = undefined;
    this.inputs = undefined;
  }
}
