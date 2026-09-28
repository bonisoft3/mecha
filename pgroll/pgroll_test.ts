// What a cluster accepts as a pgroll migration, against the pgroll that runs it.
//
//   deno test --allow-read --allow-write --allow-run=cue pgroll/pgroll_test.ts

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: on Windows that yields "/C:/…", which is
// not a path anything can open.
const path = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// pgroll.cue is imported from the schema.json a pgroll release ships, and
// nothing about the import records which release. A pin bumped without a
// regrab leaves clusters given migrations against operations the tool no longer
// has — and CUE would accept them, so the first sign would be a migration that
// vets here and is refused at the database.
Deno.test("the grammar was taken from the pgroll that is pinned", async () => {
  const grammar = /#PgRollGrammar:\s*"([^"]+)"/.exec(await Deno.readTextFile(path("./pgroll.cue")));
  const pinned = /"ghcr\.io\/xataio\/pgroll:v([^"@]+)@sha256:[0-9a-f]{64}"/.exec(await Deno.readTextFile(path("../bayt.cue")));
  assert.notEqual(grammar, null, "pgroll.cue declares no #PgRollGrammar");
  assert.notEqual(pinned, null, "bayt.cue pins no pgroll image by digest");
  assert.equal(grammar![1], pinned![1]);
});

/** `cue vet` of a set of migrations against the cluster's own field. */
async function vet(migrations: Record<string, unknown>) {
  const dir = await Deno.makeTempDir({ prefix: "mecha-pgroll-" });
  try {
    const data = `${dir}/pgroll.json`;
    await Deno.writeTextFile(data, JSON.stringify(migrations));
    const out = await new Deno.Command("cue", {
      args: ["vet", "-c", ".:cluster", data, "-d", "#Cluster.state.pgroll"],
      cwd: path(".."),
      stdout: "piped",
      stderr: "piped",
    }).output();
    return { ok: out.success, stderr: new TextDecoder().decode(out.stderr) };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const addColumn = { add_column: { table: "t", column: { name: "c", type: "text", nullable: true } } };

// The refusals below are only refusals if this passes: a field that rejected
// everything would satisfy them too.
Deno.test("a migration pgroll has an operation for vets", async () => {
  const got = await vet({ "01_add_c": { operations: [addColumn] } });
  assert.equal(got.ok, true, got.stderr);
});

Deno.test("a migration naming an operation pgroll does not have fails to vet", async () => {
  const got = await vet({ "01_add_c": { operations: [{ add_colum: addColumn.add_column }] } });
  assert.equal(got.ok, false);
  assert.match(got.stderr, /01_add_c"?\.operations\.0/);
});

// pgroll 0.16.3's schema.json admits `name`, and its reader refuses it:
// `start` answers `reading migration file: json: unknown field "name"`, so a
// migration that vets with one fails the boot instead.
Deno.test("a migration stating its own name fails to vet", async () => {
  const got = await vet({ "01_add_c": { name: "01_add_c", operations: [addColumn] } });
  assert.equal(got.ok, false);
});

// Asked of the field alone: the rest of the cluster stays open, and a vet of
// the whole would answer about that instead.
const given = (server: boolean) =>
  new Deno.Command("cue", {
    args: ["export", ".:cluster", "-e", `(#Cluster & {capabilities: server: ${server}, state: pgroll: "01_add_c": operations: [${JSON.stringify(addColumn)}]}).state.pgroll`],
    cwd: path(".."),
    stdout: "null",
    stderr: "piped",
  }).output();

Deno.test("a cluster with no database refuses a migration", async () => {
  assert.equal((await given(true)).success, true);
  const got = await given(false);
  assert.equal(got.success, false);
  assert.match(new TextDecoder().decode(got.stderr), /state\.pgroll/);
});

Deno.test("a migration cannot take the baseline's name", async () => {
  const baseline = /#Baseline:\s*"([^"]+)"/.exec(await Deno.readTextFile(path("./ledger.cue")))![1];
  const got = await vet({ [baseline]: { operations: [addColumn] } });
  assert.equal(got.ok, false);
});
