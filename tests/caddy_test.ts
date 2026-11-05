import assert from "node:assert/strict";

Deno.test("the generated Caddy entrypoint handles rootless and static configurations", async () => {
  const dockerfile = await Deno.readTextFile(new URL("../.bayt/Dockerfile.caddy", import.meta.url));
  const image = dockerfile.match(/^FROM (\S+) AS caddy$/m)?.[1];
  const entry = dockerfile.match(/^ENTRYPOINT (\[.*\])$/m)?.[1];
  assert.ok(image && entry);
  const [shell, flag, script] = JSON.parse(entry) as string[];
  const exec = "exec caddy run --envfile /etc/caddy/env --config /etc/caddy/Caddyfile --adapter caddyfile";
  assert.ok(script.endsWith(exec));
  const setup = script.slice(0, -exec.length) + "printf ready";
  const dir = await Deno.makeTempDir({ prefix: "mecha-caddy-" });
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  const run = async (config: string) => {
    await Deno.writeTextFile(`${dir}/Caddyfile`, config);
    return await new Deno.Command("docker", {
      args: ["run", "--rm", "--entrypoint", shell, "-e", "ORIGIN=http://localhost:8080", "-v", `${dir}/Caddyfile:/etc/caddy/Caddyfile:ro`, "-v", `${dir}:/site`, image, flag, setup],
      stdout: "piped", stderr: "piped",
    }).output();
  };
  try {
    const rootless = await run(':8080 {\n respond "ok"\n}\n');
    assert.equal(rootless.success, true, text(rootless.stderr));
    assert.equal(text(rootless.stdout), "ready");

    await Deno.writeTextFile(`${dir}/asset.txt`, "content");
    const staticRoot = await run(":8080 {\n root * /site\n file_server\n}\n");
    assert.equal(staticRoot.success, true, text(staticRoot.stderr));
    assert.equal(text(staticRoot.stdout), "ready");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("content"));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    assert.equal(await Deno.readTextFile(`${dir}/asset.txt.etag`), `"${hex}"`);

    const invalid = await run("not a valid caddyfile {\n");
    assert.equal(invalid.success, false);
    assert.notEqual(text(invalid.stderr), "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
