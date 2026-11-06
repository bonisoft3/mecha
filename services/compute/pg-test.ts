async function run(command: string, args: string[]) {
  const { success, stdout, stderr } = await new Deno.Command(command, {
    args,
    env: { LC_ALL: "C", LANG: "C" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!success) {
    throw new Error(`${command}: ${new TextDecoder().decode(stderr)}`);
  }
  return new TextDecoder().decode(stdout).trim();
}

const available = (() => {
  try {
    return new Deno.Command("initdb", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
})();

export const pgTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({
    name,
    fn,
    ignore: !available,
    sanitizeResources: false,
    sanitizeOps: false,
  });

export async function postgres() {
  const root = await Deno.makeTempDir();
  await run("initdb", ["-D", `${root}/data`, "-U", "postgres", "--auth=trust"]);
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  await run("pg_ctl", [
    "-D",
    `${root}/data`,
    "-w",
    "-o",
    `-p ${port} -c listen_addresses=localhost -c unix_socket_directories='' -c wal_level=logical -c track_counts=off`,
    "-l",
    `${root}/log`,
    "start",
  ]);
  return {
    url: `postgresql://postgres@localhost:${port}/postgres`,
    async [Symbol.asyncDispose]() {
      await run("pg_ctl", ["-D", `${root}/data`, "-m", "immediate", "stop"]);
      await Deno.remove(root, { recursive: true });
    },
  };
}
