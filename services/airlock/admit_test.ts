// pronto's lint of an effect's handler, as it runs admit.ts.

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const EFFECT = {
  table: "payment", field: "status", state: "charging", onDone: "settled", onError: "failed",
  row: ["id"], idempotent: true, attempts: 5, handler: "effects/charge.js",
};
const ISSUE = `export async function issue(request, sink) { return { done: (await sink.fetch("/c")).body }; }`;

async function lint(handler: string, effect: Record<string, unknown> = EFFECT) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/effects`);
    await Deno.writeTextFile(`${dir}/effects/charge.js`, handler);
    await Deno.writeTextFile(`${dir}/effects.json`, JSON.stringify({ effects: { charge: effect } }));
    const { code, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--config", fileURLToPath(new URL("deno.json", import.meta.url)), "--frozen", "--unstable-worker-options",
        "--allow-read", "--allow-env", fileURLToPath(new URL("admit.ts", import.meta.url)), `${dir}/effects.json`, dir],
      env: { NO_COLOR: "1" },
      stdout: "null",
    }).output();
    return { code, stderr: new TextDecoder().decode(stderr) };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a handler the airlock admits passes lint", async () => {
  const { code, stderr } = await lint(ISSUE);
  assert(code === 0, stderr);
});

Deno.test("a handler the airlock would refuse at startup fails lint, naming its effect", async () => {
  // The airlock admits every handler at startup and dies on one it refuses,
  // so a handler lint passed took the whole airlock down.
  const reconciles = { ...EFFECT, idempotent: false, reentry: "reconcile" };
  const { code, stderr } = await lint(ISSUE, reconciles);
  assertEquals(code, 1);
  assertStringIncludes(stderr, "effect charge:");
  assertStringIncludes(stderr, "must export exactly issue, reconcile; it exports issue");
});

Deno.test("an endowment the cages cannot grant fails lint", async () => {
  const { code, stderr } = await lint(ISSUE, { ...EFFECT, endowments: ["Intl"] });
  assertEquals(code, 1);
  assertStringIncludes(stderr, "endowments");
});
