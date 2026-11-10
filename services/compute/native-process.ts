import { loadArtifact } from "./native-artifacts.ts";

const sleep = () => new Promise((resolve) => setTimeout(resolve, 100));

export class NativeProcess {
  private constructor(
    public url: string,
    readonly deployment: string,
    private readonly child: Deno.ChildProcess,
    private readonly directory: string,
  ) {
    child.status.then((status) => { this.exited = status; });
  }
  private exited?: Deno.CommandStatus;
  private closed = false;

  static async start(artifact: Awaited<ReturnType<typeof loadArtifact>>, inputs: unknown, root: string, name: string) {
    const directory = await prepareWorkDirectory(root, name);
    const config = `${directory}/config.json`;
    const deployment = crypto.randomUUID();
    let process: NativeProcess | undefined;
    try {
      await Deno.writeTextFile(config, JSON.stringify({
        ...artifact.info, workers: 1, storage: { cache_size: "64MiB" }, storage_config: { path: `${directory}/storage` }, http_workers: 1, io_workers: 1,
        max_parallel_connector_init: 1, max_rss: Deno.env.get("FELDERA_MAX_RSS") ?? "384MiB", inputs,
      }), { mode: 0o600 });
      const child = new Deno.Command(artifact.supervisor, {
        args: [String(Deno.pid), artifact.loader,
          "--library-path", artifact.libraryPath, artifact.binary, "--config-file", config,
          "--bind-address", "127.0.0.1", "--default-port", "0", "--initial", "running", "--deployment-id", deployment],
        cwd: directory, stdin: "null", stdout: "null", stderr: "null",
      }).spawn();
      process = new NativeProcess("", deployment, child, directory);
      const deadline = Date.now() + 600000;
      for (;;) {
        await process.check();
        if (!process.url) {
          try {
            const port = Number((await Deno.readTextFile(`${directory}/port`)).trim());
            if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid native process port");
            process.url = `http://127.0.0.1:${port}`;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        }
        try {
          if (!process.url) {
            if (Date.now() > deadline) throw new Error("native process startup timed out");
            await sleep(); continue;
          }
          const response = await fetch(process.url + "/status", { signal: AbortSignal.timeout(1000) });
          if (response.ok) {
            const state = await response.json();
            if (state.runtime_status === "Running") {
              await Deno.remove(config);
              return process;
            }
            if (state.runtime_status !== "Initializing") throw new Error(`unexpected native process status: ${state.runtime_status}`);
          } else {
            await response.text();
            if (response.status !== 503) throw new Error(`native process status: ${response.status}`);
          }
        } catch (error) {
          if (!(error instanceof TypeError) && !(error instanceof DOMException)) throw error;
        }
        if (Date.now() > deadline) throw new Error("native process startup timed out");
        await sleep();
      }
    } catch (error) {
      if (process) await process.close();
      else await Deno.remove(directory, { recursive: true });
      throw error;
    }
  }

  check() {
    if (this.exited) throw new Error(`native process exited: ${this.exited.code}`);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.exited) {
      try { this.child.kill("SIGKILL"); }
      catch (error) { if (!(error instanceof Deno.errors.NotFound) && !(error instanceof TypeError && error.message === "Child process has already terminated")) throw error; }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([this.child.status.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 30000); })]);
    clearTimeout(timer);
    if (!done) {
      this.child.kill("SIGKILL");
      throw new Error("native process failed to stop");
    }
    try { await Deno.remove(this.directory, { recursive: true }); }
    catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
  }
}

export function validateWorkDirectory(root: string) {
  if (!root.startsWith("/") || root.replaceAll("/", "") === "" || root.split("/").includes("..")) throw new Error("invalid native work directory");
}

function ownedWorkDirectory(root: string, name: string) {
  validateWorkDirectory(root);
  if (!/^[a-z][a-z0-9_-]{0,99}$/.test(name)) throw new Error("invalid native work directory");
  return `${root.replace(/\/$/, "")}/${name}`;
}

export async function removeWorkDirectory(root: string, name: string) {
  try { await Deno.remove(ownedWorkDirectory(root, name), { recursive: true }); }
  catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
}

export async function prepareWorkDirectory(root: string, name: string) {
  const owned = ownedWorkDirectory(root, name);
  await Deno.mkdir(root, { recursive: true, mode: 0o700 });
  await removeWorkDirectory(root, name);
  const directory = `${owned}/${crypto.randomUUID()}`;
  await Deno.mkdir(`${directory}/storage`, { recursive: true, mode: 0o700 });
  return directory;
}
