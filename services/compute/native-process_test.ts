import { assert, assertEquals, assertRejects } from "@std/assert";

Deno.test({
  name: "supervisor propagates child exit and kills its child when Deno dies",
  ignore: Deno.build.os !== "linux" || !Deno.env.get("NATIVE_SUPERVISOR_TEST"),
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supervisor = Deno.env.get("NATIVE_SUPERVISOR_TEST")!;
    const exited = await new Deno.Command(supervisor, {
      args: [String(Deno.pid), "/bin/sh", "-c", "exit 37"],
      stdout: "null", stderr: "piped",
    }).output();
    assertEquals(exited.code, 37);
    const dir = await Deno.makeTempDir();
    const source = `${dir}/parent.ts`;
    const pidFile = `${dir}/child.pid`;
    await Deno.writeTextFile(source, `const child = new Deno.Command(Deno.args[0], { args: [String(Deno.pid), "/bin/sleep", "120"] }).spawn();
await Deno.writeTextFile(Deno.args[1], String(child.pid));
await child.status;`);
    const parent = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-run", "--allow-write", source, supervisor, pidFile],
      stdout: "null", stderr: "inherit",
    }).spawn();
    let stopped = false;
    try {
      let pid = 0;
      const deadline = Date.now() + 10000;
      while (!pid && Date.now() < deadline) {
        try { pid = Number(await Deno.readTextFile(pidFile)); }
        catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(pid > 0, "child did not start");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert((await Deno.readTextFile(`/proc/${pid}/stat`)).length > 0);
      parent.kill("SIGKILL");
      await parent.status;
      stopped = true;
      for (;;) {
        try {
          const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
          if (/\) Z /.test(stat)) break;
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) break;
          throw error;
        }
        if (Date.now() >= deadline) throw new Error("child survived Deno parent death");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      if (!stopped) parent.kill("SIGKILL");
      await parent.status;
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test("native scratch cleanup preserves other computations", async () => {
  const { prepareWorkDirectory } = await import("./native-process.ts");
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/active`, { recursive: true });
    await Deno.mkdir(`${root}/other`, { recursive: true });
    await Deno.writeTextFile(`${root}/active/stale`, "old");
    await Deno.writeTextFile(`${root}/other/keep`, "other");
    const first = await prepareWorkDirectory(root, "active");
    assertEquals((await Deno.stat(`${first}/storage`)).isDirectory, true);
    await assertRejects(() => Deno.stat(`${root}/active/stale`), Deno.errors.NotFound);
    assertEquals(await Deno.readTextFile(`${root}/other/keep`), "other");
    const successor = await prepareWorkDirectory(root, "active");
    assert(first !== successor);
    await assertRejects(() => Deno.stat(first), Deno.errors.NotFound);
    assertEquals((await Deno.stat(`${successor}/storage`)).isDirectory, true);
  } finally { await Deno.remove(root, { recursive: true }); }
});
