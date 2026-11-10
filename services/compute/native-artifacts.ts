import { createSHA256 } from "npm:hash-wasm@4.12.0";

export const FELDERA_IMAGE = "images.feldera.com/feldera/pipeline-manager:0.367.0@sha256:42819714d16f7d5d37c17c87812ce98fb23efd2b1bfbf95b4889877f14693272";

export const FELDERA_PLATFORM_VERSION = "0.367.0+3a7edb86ed921c2dead05b627ac16c6f89fbfc36";

export type NativeArtifactProgram = {
  sqlSha256: string;
  binary: { path: string; sha256: string };
  programInfo: { path: string; sha256: string };
};
export type NativeArtifactManifest = {
  format: 1;
  felderaImage: string;
  platformVersion: string;
  architecture: string;
  programs: Record<string, NativeArtifactProgram>;
  runtime: { supervisor: string; loader: string; libraryDirectories: string[]; files: { path: string; sha256: string }[] };
};

export async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadArtifact(dir: string, name: string, sql: string, platform: { os: string; arch: string } = Deno.build) {
  if (platform.os !== "linux") throw new Error("native artifacts require Linux");
  if (!/^[a-z][a-z0-9_-]{0,99}$/.test(name)) throw new Error("invalid artifact name");
  const manifest: NativeArtifactManifest = JSON.parse(await Deno.readTextFile(`${dir}/manifest.json`));
  if (manifest.format !== 1 || manifest.felderaImage !== FELDERA_IMAGE ||
      manifest.platformVersion !== FELDERA_PLATFORM_VERSION || manifest.architecture !== platform.arch) {
    throw new Error("incompatible native artifact manifest");
  }
  const program = manifest.programs?.[name];
  if (!program || program.sqlSha256 !== await sha256(sql)) throw new Error(`native artifact SQL mismatch: ${name}`);
  const fileHash = async (path: string) => {
    const hash = await createSHA256();
    const file = await Deno.open(path, { read: true });
    try {
      const buffer = new Uint8Array(1024 * 1024);
      for (;;) {
        const count = await file.read(buffer);
        if (count === null) break;
        hash.update(buffer.subarray(0, count));
      }
      return hash.digest();
    } finally { file.close(); }
  };
  const read = async (entry: { path: string; sha256: string }, expected: string) => {
    if (!entry || entry.path !== `${name}/${expected}` || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error("invalid native artifact path or digest");
    const bytes = await Deno.readFile(`${dir}/${entry.path}`);
    if (await sha256(bytes) !== entry.sha256) throw new Error(`native artifact digest mismatch: ${entry.path}`);
    return bytes;
  };
  if (!program.binary || program.binary.path !== `${name}/pipeline` ||
      !/^[0-9a-f]{64}$/.test(program.binary.sha256) ||
      await fileHash(`${dir}/${program.binary.path}`) !== program.binary.sha256) {
    throw new Error(`native artifact digest mismatch: ${name}/pipeline`);
  }
  const info = JSON.parse(new TextDecoder().decode(await read(program.programInfo, "program-info.json")));
  const runtime = manifest.runtime;
  const safe = (path: string) => typeof path === "string" && /^runtime\/[a-zA-Z0-9_./+-]+$/.test(path) && !path.split("/").includes("..");
  if (!runtime || !safe(runtime.loader) || runtime.supervisor !== "runtime/supervisor" || !Array.isArray(runtime.libraryDirectories) ||
      !runtime.libraryDirectories.length || !runtime.libraryDirectories.every(safe) || !Array.isArray(runtime.files) ||
      (!runtime.files.some((entry) => entry.path === runtime.loader) || !runtime.files.some((entry) => entry.path === runtime.supervisor))) throw new Error("invalid native runtime files");
  for (const entry of runtime.files) {
    if (!safe(entry.path) || !/^[0-9a-f]{64}$/.test(entry.sha256) ||
        await fileHash(`${dir}/${entry.path}`) !== entry.sha256) throw new Error(`native runtime digest mismatch: ${entry.path}`);
  }
  return { supervisor: `${dir}/${runtime.supervisor}`, binary: `${dir}/${program.binary.path}`, info, loader: `${dir}/${runtime.loader}`,
    libraryPath: runtime.libraryDirectories.map((path) => `${dir}/${path}`).join(":") };
}
