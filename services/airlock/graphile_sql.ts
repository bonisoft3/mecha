// Graphile Worker's schema as one initdb step (graphile.sql), written from the
// migration texts of the graphile-worker deno.lock pins. A guard calls
// graphile_worker.add_job in the transition's own commit, and a held seed can
// make that transition at initdb, so the schema has to be there before any
// process could run Graphile's migrator.
//
// The file is what Graphile's own install does: its bootstrap (migrate.js),
// then every migration in order, each recorded in `migrations` with its
// breaking flag. Graphile's next migrate check then finds the schema current;
// docker_test.ts holds that, and that the result equals Graphile's own
// install. A graphile-worker bump fails graphile_sql_test.ts until this is
// run again.
//
//   deno run --frozen --allow-read --allow-write graphile_sql.ts

const SCHEMA = '"graphile_worker"';
export const FILE = new URL("./graphile.sql", import.meta.url);

/** graphile.sql's text, from the pinned graphile-worker. */
export async function render(): Promise<string> {
  const index = import.meta.resolve("graphile-worker");
  const { version } = JSON.parse(await Deno.readTextFile(new URL("../package.json", index)));
  const { migrations } = await import(new URL("./generated/sql.js", index).href) as { migrations: Record<string, string> };
  const steps = Object.entries(migrations).map(([file, text]) => {
    const n = parseInt(file.slice(0, 6), 10);
    return [
      `-- ${file}`,
      // lib.js's BREAKING_MIGRATIONS rule, restated: lib.js cannot be imported
      // without graphile-config reading the environment.
      `insert into ${SCHEMA}.migrations (id, breaking) values (${n}, ${text.startsWith("--! breaking")});`,
      text.replace(/:GRAPHILE_WORKER_SCHEMA\b/g, SCHEMA).trimEnd(),
    ].join("\n");
  });
  return [
    `-- Written by \`task generate:graphile\` (graphile_sql.ts) from graphile-worker ${version}; do not edit.`,
    "begin;",
    `create schema if not exists ${SCHEMA};`,
    `create table if not exists ${SCHEMA}.migrations(\n  id int primary key,\n  ts timestamptz default now() not null\n);`,
    `alter table ${SCHEMA}.migrations add column if not exists breaking boolean not null default false;`,
    ...steps,
    "commit;",
    "",
  ].join("\n");
}

if (import.meta.main) await Deno.writeTextFile(FILE, await render());
