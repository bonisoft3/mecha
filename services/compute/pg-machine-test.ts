const DATABASE = "bonitao/mecha-database:0.8.0@sha256:ccb59fdc18217eb679456c62b0f5aa05d79138bcc8c431087984a6ff1e2b552b";

async function docker(args: string[]) {
  const result = await new Deno.Command("docker", { args, stdout: "piped", stderr: "piped" }).output();
  if (!result.success) throw new Error(`docker ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
  return new TextDecoder().decode(result.stdout).trim();
}

export const pgTest = (name: string, fn: () => Promise<void>) => Deno.test({ name, fn, sanitizeResources: false, sanitizeOps: false });

export async function postgres() {
  const name = `compute-machine-${crypto.randomUUID().slice(0, 8)}`;
  await docker(["run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=compute", "-p", "127.0.0.1::5432", DATABASE]);
  try {
    for (let i = 0;; i++) {
      const ready = await new Deno.Command("docker", {
        args: ["exec", name, "pg_isready", "-h", "127.0.0.1", "-qU", "postgres"],
        stdout: "null",
        stderr: "piped",
      }).output();
      if (ready.success) break;
      if (i === 80) throw new Error(`machine PostgreSQL did not start: ${await docker(["logs", name])}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const address = await docker(["port", name, "5432/tcp"]);
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error(`unexpected PostgreSQL address: ${address}`);
    return {
      url: `postgresql://postgres:compute@${address}/postgres`,
      async [Symbol.asyncDispose]() {
        await docker(["rm", "-f", name]);
      },
    };
  } catch (error) {
    await docker(["rm", "-f", name]);
    throw error;
  }
}
