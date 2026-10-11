import { assertEquals } from "@std/assert";
import { FILE, render } from "./graphile_sql.ts";

// The step initdb runs is a file in git, and the migrator it stands in for is
// whatever deno.lock pins; a bump of one without the other would install a
// schema Graphile then migrates under a running guard.
Deno.test("graphile.sql is what the pinned graphile-worker writes", async () => {
  assertEquals(await Deno.readTextFile(FILE), await render(), "run `task generate:graphile`");
});
