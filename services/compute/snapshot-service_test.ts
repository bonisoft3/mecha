import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { fields, row, table } from "./portable-fixture.ts";
import { type Snapshot, snapshotStatements } from "./snapshot-data.ts";
import {
  createSnapshotExecutor,
  packageSnapshots,
  snapshotHandler,
  type SnapshotSpec,
  snapshotVersion,
} from "./snapshot-service.ts";

const source = `export const reads = ["source"];
export const queries = { rows: "SELECT * FROM source ORDER BY id" };
export const plan = () => [];
export const finish = (inputs) => ({sink: inputs.rows});`;

async function fixture(program = source) {
  const directory = await Deno.makeTempDir();
  const file = `${directory}/program.js`;
  await Deno.writeTextFile(file, program);
  const spec: SnapshotSpec = {
    name: "snapshot",
    file,
    wasm: [],
    to: ["sink"],
    declaredReads: ["source"],
  };
  return {
    directory,
    spec,
    async [Symbol.asyncDispose]() {
      await Deno.remove(directory, { recursive: true });
    },
  };
}

const snapshot = (version: string, id = "first"): Snapshot => ({
  id: "database-generation",
  name: "snapshot",
  version,
  revision: 1,
  tables: {
    source: { columns: [{ name: "id", type: "text" }], rows: [{ id }] },
  },
});

Deno.test("text snapshot ingestion preserves portable numbers, bytes and microseconds through the cage", async () => {
  await using f = await fixture();
  const spec = {
    ...f.spec,
    types: table,
    queryTypes: { rows: fields },
    sinkTypes: { sink: fields },
  };
  const executor = await createSnapshotExecutor([spec]);
  try {
    const input = snapshot(executor.versions.snapshot);
    input.tables.source = {
      columns: fields.map((field) => ({
        name: field.name,
        type: table.types[field.type].pg,
      })),
      rows: [{
        string_value: row.string_value,
        bool_value: "t",
        int32_value: String(row.int32_value),
        int64_value: row.int64_value,
        double_value: String(row.double_value),
        bytes_value: "\\x00ff8041",
        id: row.id,
        timestamp_value: "2026-09-21 08:00:00.123456-03",
        date_value: row.date_value,
        time_value: row.time_value,
        timezone_value: row.timezone_value,
        duration_value: "3 days 01:02:03.123456",
        decimal_value: row.decimal_value,
        json_value: JSON.stringify(row.json_value),
        geojson_value: JSON.stringify(row.geojson_value),
      }],
    };
    assertEquals(await executor.execute(input), {
      sink: [{ ...row, bytes_value: "\\x00ff8041" }],
    });
    const changed = structuredClone(input);
    changed.tables.source.rows[0].int64_value = "9007199254740993";
    changed.tables.source.rows[0].timestamp_value =
      "2026-09-21 11:00:00.123457+00";
    assertEquals(await executor.execute(changed), {
      sink: [{
        ...row,
        bytes_value: "\\x00ff8041",
        int64_value: "9007199254740993",
        timestamp_value: "2026-09-21T11:00:00.123457Z",
      }],
    });
  } finally {
    await executor.close();
  }
});

Deno.test("unbounded numeric and JSON cells retain digits beyond IEEE-754 without SQL interpolation", async () => {
  await using f = await fixture(
    source.replace(
      "SELECT * FROM source ORDER BY id",
      "SELECT id, amount, CAST(document AS VARCHAR) AS document FROM source",
    ),
  );
  const executor = await createSnapshotExecutor([f.spec]);
  try {
    const input = snapshot(executor.versions.snapshot);
    const expected = {
      id: "x'); DROP TABLE source; --",
      amount: "12345678901234567890123456789012345678901234567890.123456789",
      document: '{"n":9007199254740993}',
    };
    input.tables.source = {
      columns: [{ name: "id", type: "text" }, {
        name: "amount",
        type: "numeric",
      }, { name: "document", type: "jsonb" }],
      rows: [expected],
    };
    assertEquals(await executor.execute(input), { sink: [expected] });
  } finally {
    await executor.close();
  }
});

