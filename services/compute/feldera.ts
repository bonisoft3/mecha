import type { Reader, Row } from "./main.ts";

export type FelderaField = { name: string; type: string };
export type FelderaProgram = {
  sql: string;
  inputs: Record<string, { query: string; fields: FelderaField[] }>;
  outputs: Record<string, { view: string; fields: FelderaField[] }>;
};

type Relation = {
  name: string;
  materialized: boolean;
  fields: { name: string; columntype: { type: string; precision?: number } }[];
};
type State = {
  platform_version: string;
  program_code: string;
  program_status: string;
  deployment_status: string;
  deployment_id: string;
  deployment_error: unknown;
  program_info: {
    input_connectors: Record<string, unknown>;
    output_connectors: Record<string, unknown>;
    schema: { inputs: Relation[]; outputs: Relation[] };
  };
};
type Stats = {
  global_metrics: {
    incarnation_uuid: string;
    runtime_version: string;
    total_input_records: number;
    total_completed_records: number;
  };
  inputs: {
    fatal_error: unknown;
    metrics: { num_parse_errors: number; num_transport_errors: number };
  }[];
  outputs: unknown[];
};

const identifier = /^[a-z_][a-z0-9_]*$/;
const types = new Set([
  "BOOLEAN",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "DOUBLE",
  "VARCHAR",
  "TIMESTAMP",
]);
const version = /^0\.367\.0(?:\+|$)/;
const delay = () => new Promise((resolve) => setTimeout(resolve, 50));
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Feldera: ${message}`);
}

function fields(fields: FelderaField[]) {
  require(
    Array.isArray(fields) && fields.length > 0,
    "fields must be a nonempty array",
  );
  const names = new Set<string>();
  for (const field of fields) {
    require(
      object(field) && identifier.test(field.name) && !names.has(field.name),
      "invalid or duplicate field",
    );
    require(types.has(field.type), `unsupported type ${field.type}`);
    names.add(field.name);
  }
}

function timestamp(value: unknown): string {
  require(typeof value === "string", "timestamp must be text");
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z?$/
    .exec(value);
  require(
    match && match[1].slice(0, 4) !== "0000",
    `invalid UTC microsecond timestamp ${value}`,
  );
  const prefix = `${match[1]}T${match[2]}`;
  const date = new Date(`${prefix}Z`);
  require(
    Number.isFinite(date.valueOf()) &&
      date.toISOString().slice(0, 19) === prefix,
    `invalid timestamp ${value}`,
  );
  return `${prefix}.${(match[3] ?? "").padEnd(6, "0")}Z`;
}

export function rows(values: unknown, schema: FelderaField[]): Row[] {
  require(Array.isArray(values), "query did not return rows");
  return values.map((row) => {
    require(
      object(row) && Object.keys(row).length === schema.length,
      "row fields differ from descriptor",
    );
    return Object.fromEntries(schema.map(({ name, type }) => {
      require(Object.hasOwn(row, name), `row lacks ${name}`);
      const value = row[name];
      if (value === null) return [name, null];
      switch (type) {
        case "VARCHAR":
          require(typeof value === "string", `${name} must be a string`);
          break;
        case "BOOLEAN":
          require(typeof value === "boolean", `${name} must be a boolean`);
          break;
        case "TIMESTAMP":
          return [name, timestamp(value)];
        case "DOUBLE":
          require(
            typeof value === "number" && Number.isFinite(value),
            `${name} must be finite`,
          );
          break;
        default:
          require(
            typeof value === "number" && Number.isSafeInteger(value),
            `${name} must be an exact safe integer`,
          );
          if (type === "SMALLINT") {
            require(
              value >= -32768 && value <= 32767,
              `${name} exceeds SMALLINT`,
            );
          }
          if (type === "INTEGER") {
            require(
              value >= -2147483648 && value <= 2147483647,
              `${name} exceeds INTEGER`,
            );
          }
      }
      return [name, value];
    }));
  });
}

type Bag = Map<string, { row: Row; count: number }>;
function bag(rows: Row[]): Bag {
  const result: Bag = new Map();
  for (const row of rows) {
    const key = JSON.stringify(row);
    const previous = result.get(key);
    if (previous) previous.count++;
    else result.set(key, { row, count: 1 });
  }
  return result;
}

/** One coordinator owns this connector-free pipeline and supplies complete source snapshots. */
export class Feldera {
  private readonly path: string;
  private readonly program: FelderaProgram;
  private previous: Record<string, Bag> = {};
  private incarnation?: string;
  private deployment?: string;
  private records = 0;
  private token?: string;
  private poisoned = false;
  private capturing = false;

  constructor(endpoint: string, pipelineName: string, program: FelderaProgram) {
    require(
      /^[a-z][a-z0-9_-]{0,99}$/.test(pipelineName),
      "invalid pipeline name",
    );
    const url = new URL(endpoint);
    require(
      ["http:", "https:"].includes(url.protocol) && !url.search && !url.hash,
      "invalid endpoint",
    );
    this.path = `${endpoint.replace(/\/$/, "")}/v0/pipelines/${pipelineName}`;
    require(
      object(program) && typeof program.sql === "string" &&
        program.sql.length > 0,
      "missing SQL program",
    );
    require(
      object(program.inputs) && Object.keys(program.inputs).length > 0,
      "missing inputs",
    );
    require(
      object(program.outputs) && Object.keys(program.outputs).length > 0,
      "missing outputs",
    );
    for (const [name, input] of Object.entries(program.inputs)) {
      require(
        identifier.test(name) && object(input) &&
          typeof input.query === "string" && input.query.length > 0,
        "invalid input",
      );
      fields(input.fields);
    }
    for (const [name, output] of Object.entries(program.outputs)) {
      require(
        identifier.test(name) && object(output) && identifier.test(output.view),
        "invalid output",
      );
      fields(output.fields);
    }
    this.program = structuredClone(program);
  }

  private async request(
    path: string,
    method = "GET",
    body?: unknown,
    missing = false,
  ): Promise<Response> {
    const response = await fetch(this.path + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (missing && response.status === 404) return response;
    if (!response.ok) {
      throw new Error(
        `Feldera: ${method} ${path}: ${response.status}: ${await response
          .text()}`,
      );
    }
    return response;
  }

  private async json<T = unknown>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    return await (await this.request(path, method, body)).json();
  }

  private async status(wanted: string): Promise<State> {
    const deadline = Date.now() + 600000;
    do {
      const state = await this.json<State>("");
      require(
        !state.deployment_error &&
          !["SqlError", "RustError", "SystemError"].includes(
            state.program_status,
          ),
        JSON.stringify(state),
      );
      if (
        wanted === "Compiled"
          ? state.program_status === "Success"
          : state.deployment_status === wanted
      ) return state;
      await delay();
    } while (Date.now() < deadline);
    throw new Error(`Feldera: ${wanted} timed out`);
  }

  private schema(state: State) {
    require(
      version.test(state.platform_version),
      "manager version must be 0.367.0",
    );
    require(state.program_code === this.program.sql, "pipeline SQL changed");
    const info = state.program_info;
    require(
      object(info) && object(info.input_connectors) &&
        object(info.output_connectors),
      "missing connector metadata",
    );
    require(
      Object.keys(info.input_connectors).length === 0 &&
        Object.keys(info.output_connectors).length === 0,
      "connectors are forbidden",
    );
    require(
      Array.isArray(info.schema?.inputs) && Array.isArray(info.schema?.outputs),
      "missing compiled schema",
    );
    require(
      info.schema.inputs.length === Object.keys(this.program.inputs).length,
      "input tables differ from descriptor",
    );
    const check = (
      relations: Relation[],
      name: string,
      expected: FelderaField[],
      materialized: boolean,
    ) => {
      const relation = relations.find((r) => r.name === name);
      require(
        relation && (!materialized || relation.materialized === true),
        `missing materialized relation ${name}`,
      );
      require(
        Array.isArray(relation.fields) &&
          relation.fields.length === expected.length,
        `${name} schema differs`,
      );
      for (let i = 0; i < expected.length; i++) {
        const actual = relation.fields[i];
        const field = expected[i];
        require(
          actual.name === field.name && actual.columntype?.type === field.type,
          `${name}.${field.name} type differs`,
        );
        if (field.type === "TIMESTAMP") {
          require(
            actual.columntype.precision === 6,
            "timestamp precision must be six",
          );
        }
        if (field.type === "VARCHAR") {
          const precision = actual.columntype.precision;
          require(
            precision === -1 ||
              materialized && Number.isSafeInteger(precision) &&
                precision! >= 0,
            "bounded input VARCHAR is unsupported",
          );
        }
      }
    };
    for (const [name, input] of Object.entries(this.program.inputs)) {
      check(info.schema.inputs, name, input.fields, false);
    }
    for (const output of Object.values(this.program.outputs)) {
      check(info.schema.outputs, output.view, output.fields, true);
    }
  }

  private async initialize() {
    const existing = await this.request("", "GET", undefined, true);
    if (existing.status !== 404) {
      await existing.text();
      await this.json("/stop?force=true", "POST");
      await this.status("Stopped");
    } else await existing.text();
    await this.json("", "PUT", {
      name: this.path.split("/").at(-1),
      program_code: this.program.sql,
      udf_rust: "",
      udf_toml: "",
      runtime_config: { workers: 1, storage: null },
      program_config: { profile: "optimized" },
    });
    this.schema(await this.status("Compiled"));
    await this.json("/start", "POST");
    const state = await this.status("Running");
    this.schema(state);
    require(
      typeof state.deployment_id === "string",
      "missing deployment identity",
    );
    this.deployment = state.deployment_id;
    const stats = await this.json<Stats>("/stats");
    require(
      typeof stats.global_metrics?.incarnation_uuid === "string",
      "missing runtime incarnation",
    );
    this.incarnation = stats.global_metrics.incarnation_uuid;
    await this.check();
  }

  private async complete(token: string) {
    const deadline = Date.now() + 30000;
    do {
      const result = await this.json<{ status: string }>(
        `/completion_status?token=${encodeURIComponent(token)}`,
      );
      require(
        result.status === "complete" || result.status === "inprogress",
        "invalid completion status",
      );
      if (result.status === "complete") return;
      await delay();
    } while (Date.now() < deadline);
    throw new Error("Feldera: ingress completion timed out");
  }

  private async check() {
    const state = await this.json<State>("");
    require(
      state.deployment_status === "Running" &&
        state.deployment_id === this.deployment,
      "pipeline restarted or stopped",
    );
    this.schema(state);
    const stats = await this.json<Stats>("/stats");
    const global = stats.global_metrics;
    require(
      global?.incarnation_uuid === this.incarnation,
      "runtime incarnation changed",
    );
    require(
      version.test(global.runtime_version),
      "runtime version must be 0.367.0",
    );
    require(
      global.total_input_records === this.records &&
        global.total_completed_records === this.records,
      "unexpected writer or incomplete input",
    );
    require(
      Array.isArray(stats.inputs) && Array.isArray(stats.outputs) &&
        stats.outputs.length === 0,
      "unexpected connectors",
    );
    for (const input of stats.inputs) {
      require(
        !input.fatal_error && input.metrics?.num_parse_errors === 0 &&
          input.metrics.num_transport_errors === 0,
        "ingress failed",
      );
    }
    if (this.token) await this.complete(this.token);
  }

  async capture(reader: Reader): Promise<Record<string, Row[]>> {
    require(!this.poisoned, "adapter poisoned; restart the compute service");
    if (this.capturing) {
      this.poisoned = true;
      throw new Error(
        "Feldera: concurrent capture; restart the compute service",
      );
    }
    this.capturing = true;
    try {
      const next: Record<string, Bag> = {};
      for (const [name, input] of Object.entries(this.program.inputs)) {
        next[name] = bag(rows(await reader.query(input.query), input.fields));
      }
      require(!this.poisoned, "concurrent capture poisoned adapter");
      if (!this.incarnation) await this.initialize();
      else await this.check();
      for (const [name, current] of Object.entries(next)) {
        const previous = this.previous[name] ?? new Map();
        const updates: ({ insert: Row } | { delete: Row })[] = [];
        for (const [key, { row, count }] of previous) {
          for (let i = current.get(key)?.count ?? 0; i < count; i++) {
            updates.push({ delete: row });
          }
        }
        for (const [key, { row, count }] of current) {
          for (let i = previous.get(key)?.count ?? 0; i < count; i++) {
            updates.push({ insert: row });
          }
        }
        // Empty ingress also establishes an incarnation-bound completion token for an empty baseline.
        const result = await this.json<{ token: string }>(
          `/ingress/${name}?format=json&array=true`,
          "POST",
          updates,
        );
        require(
          typeof result.token === "string" && result.token.length > 0,
          "ingress returned no completion token",
        );
        this.token = result.token;
        this.records += updates.length;
        await this.complete(result.token);
      }
      await this.check();
      const result: Record<string, Row[]> = {};
      for (const [name, output] of Object.entries(this.program.outputs)) {
        const query = new URLSearchParams({
          sql: `SELECT * FROM "${output.view}"`,
          format: "json",
        });
        const text = await (await this.request(`/query?${query}`)).text();
        result[name] = rows(
          text.trim()
            ? text.trim().split("\n").map((line) => JSON.parse(line))
            : [],
          output.fields,
        );
      }
      await this.check();
      require(!this.poisoned, "concurrent capture poisoned adapter");
      this.previous = next;
      return result;
    } catch (error) {
      // An uncertain request may already have changed DBSP state; the only recovery is a fresh baseline.
      this.poisoned = true;
      throw error;
    } finally {
      this.capturing = false;
    }
  }
}
