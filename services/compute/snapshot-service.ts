import {
  Computation,
  duckdb,
  type Out,
  readerOf,
  type Spec,
  stem,
} from "./main.ts";
import { postgresRows, validateSchemas } from "./portable.ts";
import { validateSinkWrites } from "../../packages/compute-snapshot/src/sink-writes.ts";
import { admit, Runner, strictJson } from "./workers.ts";
import {
  type Snapshot,
  snapshotStatements,
  validateSnapshot,
} from "./snapshot-data.ts";

export type SnapshotSpec = Spec & { version?: string };

const hash = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");

const hosts = [
  "snapshot-service.ts",
  "snapshot-data.ts",
  "query-stages.ts",
  "main.ts",
  "portable.ts",
  "portable-contract.ts",
  "workers.ts",
  "cage.ts",
  "realm.ts",
  "compartment.ts",
  "language.ts",
  "endowments.ts",
  "crypto.ts",
  "job.ts",
  "wasi.ts",
  "deno.json",
  "deno.lock",
  "../../packages/client/src/types.ts",
  "../../packages/lake/src/lake-types.ts",
  "../../packages/compute-snapshot/src/sink-writes.ts",
];

/** Paths are deployment details; program bytes, declared authority and pinned host code are the contract. */
export async function snapshotVersion(spec: SnapshotSpec): Promise<string> {
  const { file, wasm, feldera, steps: _steps, version: _version, ...contract } = spec;
  const files = await Promise.all(
    [file, ...wasm, ...(feldera ? [feldera] : [])].map(async (path) =>
      await hash(await Deno.readFile(path))
    ),
  );
  const runtime = await Promise.all(
    hosts.map(async (
      path,
    ) => [
      path,
      await hash(await Deno.readFile(new URL(path, import.meta.url))),
    ]),
  );
  return await hash(new TextEncoder().encode(strictJson({
    protocol: 1,
    contract,
    files,
    wasm: wasm.map(stem),
    runtime,
  }, true)));
}

export async function packageSnapshots(specs: SnapshotSpec[]) {
  const names = new Set<string>();
  return await Promise.all(specs.map(async (spec) => {
    if (!spec.name || names.has(spec.name)) {
      throw new Error(`duplicate or empty computation name: ${spec.name}`);
    }
    names.add(spec.name);
    const version = await snapshotVersion(spec);
    if (spec.version !== undefined && spec.version !== version) {
      throw new Error(`computation ${spec.name}: artifact version differs`);
    }
    const { compiled, reads, queries, queryStages } = await admit(
      spec.file,
      spec.endowments ?? [],
    );
    if (new Set(reads).size !== reads.length) {
      throw new Error(`computation ${spec.name}: duplicate reads`);
    }
    if (
      spec.declaredReads &&
      JSON.stringify([...new Set(spec.declaredReads)].sort()) !==
        JSON.stringify([...reads].sort())
    ) {
      throw new Error(
        `computation ${spec.name}: module reads differ from declared sources`,
      );
    }
    if (new Set(spec.to).size !== spec.to.length) {
      throw new Error(`computation ${spec.name}: duplicate sinks`);
    }
    validateSchemas(spec.types, spec.queryTypes, Object.keys(queries));
    validateSchemas(spec.types, spec.sinkTypes, spec.to, true);
    validateSinkWrites(spec.to, spec.sinkWrites);
    return { compiled, reads, queries, ...(queryStages ? { queryStages } : {}), version, spec: { ...spec, version } };
  }));
}

function sinks(spec: Spec, value: unknown): Out {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...spec.to].sort())
  ) {
    throw new Error(`computation ${spec.name}: output sinks differ`);
  }
  const result: Out = {};
  for (const name of spec.to) {
    const rows = (value as Out)[name];
    if (
      !Array.isArray(rows) ||
      !rows.every((row) =>
        row !== null && typeof row === "object" && !Array.isArray(row)
      )
    ) {
      throw new Error(`computation ${spec.name}: invalid rows for ${name}`);
    }
    const fields = spec.sinkTypes?.[name];
    const normalized = fields
      ? postgresRows({ fields, types: spec.types! }, rows)
      : rows;
    const ids = new Set<string>();
    const columns = normalized.length
      ? Object.keys(normalized[0]).sort().join()
      : "";
    for (const row of normalized) {
      if (typeof row.id !== "string" || ids.has(row.id)) {
        throw new Error(
          `computation ${spec.name}: duplicate or invalid sink id in ${name}`,
        );
      }
      ids.add(row.id);
      if (Object.keys(row).sort().join() !== columns) {
        throw new Error(
          `computation ${spec.name}: sink row columns differ in ${name}`,
        );
      }
    }
    result[name] = normalized;
  }
  strictJson(result);
  return result;
}

