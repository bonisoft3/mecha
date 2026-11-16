// What serves an isolate's build outside Cloudflare (isolate.cue's
// #IsolateHost): a call that never ends costs the module's process, which the
// host replaces.
//
//   deno test --no-config --no-lock --allow-read --allow-write --allow-run --allow-net isolate_test.ts

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CALL_TIMEOUT_MS } from "./services/airlock/reentry.ts";

const MECHA = fileURLToPath(new URL(".", import.meta.url));

async function exported(expression: string): Promise<unknown> {
  const out = await new Deno.Command("cue", { args: ["export", ".:cluster", "-e", expression], cwd: MECHA, stdout: "piped", stderr: "piped" }).output();
  assert.ok(out.success, new TextDecoder().decode(out.stderr));
  return JSON.parse(new TextDecoder().decode(out.stdout));
}

// The airlock gives a call up on its own timeout before the host replaces
// the worker running it.
Deno.test("an isolate's deadline is past the airlock's call timeout", async () => {
  assert.ok((await exported("#IsolateDeadlineMs") as number) > CALL_TIMEOUT_MS);
});

Deno.test("the host answers through its module's process, and replaces one a call outlives", async () => {
  // Deno loads a module by its real path: macOS's temporary directory is a symlink.
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await Deno.writeTextFile(`${dir}/host.js`, await exported("#IsolateHost") as string);
    await Deno.writeTextFile(`${dir}/runner.js`, await exported("#IsolateRunner") as string);
    const port = 19000 + Math.floor(Math.random() * 1000);
    // Its top-level code takes a while, as a module's may: the first call
    // arrives before it ends.
    await Deno.writeTextFile(`${dir}/module.js`, `await new Promise((r) => setTimeout(r, 300))
const spin = (ms) => { for (const end = Date.now() + ms; Date.now() < end;) {} }
const denied = async (f) => { try { await f(); return false } catch { return true } }
export default {
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/loop') for (;;) {}
    if (pathname === '/slow') await new Promise((r) => setTimeout(r, 5000))
    if (pathname === '/busy') spin(600)
    if (pathname === '/heap') { const held = []; for (;;) held.push(new Array(1e6).fill(held.length)) }
    if (pathname === '/empty') return new Response(null, { status: 204 })
    if (pathname === '/error') return Response.error()
    if (pathname === '/throw') throw new Error('the module refused')
    if (pathname === '/bodyless') return Response.json({ bodyless: request.body === null })
    if (pathname === '/reach') return Response.json({
      file: await denied(() => Deno.readTextFile('/etc/hosts')),
      loopback: await denied(() => fetch('http://127.0.0.1:${port}/echo')),
      named: await denied(() => fetch('http://localhost:${port}/echo')),
      any: await denied(() => fetch('http://0.0.0.0:${port}/echo')),
    })
    return Response.json({ path: pathname, body: request.method === 'POST' ? await request.json() : null, header: request.headers.get('x-key') }, { status: 201, headers: { 'x-answer': 'yes' } })
  },
}`);
    const host = new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-config", "--allow-net", "--allow-read", "--allow-run", "--allow-sys=networkInterfaces", `${dir}/host.js`, `${dir}/module.js`, String(port), "1000", "64"],
      stdout: "null",
      stderr: "piped",
    }).spawn();
    const call = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
    // A host is up once it takes a connection.
    for (const deadline = Date.now() + 15000; ; ) {
      try {
        (await Deno.connect({ hostname: "127.0.0.1", port })).close();
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    // A call that fails ends with its connection broken before any status.
    const broken = async (path: string) => {
      try {
        await (await call(path)).text();
        return false;
      } catch {
        return true;
      }
    };
    let stderr = "";
    try {
      const echoed = await call("/echo", { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "x-key": "k1" } });
      assert.equal(echoed.status, 201);
      assert.equal(echoed.headers.get("x-answer"), "yes");
      assert.deepEqual(await echoed.json(), { path: "/echo", body: { a: 1 }, header: "k1" });

      // A request without a body stays one, POST or not.
      assert.deepEqual(await (await call("/bodyless", { method: "POST" })).json(), { bodyless: true });
      assert.deepEqual(await (await call("/bodyless", { method: "POST", body: "x" })).json(), { bodyless: false });

      // A response without a body stays one.
      const empty = await call("/empty");
      assert.equal(empty.status, 204);
      assert.equal(await empty.text(), "");

      // A network error, or a module that throws, is a broken connection.
      assert.ok(await broken("/error"), "a network error was answered");
      assert.ok(await broken("/throw"), "a thrown error was answered");

      // The module reads its build alone, and reaches none of this machine's
      // addresses, by number or by name.
      assert.deepEqual(await (await call("/reach")).json(), { file: true, loopback: true, named: true, any: true });

      // A call's deadline runs from when the module takes it up: three calls
      // busy 600 ms each, one after another, outlast the 1000 ms deadline
      // together and each answers.
      const busy = await Promise.all([call("/busy"), call("/busy"), call("/busy")]);
      assert.deepEqual(busy.map((r) => r.status), [201, 201, 201]);
      await Promise.all(busy.map((r) => r.body?.cancel()));

      // The stuck call, and a younger one in flight with it, fail with the
      // module's process; the host stays, and answers from another.
      const started = Date.now();
      const [stuck, younger] = await Promise.all([broken("/loop"), new Promise((r) => setTimeout(r, 300)).then(() => broken("/slow"))]);
      assert.ok(stuck, "the stuck call was answered");
      assert.ok(younger, "a call in flight when the process was replaced was answered");
      assert.ok(Date.now() - started < 10000, "the stuck call was not given up at its deadline");
      const after = await call("/echo");
      assert.equal(after.status, 201);
      assert.deepEqual(await after.json(), { path: "/echo", body: null, header: null });

      // A heap past the module's limit ends its process alone.
      assert.ok(await broken("/heap"), "a call past the heap was answered");
      assert.equal((await call("/echo")).status, 201);
    } finally {
      host.kill("SIGKILL");
      stderr = new TextDecoder().decode((await host.output()).stderr);
    }
    assert.match(stderr, /a call outlived the isolate's 1000 ms/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