Deno.test("snapshot execution refuses unknown authority and malformed transport before reading SQL", async () => {
  await using f = await fixture();
  const executor = await createSnapshotExecutor([f.spec]);
  try {
    const input = snapshot(executor.versions.snapshot);
    await assertRejects(
      () => executor.execute({ ...input, name: "unconfigured" }),
      Error,
      "unknown snapshot computation",
    );
    await assertRejects(
      () => executor.execute({ ...input, version: "stale" }),
      Error,
      "artifact version differs",
    );
    await assertRejects(
      () => executor.execute({ ...input, revision: NaN }),
      Error,
      "identity",
    );
    await assertRejects(
      () => executor.execute({ ...input, tables: {} }),
      Error,
      "declared reads",
    );
    await assertRejects(
      () =>
        executor.execute({
          ...input,
          tables: { ...input.tables, injected: input.tables.source },
        }),
      Error,
      "declared reads",
    );
    for (
      const type of [
        "public.unknown",
        "text[]",
        "numeric(39,6)",
        "text); DROP TABLE source;--",
      ]
    ) {
      const altered = structuredClone(input);
      altered.tables.source.columns[0].type = type;
      await assertRejects(
        () => executor.execute(altered),
        Error,
        "unsupported snapshot PostgreSQL type",
      );
    }
    const altered = structuredClone(input);
    altered.tables.source.rows[0].surprise = "extra";
    await assertRejects(
      () => executor.execute(altered),
      Error,
      "row columns differ",
    );
    assertEquals(await executor.execute(input), { sink: [{ id: "first" }] });
  } finally {
    await executor.close();
  }
});

Deno.test("only declared domains enter snapshots and fixed decimals refuse implicit rounding", () => {
  const types = structuredClone(table);
  types.types.int64 = {
    ...types.types.int64,
    column: "domain",
    sql: "portable_int64",
  };
  const input = {
    source: {
      columns: [{ name: "id", type: "public.portable_int64" }],
      rows: [{ id: "9223372036854775807" }],
    },
  };
  assertThrows(
    () => snapshotStatements(input, ["source"]),
    Error,
    "unsupported",
  );
  assertEquals(
    snapshotStatements(input, ["source"], types)[0].create,
    'CREATE TABLE "source" ("id" BIGINT)',
  );
  assertThrows(
    () =>
      snapshotStatements({
        source: {
          columns: [{ name: "id", type: "numeric(8,2)" }],
          rows: [{ id: "1.234" }],
        },
      }, ["source"]),
    Error,
    "scale",
  );
});

Deno.test("a failed query publishes nothing and the serialized executor accepts a later snapshot", async () => {
  await using f = await fixture(
    source.replace(
      "SELECT * FROM source ORDER BY id",
      "SELECT id, CAST(id AS INTEGER) AS n FROM source",
    ),
  );
  const executor = await createSnapshotExecutor([f.spec]);
  try {
    await assertRejects(
      () =>
        executor.execute(snapshot(executor.versions.snapshot, "bad integer")),
      Error,
      "Could not convert",
    );
    assertEquals(
      await executor.execute(snapshot(executor.versions.snapshot, "42")),
      { sink: [{ id: "42", n: 42 }] },
    );
  } finally {
    await executor.close();
  }
});

