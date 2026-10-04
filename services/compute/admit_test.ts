// pronto's lint of a computation, as it runs admit.ts.

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const CONTRACT = `export const reads = ["game"]; export const queries = { games: "SELECT 1" };
export const plan = () => []; export const finish = () => ({});`;

async function lint(...modules: string[]) {
  const dir = await Deno.makeTempDir();
  try {
    const files = await Promise.all(modules.map(async (text, i) => {
      await Deno.writeTextFile(`${dir}/m${i}.js`, text);
      return `${dir}/m${i}.js`;
    }));
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--config", fileURLToPath(new URL("deno.json", import.meta.url)), "--frozen", "--unstable-worker-options",
        "--allow-read", "--allow-env", fileURLToPath(new URL("admit.ts", import.meta.url)), ...files],
      env: { NO_COLOR: "1" },
      stdout: "null",
    }).output();
    return { code, stderr: new TextDecoder().decode(stderr), dir };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a module the service would refuse at startup fails lint, naming its file and the rule", async () => {
  // The service loads every computation at startup, so one such module took
  // the whole service down where lint had passed it.
  const { code, stderr, dir } = await lint(CONTRACT, `${CONTRACT}\nlet n = 3; while (n --> 0) n;`);
  assertEquals(code, 1);
  assertStringIncludes(stderr, `computation ${dir}/m1.js: SyntaxError: Possible HTML comment rejected`);
  assertStringIncludes(stderr, "SES_HTML_COMMENT_REJECTED");
});

Deno.test("a module the service admits passes lint", async () => {
  const { code, stderr } = await lint(CONTRACT);
  assert(code === 0, stderr);
});

Deno.test("a module exporting no reads of table names fails lint", async () => {
  const { code, stderr } = await lint(CONTRACT.replace('["game"]', '["game; drop"]'));
  assertEquals(code, 1);
  assertStringIncludes(stderr, "exports no `reads` list of table names");
});