export interface SnapshotExecutor {
  versions: Record<string, string>;
  execute(snapshot: Snapshot): Promise<Out>;
  close(): Promise<void>;
}

export async function createSnapshotExecutor(
  specs: SnapshotSpec[],
): Promise<SnapshotExecutor> {
  const packaged = await packageSnapshots(specs);
  const files = [...new Set(specs.flatMap((spec) => spec.wasm))];
  if (new Set(files.map(stem)).size !== files.length) {
    throw new Error("snapshot WASM module names collide");
  }
  const modules = Object.fromEntries(
    await Promise.all(
      files.map(async (
        file,
      ) => [stem(file), await WebAssembly.compile(await Deno.readFile(file))]),
    ),
  );
  const runner = new Runner(modules);
  const computations = new Map<
    string,
    { computation: Computation; spec: SnapshotSpec; version: string }
  >();
  try {
    for (const { spec, version } of packaged) {
      computations.set(spec.name, {
        computation: await Computation.load(spec, runner),
        spec,
        version,
      });
    }
  } catch (error) {
    runner.close();
    throw error;
  }
  let closed = false;
  let pending: Promise<unknown> = Promise.resolve();
  const execute = async (snapshot: Snapshot): Promise<Out> => {
    if (closed) throw new Error("snapshot executor is closed");
    validateSnapshot(snapshot);
    const configured = computations.get(snapshot.name);
    if (!configured) {
      throw new Error(`unknown snapshot computation: ${snapshot.name}`);
    }
    if (snapshot.version !== configured.version) {
      throw new Error(`snapshot artifact version differs for ${snapshot.name}`);
    }
    const statements = snapshotStatements(
      snapshot.tables,
      configured.computation.reads,
      configured.spec.types,
    );
    const run = async () => {
      const db = await duckdb();
      try {
        const con = await db.connect();
        try {
          await con.run(
            "SET threads = 1; SET memory_limit = '512MiB'; SET enable_external_access = false",
          );
          for (const statement of statements) {
            await con.run(statement.create);
            await con.run(statement.insert, statement.values);
          }
          return sinks(
            configured.spec,
            await configured.computation.run(readerOf(con)),
          );
        } finally {
          con.closeSync();
        }
      } finally {
        db.closeSync();
      }
    };
    // A Runner owns one message callback; concurrent computations must never share it in flight.
    const result = pending.then(run, run);
    pending = result;
    return await result;
  };
  return {
    versions: Object.fromEntries(
      packaged.map(({ spec, version }) => [spec.name, version]),
    ),
    execute,
    async close() {
      closed = true;
      try {
        await pending;
      } finally {
        runner.close();
      }
    },
  };
}

export function snapshotHandler(executor: SnapshotExecutor) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      return Response.json({ ready: true, versions: executor.versions });
    }
    if (path !== "/execute") return new Response("Not found", { status: 404 });
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const snapshot: Snapshot = await request.json();
    const out = await executor.execute(snapshot);
    return Response.json({
      id: snapshot.id,
      name: snapshot.name,
      version: snapshot.version,
      revision: snapshot.revision,
      sinks: out,
    });
  };
}

if (import.meta.main) {
  const configured = Deno.env.get("COMPUTATIONS");
  if (!configured) throw new Error("COMPUTATIONS is required");
  const specs: SnapshotSpec[] = JSON.parse(configured);
  if (!Array.isArray(specs)) throw new Error("COMPUTATIONS must be an array");
  if (Deno.args.includes("--package")) {
    console.log(JSON.stringify(await packageSnapshots(specs)));
  } else {
    const executor = await createSnapshotExecutor(specs);
    const port = Number(Deno.env.get("PORT") ?? "8080");
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error("invalid PORT");
    }
    const server = Deno.serve(
      { hostname: "0.0.0.0", port },
      snapshotHandler(executor),
    );
    await server.finished;
    await executor.close();
  }
}