Deno.test("a finish cannot publish undeclared sinks or a noncanonical typed value", async () => {
  await using f = await fixture(
    source.replace(
      "sink: inputs.rows",
      "sink: inputs.rows.map(row => ({id:row.id, n:9007199254740992}))",
    ),
  );
  const fields = [{ name: "id", type: "string" as const }, {
    name: "n",
    type: "int64" as const,
  }];
  const executor = await createSnapshotExecutor([{
    ...f.spec,
    types: table,
    sinkTypes: { sink: fields },
  }]);
  try {
    await assertRejects(
      () => executor.execute(snapshot(executor.versions.snapshot)),
      Error,
    );
  } finally {
    await assertRejects(() => executor.close(), Error);
  }
  await Deno.writeTextFile(
    f.spec.file,
    source.replace("sink: inputs.rows", "other: inputs.rows"),
  );
  const other = await createSnapshotExecutor([f.spec]);
  try {
    await assertRejects(
      () => other.execute(snapshot(other.versions.snapshot)),
      Error,
      "output sinks differ",
    );
  } finally {
    await assertRejects(() => other.close(), Error);
  }
});

// A WASI command copies one stdin iovec to stdout; its output depends on the actual supplied bytes.
const echo = Uint8Array.from(
  "0061736d01000000010c0260047f7f7f7f017f60000002440216776173695f736e617073686f745f70726576696577310766645f72656164000016776173695f736e617073686f745f70726576696577310866645f77726974650000030201010503010001071302066d656d6f72790200065f737461727400020a33013100410041103602004104418020360200410041004101410810001a41044108280200360200410141004101410c10011a0b"
    .match(/../g)!.map((byte) => parseInt(byte, 16)),
);

Deno.test("concurrent snapshot executions retain WASM reply ownership and HTTP identity", async () => {
  await using f = await fixture(`export const reads = ["source"];
export const queries = { rows: "SELECT * FROM source" };
export const plan = (inputs) => inputs.rows.map(row => ({wasm: "echo", input: row}));
export const finish = (_inputs, outputs) => ({sink: outputs});`);
  const wasm = `${f.directory}/echo.wasm`;
  await Deno.writeFile(wasm, echo);
  const executor = await createSnapshotExecutor([{ ...f.spec, wasm: [wasm] }]);
  try {
    const inputs = Array.from(
      { length: 5 },
      (_, n) => ({
        ...snapshot(executor.versions.snapshot, String(n)),
        revision: n,
      }),
    );
    assertEquals(
      await Promise.all(inputs.map((input) => executor.execute(input))),
      inputs.map((input) => ({ sink: input.tables.source.rows })),
    );
    const input = inputs[2];
    const response = await snapshotHandler(executor)(
      new Request("http://container/execute", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
    assertEquals(await response.json(), {
      id: input.id,
      name: input.name,
      version: input.version,
      revision: input.revision,
      sinks: { sink: [{ id: "2" }] },
    });
  } finally {
    await executor.close();
  }
});

Deno.test("snapshot package identity survives relocation and changes with code, WASM, or authority", async () => {
  await using a = await fixture();
  await using b = await fixture();
  const aWasm = `${a.directory}/echo.wasm`, bWasm = `${b.directory}/echo.wasm`;
  await Deno.writeFile(aWasm, echo);
  await Deno.writeFile(bWasm, echo);
  const spec = { ...a.spec, wasm: [aWasm] };
  const version = await snapshotVersion(spec);
  assertEquals(await snapshotVersion({ ...b.spec, wasm: [bWasm] }), version);
  assertNotEquals(await snapshotVersion({ ...spec, to: ["other"] }), version);
  assertNotEquals(
    await snapshotVersion({ ...spec, sinkWrites: { sink: "upsert" } }),
    version,
  );
  await Deno.writeFile(bWasm, new Uint8Array([...echo, 0, 1, 0]));
  assertNotEquals(await snapshotVersion({ ...b.spec, wasm: [bWasm] }), version);
  await Deno.writeTextFile(b.spec.file, source + "\n");
  assertNotEquals(await snapshotVersion(b.spec), await snapshotVersion(a.spec));
  const packaged = JSON.parse(JSON.stringify(await packageSnapshots([spec])));
  assertEquals(packaged[0].version, version);
  assertEquals(packaged[0].reads, ["source"]);
  await assertRejects(
    () => createSnapshotExecutor([{ ...spec, version: "wrong" }]),
    Error,
    "artifact version differs",
  );
});
