import { assertEquals } from "@std/assert";
import { handler, type Runnable, Service } from "./main.ts";

const REDIS = "redis:7.4.1-alpine@sha256:59b6e694653476de2c992937ebe1c64182af4728e54bb49e9b7a6c26614d8933";
const text = (b: Uint8Array) => new TextDecoder().decode(b).trim();
async function command(cmd: string, ...args: string[]) {
  const r = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!r.success) throw new Error(`${cmd}: ${text(r.stderr)}`);
  return text(r.stdout);
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("delivery did not settle");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

Deno.test("Redis delivery waits for publication, recovers on consumer replacement and retries failed requests", async () => {
  const container = await command(
    "docker",
    "run",
    "-d",
    "--rm",
    "-p",
    "127.0.0.1::6379",
    REDIS,
  );
  const cli = (...args: string[]) => command("docker", "exec", container, "redis-cli", "--json", ...args);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let source = 1;
  let output = 0;
  let attempts = 0;
  let blocked = true;
  let failNext = false;
  const c: Runnable = {
    name: "copy",
    reads: ["source", "derived_input"],
    to: ["result"],
    async run() {
      return source;
    },
  };
  const service = new Service([c], {
    async attach() {},
    async detach() {},
    async hold() {},
    async query() {
      return [];
    },
  }, {
    async apply(_c, value) {
      attempts++;
      if (blocked) {
        entered.resolve();
        await release.promise;
      }
      if (failNext) {
        failNext = false;
        throw new Error("injected publication failure");
      }
      output = value as number;
    },
  });
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen() {},
    onError(error) {
      if (
        !(error instanceof Error) ||
        error.message !== "injected publication failure"
      ) throw error;
      return new Response(null, { status: 500 });
    },
  }, handler(service, "test-token"));
  let consumer: Deno.ChildProcess | undefined;
  const stopped: Promise<Deno.CommandOutput>[] = [];
  const stop = async () => {
    if (consumer) {
      consumer.kill("SIGKILL");
      stopped.push(consumer.output());
      await stopped.at(-1);
      consumer = undefined;
    }
  };
  try {
    const port = (await command("docker", "port", container, "6379/tcp")).split(
      ":",
    ).at(-1);
    const start = () => {
      consumer = new Deno.Command("redpanda-connect", {
        args: [
          "run",
          "--disable-telemetry",
          "-s",
          "http.enabled=false",
          "-s",
          `output.switch.cases.1.output.http_client.url=http://127.0.0.1:${server.addr.port}/invalidate`,
          "-s",
          "output.switch.cases.1.output.http_client.retries=0",
          "events.yaml",
        ],
        cwd: new URL(".", import.meta.url),
        env: {
          REDIS_URL: `redis://127.0.0.1:${port}`,
          COMPUTE_GROUP: "compute-test",
          SERVICE_JWT: "test-token",
        },
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    };
    const publish = (table: string) =>
      cli(
        "XADD",
        "cdc-events",
        "*",
        "data",
        JSON.stringify({
          data: JSON.stringify({ __table: table, id: "row" }),
        }),
      );
    const pending = async () =>
      (JSON.parse(
        await cli("XPENDING", "cdc-events", "compute-test"),
      ) as unknown[])[0];
    // A record committed before consumer startup must not be missed.
    await publish("source");
    start();
    await Promise.race([entered.promise, until(async () => attempts > 0)]);
    assertEquals(output, 0);
    assertEquals(await pending(), 1);
    await stop();
    failNext = true;
    blocked = false;
    release.resolve();
    await until(async () => await service.refresh([]));
    source = 2;
    start();
    await until(async () => output === 2 && await pending() === 0);
    assertEquals(attempts, 2);
    failNext = true;
    source = 3;
    await publish("derived_input");
    await until(async () => output === 3 && await pending() === 0);
    assertEquals(attempts, 4);
    await publish("result");
    await until(async () => {
      const [group] = JSON.parse(await cli("XINFO", "GROUPS", "cdc-events"));
      return group.lag === 0 && group.pending === 0;
    });
    assertEquals(
      attempts,
      4,
      "a computation does not subscribe to unrelated output tables",
    );
  } finally {
    release.resolve();
    await stop();
    await server.shutdown();
    await command("docker", "rm", "-f", container);
  }
});
