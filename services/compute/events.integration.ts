import { assertEquals } from "@std/assert";
import { type Runnable, serve, Service } from "./main.ts";

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
/** A Redis container that answers: `docker run -d` returns before the server
 * accepts connections, and a command sent sooner is refused. */
async function redis() {
  const container = await command("docker", "run", "-d", "--rm", "-p", "127.0.0.1::6379", REDIS);
  const ping = () => new Deno.Command("docker", { args: ["exec", container, "redis-cli", "PING"], stdout: "piped", stderr: "null" }).output();
  const deadline = Date.now() + 30_000;
  while (text((await ping()).stdout) !== "PONG") {
    if (Date.now() > deadline) throw new Error("Redis did not answer PING in 30s");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return container;
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("delivery did not settle");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

Deno.test("Redis delivery waits for publication, recovers on consumer replacement and retries failed requests", async () => {
  const container = await redis();
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
  const server = serve(service, "test-token", 0);
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
          `output.switch.cases.1.output.broker.outputs.0.fallback.0.retry.output.http_client.url=http://127.0.0.1:${server.addr.port}/invalidate`,
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

// The retry is bounded: a delivery compute keeps refusing crashes the consumer,
// so the stack fails loudly with compute's error rather than retrying it forever.
Deno.test("Redis delivery crashes once a refused invalidation outlasts its retries", async () => {
  const container = await redis();
  const failing: Runnable = { name: "copy", reads: ["source"], to: ["result"], async run() {} };
  let refusals = 0;
  let refuse = true;
  let accepted = 0;
  const log = console.error;
  console.error = () => {};
  const server = serve(
    new Service([failing], { async attach() {}, async detach() {}, async hold() {}, async query() { return []; } }, {
      async apply() {
        if (!refuse) return void accepted++;
        refusals++;
        throw new Error("a bug no retry fixes");
      },
    }),
    "test-token",
    0,
  );
  try {
    const port = (await command("docker", "port", container, "6379/tcp")).split(":").at(-1);
    await command(
      "docker", "exec", container, "redis-cli", "XADD", "cdc-events", "*", "data",
      JSON.stringify({ data: JSON.stringify({ __table: "source", id: "row" }) }),
    );
    const retry = "output.switch.cases.1.output.broker.outputs.0.fallback.0.retry";
    const consume = (signal: AbortSignal) =>
      new Deno.Command("redpanda-connect", {
        args: [
          "run", "--disable-telemetry", "-s", "http.enabled=false",
          "-s", `${retry}.output.http_client.url=http://127.0.0.1:${server.addr.port}/invalidate`,
          "-s", `${retry}.backoff.initial_interval=100ms`,
          "-s", `${retry}.max_retries=2`,
          "events.yaml",
        ],
        cwd: new URL(".", import.meta.url),
        env: { REDIS_URL: `redis://127.0.0.1:${port}`, COMPUTE_GROUP: "compute-test", SERVICE_JWT: "test-token" },
        stdout: "piped",
        stderr: "piped",
        signal,
      });
    const out = await consume(AbortSignal.timeout(30_000)).output();
    assertEquals(out.success, false);
    // Compute refused it once and on each retry, and the crash names its error.
    assertEquals(refusals, 3);
    const said = text(out.stdout) + text(out.stderr);
    if (!said.includes("compute refused an invalidation through every retry") || !said.includes("a bug no retry fixes")) {
      throw new Error(`no crash naming compute's error: ${said}`);
    }
    // The refused invalidation stayed pending: a restarted consumer delivers it first.
    refuse = false;
    const again = new AbortController();
    const restarted = consume(again.signal).spawn();
    try {
      await until(async () => accepted === 1);
    } finally {
      again.abort();
      await restarted.output();
    }
  } finally {
    console.error = log;
    await server.shutdown();
    await command("docker", "rm", "-f", container);
  }
});

// A run reads a fresh snapshot, so it answers every invalidation pending before
// it. A backlog published while one run is in flight must cost one more run,
// not one per event: a projection rebuilt at startup emits one CDC event per
// row, and one at a time each was a full recompute of identical inputs. A
// refused batch is retried as the one message it became, not event by event.
for (const refusedOnce of [false, true]) {
  Deno.test(`Redis delivery folds a backlog of invalidations into one run${refusedOnce ? ", retried as one" : ""}`, async () => {
    const container = await redis();
    const cli = (...args: string[]) => command("docker", "exec", container, "redis-cli", "--json", ...args);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let runs = 0;
    let refuse = refusedOnce;
    const copy: Runnable = { name: "copy", reads: ["source", "derived_input"], to: ["result"], async run() {} };
    const log = console.error;
    console.error = () => {};
    const server = serve(
      new Service([copy], { async attach() {}, async detach() {}, async hold() {}, async query() { return []; } }, {
        async apply() {
          runs++;
          if (runs === 1) {
            entered.resolve();
            await release.promise;
          } else if (refuse) {
            refuse = false;
            throw new Error("injected refusal");
          }
        },
      }),
      "test-token",
      0,
    );
    let consumer: Deno.ChildProcess | undefined;
    try {
      const port = (await command("docker", "port", container, "6379/tcp")).split(":").at(-1);
      const event = (table: string) => JSON.stringify({ data: JSON.stringify({ __table: table, id: "row" }) });
      const retry = "output.switch.cases.1.output.broker.outputs.0.fallback.0.retry";
      consumer = new Deno.Command("redpanda-connect", {
        args: [
          "run", "--disable-telemetry", "-s", "http.enabled=false",
          "-s", `${retry}.output.http_client.url=http://127.0.0.1:${server.addr.port}/invalidate`,
          "-s", `${retry}.backoff.initial_interval=100ms`,
          "events.yaml",
        ],
        cwd: new URL(".", import.meta.url),
        env: { REDIS_URL: `redis://127.0.0.1:${port}`, COMPUTE_GROUP: "compute-test", SERVICE_JWT: "test-token" },
        stdout: "null",
        stderr: "null",
      }).spawn();
      await cli("XADD", "cdc-events", "*", "data", event("source"));
      await entered.promise;
      // At once, as a startup rebuild lands them: one-by-one publishing would
      // spread them over the batch period.
      await cli(
        "EVAL",
        "for i = 1, 200 do redis.call('XADD', 'cdc-events', '*', 'data', ARGV[(i % 2) + 1]) end",
        "0",
        event("derived_input"),
        event("source"),
      );
      release.resolve();
      await until(async () => {
        const [group] = JSON.parse(await cli("XINFO", "GROUPS", "cdc-events"));
        return group.lag === 0 && group.pending === 0;
      });
      assertEquals(runs, refusedOnce ? 3 : 2, "the 200 invalidations pending behind the first run cost one more run, and one retry");
    } finally {
      release.resolve();
      console.error = log;
      consumer?.kill("SIGKILL");
      await consumer?.status;
      await server.shutdown();
      await command("docker", "rm", "-f", container);
    }
  });
}
