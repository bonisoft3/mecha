export type DeltaRow = Record<string, unknown>;
export type WeightedRow = { row: DeltaRow; weight: number };
export type DeltaStep = Record<string, readonly WeightedRow[]>;
export type PartitionFields = Record<string, string | null>;
export type DeltaChanges = {
  keys: readonly string[];
  records: number;
  changedRows: number;
};
export type PartitionInputs = Readonly<Record<string, readonly DeltaRow[]>>;

export const GLOBAL_PARTITION = "";

type Entry = { row: DeltaRow; count: number };
type Relation = Map<string, Map<string, Entry>>;
type Pending = { row: DeltaRow; weight: bigint };
const plain = (value: unknown): value is DeltaRow =>
  value !== null && typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype;

function canonical(value: unknown, ancestors = new Set<object>()): unknown {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Object.is(value, -0) ? 0 : value;
  }
  if (!Array.isArray(value) && !plain(value)) {
    throw new Error("delta rows require finite JSON values");
  }
  if (ancestors.has(value)) {
    throw new Error("delta rows require acyclic JSON values");
  }
  ancestors.add(value);
  let copy: unknown;
  if (Array.isArray(value)) {
    copy = Array.from(value, (item) => canonical(item, ancestors));
  } else {
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
      throw new Error("delta rows require enumerable string fields");
    }
    copy = Object.fromEntries(
      Object.keys(value).sort().map((
        name,
      ) => [name, canonical(value[name], ancestors)]),
    );
  }
  ancestors.delete(value);
  return Object.freeze(copy);
}

/** Caller assembles every connector chunk into a complete step before apply. */
export class DeltaStore {
  private readonly fields: PartitionFields;
  private readonly relations = new Map<string, Relation>();
  private readonly global: boolean;
  private started = false;

  constructor(partitions: PartitionFields) {
    if (!plain(partitions) || Object.keys(partitions).length === 0) {
      throw new Error("delta store requires relations");
    }
    const fields = Object.values(partitions);
    if (
      fields.some((field) =>
        field !== null && (typeof field !== "string" || field.length === 0)
      )
    ) {
      throw new Error("partition fields must be nonempty strings or null");
    }
    this.global = fields.every((field) => field === null);
    if (!this.global && fields.some((field) => field === null)) {
      throw new Error(
        "global and partitioned relations require an explicit dependency mapping",
      );
    }
    this.fields = Object.freeze({ ...partitions });
    for (const name of Object.keys(partitions)) {
      this.relations.set(name, new Map());
    }
  }

  bootstrap(input: Record<string, readonly DeltaRow[]>): DeltaChanges {
    if (this.started) throw new Error("delta store already started");
    if (
      !plain(input) ||
      JSON.stringify(Object.keys(input).sort()) !==
        JSON.stringify(Object.keys(this.fields).sort())
    ) {
      throw new Error("bootstrap must contain every declared relation");
    }
    const step = Object.fromEntries(
      Object.entries(input).map(([name, values]) => {
        if (!Array.isArray(values)) {
          throw new Error("bootstrap relations must be arrays");
        }
        return [name, values.map((row) => ({ row, weight: 1 }))];
      }),
    );
    const changes = this.apply(step);
    return this.global && changes.keys.length === 0
      ? { ...changes, keys: Object.freeze([GLOBAL_PARTITION]) }
      : changes;
  }

  apply(step: DeltaStep): DeltaChanges {
    if (!plain(step)) throw new Error("delta step must name its relations");
    const pending = new Map<string, Map<string, Map<string, Pending>>>();
    let records = 0;
    for (const [name, changes] of Object.entries(step)) {
      if (!this.relations.has(name)) {
        throw new Error(`unknown delta relation ${name}`);
      }
      if (!Array.isArray(changes)) {
        throw new Error("relation deltas must be arrays");
      }
      const partitions = new Map<string, Map<string, Pending>>();
      pending.set(name, partitions);
      for (const change of changes) {
        if (
          !plain(change) || !plain(change.row) ||
          typeof change.weight !== "number" ||
          !Number.isSafeInteger(change.weight) || change.weight === 0
        ) {
          throw new Error(
            "delta requires a row and a nonzero safe integer weight",
          );
        }
        records++;
        const row = canonical(change.row) as DeltaRow;
        const field = this.fields[name];
        const key = field === null ? GLOBAL_PARTITION : row[field];
        if (typeof key !== "string") {
          throw new Error(`${name}.${field} must be a string partition key`);
        }
        let rows = partitions.get(key);
        if (!rows) partitions.set(key, rows = new Map());
        const identity = JSON.stringify(row);
        const prior = rows.get(identity);
        rows.set(identity, {
          row,
          weight: (prior?.weight ?? 0n) + BigInt(change.weight),
        });
      }
    }

    const updates: {
      name: string;
      key: string;
      identity: string;
      row: DeltaRow;
      count: number;
    }[] = [];
    const affected = new Set<string>();
    for (const [name, partitions] of pending) {
      const relation = this.relations.get(name)!;
      for (const [key, rows] of partitions) {
        const current = relation.get(key);
        for (const [identity, change] of rows) {
          if (change.weight === 0n) continue;
          const count = BigInt(current?.get(identity)?.count ?? 0) +
            change.weight;
          if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error(`invalid resulting multiplicity in ${name}`);
          }
          updates.push({
            name,
            key,
            identity,
            row: change.row,
            count: Number(count),
          });
          affected.add(key);
        }
      }
    }

    for (const { name, key, identity, row, count } of updates) {
      const relation = this.relations.get(name)!;
      let partition = relation.get(key);
      if (count === 0) {
        partition!.delete(identity);
        if (partition!.size === 0) relation.delete(key);
      } else {
        if (!partition) relation.set(key, partition = new Map());
        partition.set(identity, { row, count });
      }
    }
    this.started = true;
    return {
      keys: Object.freeze([...affected].sort()),
      records,
      changedRows: updates.length,
    };
  }

  capture(key: string): PartitionInputs {
    if (typeof key !== "string" || this.global && key !== GLOBAL_PARTITION) {
      throw new Error("invalid computation partition");
    }
    const result = Object.fromEntries(
      [...this.relations].map(([name, relation]) => {
        const rows: DeltaRow[] = [];
        const entries = [...(relation.get(key)?.entries() ?? [])].sort((
          [a],
          [b],
        ) => a < b ? -1 : a > b ? 1 : 0);
        for (const [, entry] of entries) {
          if (rows.length + entry.count > 0xffffffff) {
            throw new Error("partition exceeds JavaScript array capacity");
          }
          for (let i = 0; i < entry.count; i++) rows.push(entry.row);
        }
        return [name, Object.freeze(rows)];
      }),
    );
    return Object.freeze(result);
  }
}
