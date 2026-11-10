import { assertRejects } from "@std/assert";
import { FELDERA_IMAGE, FELDERA_PLATFORM_VERSION, loadArtifact, sha256 } from "./native-artifacts.ts";

Deno.test("artifact validation binds SQL, architecture and every executable dependency", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/task`);
    await Deno.mkdir(`${dir}/runtime`);
    const files: Record<string, string> = {
      "task/pipeline": "binary", "task/program-info.json": "{}",
      "runtime/loader": "loader", "runtime/supervisor": "supervisor", "runtime/lib": "library",
    };
    for (const [path, content] of Object.entries(files)) await Deno.writeTextFile(`${dir}/${path}`, content);
    const entry = async (path: string) => ({ path, sha256: await sha256(files[path]) });
    const manifest = {
      format: 1, felderaImage: FELDERA_IMAGE, platformVersion: FELDERA_PLATFORM_VERSION,
      architecture: Deno.build.arch as string,
      programs: { task: { sqlSha256: await sha256("sql"), binary: await entry("task/pipeline"), programInfo: await entry("task/program-info.json") } },
      runtime: { supervisor: "runtime/supervisor", loader: "runtime/loader", libraryDirectories: ["runtime"], files: await Promise.all(["runtime/loader", "runtime/supervisor", "runtime/lib"].map(entry)) },
    };
    manifest.runtime.libraryDirectories = ["runtime/libdir"];
    await Deno.writeTextFile(`${dir}/manifest.json`, JSON.stringify(manifest));
    const linux = { os: "linux", arch: Deno.build.arch };
    await assertRejects(() => loadArtifact(dir, "task", "sql", { ...linux, os: "windows" }), Error, "require Linux");
    await loadArtifact(dir, "task", "sql", linux);
    await assertRejects(() => loadArtifact(dir, "task", "other", linux), Error, "SQL mismatch");
    await Deno.writeTextFile(`${dir}/runtime/lib`, "tampered");
    await assertRejects(() => loadArtifact(dir, "task", "sql", linux), Error, "digest mismatch");
    manifest.architecture = "unsupported";
    await Deno.writeTextFile(`${dir}/manifest.json`, JSON.stringify(manifest));
    await assertRejects(() => loadArtifact(dir, "task", "sql", linux), Error, "incompatible");
  } finally { await Deno.remove(dir, { recursive: true }); }
});
