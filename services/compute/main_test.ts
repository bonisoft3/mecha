// The compute service's scheduling, sink contract and Postgres reads.
//
// The Postgres tests start a throwaway cluster with the initdb on PATH and
// need DuckDB's postgres and ducklake extensions installed (install.ts), as
// the image installs them at build; without initdb they are ignored.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  Computation,
  Database,
  Lake,
  type Reader,
  type Runnable,
  seedOf,
  Service,
  Sinks,
  type Snapshots,
  type Store,
} from "./main.ts";
import { Runner } from "./workers.ts";

/** Fingerprints are a counter per table, bumped by `change`. */
class FakeLake implements Snapshots, Reader {
  counts = new Map<string, number>();
  attached = false;

  change(table: string) {
    this.counts.set(table, (this.counts.get(table) ?? 0) + 1);
  }

  async attach() {
    this.attached = true;
  }

  async detach() {
    this.attached = false;
  }

  async fingerprint(tables: string[]) {
    assert(this.attached);
    return JSON.stringify(tables.map((t) => this.counts.get(t) ?? 0));
  }

  async hold() {
    assert(this.attached);
  }

  async query() {
    assert(!this.attached, "a program ran with Postgres attached");
    return [];
  }
}

class FakeSinks {
  applied: string[] = [];

  async apply(c: Runnable) {
    this.applied.push(c.name);
    return {};
  }
}

type Fake = Runnable & { runs: number };

function computation(name: string, every: number, reads = ["game"], to = ["sink"]): Fake {
  const c: Fake = {
    name,
    every,
    reads,
    to,
    ran: null,
    runs: 0,
    async run(lake) {
      await lake.query("");
      c.runs += 1;
      return Object.fromEntries(to.map((t) => [t, []]));
    },
  };
  return c;
}

Deno.test("each computation is looked at on its own interval", async () => {
  // One tick at the shortest interval ran every computation that often.
  const lake = new FakeLake();
  const sinks = new FakeSinks();
  const fast = computation("fast", 10, ["game"], ["a"]);
  const slow = computation("slow", 30, ["game"], ["b"]);
  const service = new Service([fast, slow], lake, sinks);
  assertEquals(await service.tick(0), 10);
  assertEquals([fast.runs, slow.runs], [1, 1]);
  lake.change("game");
  assertEquals(await service.tick(10), 20);
  assertEquals([fast.runs, slow.runs], [2, 1]);
  // Nothing changed since the fast one ran: it is looked at and skipped.
  assertEquals(await service.tick(20), 30);
  assertEquals([fast.runs, slow.runs], [2, 1]);
  assertEquals(await service.tick(30), 40);
  assertEquals([fast.runs, slow.runs], [2, 2]);
  assertEquals(await service.tick(40), 50);
  assertEquals([fast.runs, slow.runs], [2, 2]);
});

Deno.test("a computation runs when any read changed", async () => {
  const lake = new FakeLake();
  const sinks = new FakeSinks();
  const c = computation("c", 5, ["game", "team"]);
  const service = new Service([c], lake, sinks);
  await service.tick(0);
  lake.change("player");
  await service.tick(5);
  assertEquals(c.runs, 1);
  lake.change("team");
  await service.tick(10);
  assertEquals(c.runs, 2);
  assertEquals(sinks.applied, ["c", "c"]);
});

type Request = [string, string, unknown];

/** A PostgREST stand-in recording what is sent to it. */
class Crud {
  requests: Request[] = [];
  tables = new Map<string, Set<string>>();
  server: Deno.HttpServer<Deno.NetAddr>;
  url: string;

  constructor() {
    this.server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname + url.search);
      const text = await req.text();
      const body = text === "" ? null : JSON.parse(text);
      this.requests.push([req.method, path, body]);
      const name = url.pathname.slice(1);
      if (!this.tables.has(name)) this.tables.set(name, new Set());
      const table = this.tables.get(name)!;
      if (req.method === "POST") {
        for (const r of body) table.add(r.id);
        return new Response(null, { status: 201 });
      }
      for (const id of JSON.parse(`[${path.split("in.(")[1].slice(0, -1)}]`)) table.delete(id);
      return new Response(null, { status: 204 });
    });
    this.url = `http://127.0.0.1:${this.server.addr.port}`;
  }

  take(): Request[] {
    const out = this.requests;
    this.requests = [];
    return out;
  }

  async [Symbol.asyncDispose]() {
    await this.server.shutdown();
  }
}

/** The tables as the crud stand-in left them. */
class FakeDatabase implements Store {
  checked: unknown[] = [];

  constructor(private crud: Crud) {}

  async ids(table: string) {
    return [...(this.crud.tables.get(table) ?? [])].sort();
  }

  async check(plan: unknown) {
    this.checked.push(plan);
  }
}

Deno.test("rows no longer produced are deleted and unchanged ones not rewritten", async () => {
  await using crud = new Crud();
  crud.tables.set("team_chance", new Set(["a", "b"]));
  const database = new FakeDatabase(crud);
  const sinks = new Sinks(database, crud.url, "jwt");
  const c = computation("chances", 30, ["game"], ["team_chance", "game_importance"]);
  // Rows found at start are unknown: each produced one is written once.
  await sinks.apply(c, { team_chance: [{ id: "a", rank: 1 }, { id: "c", rank: 2 }], game_importance: [] });
  assertEquals(crud.take(), [
    ["POST", "/team_chance?on_conflict=id", [{ id: "a", rank: 1 }, { id: "c", rank: 2 }]],
    ["DELETE", '/team_chance?id=in.("b")', null],
  ]);
  await sinks.apply(c, { team_chance: [{ id: "a", rank: 1 }, { id: "c", rank: 2 }], game_importance: [] });
  assertEquals(crud.take(), []);
  await sinks.apply(c, { team_chance: [{ id: "a", rank: 2 }], game_importance: [{ id: "g", home: 1.5 }] });
  assertEquals(crud.take(), [
    ["POST", "/team_chance?on_conflict=id", [{ id: "a", rank: 2 }]],
    ["POST", "/game_importance?on_conflict=id", [{ id: "g", home: 1.5 }]],
    ["DELETE", '/team_chance?id=in.("c")', null],
  ]);
  // Every write was checked first, deletions included.
  assertEquals(database.checked[2], {
    team_chance: [[{ id: "a", rank: 2 }], ["c"]],
    game_importance: [[{ id: "g", home: 1.5 }], []],
  });
  // A row deleted behind the service's back (a cascade) is written again.
  crud.tables.get("team_chance")!.delete("a");
  await sinks.apply(c, { team_chance: [{ id: "a", rank: 2 }], game_importance: [{ id: "g", home: 1.5 }] });
  assertEquals(crud.take(), [["POST", "/team_chance?on_conflict=id", [{ id: "a", rank: 2 }]]]);
});

for (
  const [what, out] of [
    ["a sink it does not write", { team_chance: [], standing: [] }],
    ["no sink", {}],
    ["a repeated id", { team_chance: [{ id: "a" }, { id: "a" }] }],
    ["a number id", { team_chance: [{ id: 1 }] }],
    ["a NaN", { team_chance: [{ id: "a", percent: NaN }] }],
    ["rows of two shapes", { team_chance: [{ id: "a", percent: 1 }, { id: "b" }] }],
    ["a row that is no object", { team_chance: [[["id", "a"]]] }],
    ["no object at all", [["team_chance", []]]],
  ] as [string, unknown][]
) {
  Deno.test(`an output with ${what} writes nothing`, async () => {
    await using crud = new Crud();
    const database = new FakeDatabase(crud);
    const sinks = new Sinks(database, crud.url, undefined);
    await assertRejects(() => sinks.apply(computation("chances", 30, ["game"], ["team_chance"]), out));
    assertEquals(crud.take(), []);
    assertEquals(database.checked, []);
  });
}

// Postgres.

const pgTools = (() => {
  try {
    return new Deno.Command("initdb", { args: ["--version"], stdout: "null", stderr: "null" }).outputSync().success;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
})();

async function run(cmd: string, args: string[], stdin?: string): Promise<string> {
  const child = new Deno.Command(cmd, { args, stdin: stdin === undefined ? "null" : "piped", stdout: "piped", stderr: "piped" })
    .spawn();
  if (stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  }
  const { success, stdout, stderr } = await child.output();
  if (!success) throw new Error(`${cmd} ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`);
  return new TextDecoder().decode(stdout).trim();
}

const psql = (url: string, sql: string) => run("psql", [url, "-XAtqc", sql]);

/** A throwaway cluster, stopped when disposed. */
async function postgres() {
  const root = await Deno.makeTempDir();
  await run("initdb", ["-D", `${root}/data`, "-U", "postgres", "--auth=trust"]);
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const options = `-p ${port} -c listen_addresses=localhost -c unix_socket_directories=''`;
  await run("pg_ctl", ["-D", `${root}/data`, "-w", "-o", options, "-l", `${root}/log`, "start"]);
  return {
    url: `postgresql://postgres@localhost:${port}/postgres`,
    async [Symbol.asyncDispose]() {
      await run("pg_ctl", ["-D", `${root}/data`, "-m", "immediate", "stop"]);
      await Deno.remove(root, { recursive: true });
    },
  };
}

async function eventually(predicate: () => Promise<boolean>, seconds = 15) {
  const deadline = performance.now() + seconds * 1000;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const pgTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, ignore: !pgTools, sanitizeResources: false, sanitizeOps: false, fn });

pgTest("the fingerprint sees a commit out of xid order", async () => {
  // A transaction holding an older xid that commits after a younger one:
  // row counts and the newest stamped txid both miss it, which is how the
  // lake once kept a result recorded under a long transaction.
  await using pg = await postgres();
  await psql(
    pg.url,
    `CREATE TABLE game (id int PRIMARY KEY, v int, txid bigint DEFAULT pg_current_xact_id()::text::bigint);
     CREATE FUNCTION restamp() RETURNS trigger LANGUAGE plpgsql AS
       $$BEGIN NEW.txid := pg_current_xact_id()::text::bigint; RETURN NEW; END$$;
     CREATE TRIGGER restamp BEFORE UPDATE ON game FOR EACH ROW EXECUTE FUNCTION restamp();
     INSERT INTO game (id, v) VALUES (1, 0), (2, 0);`,
  );
  const older = new Deno.Command("psql", { args: [pg.url, "-Xq"], stdin: "piped", stdout: "null" }).spawn();
  const writer = older.stdin.getWriter();
  await writer.write(new TextEncoder().encode("BEGIN; UPDATE game SET v = 1 WHERE id = 1;\n"));
  await eventually(async () =>
    (await psql(
      pg.url,
      "SELECT count(*) FROM pg_stat_activity WHERE backend_xid IS NOT NULL AND state = 'idle in transaction'",
    )) === "1"
  );
  await psql(pg.url, "UPDATE game SET v = 2 WHERE id = 2");
  const lake = await Lake.open(pg.url, await Deno.makeTempDir());
  const seen = async () => {
    await lake.attach();
    try {
      return JSON.parse(await lake.fingerprint(["game"]))[0][0];
    } finally {
      await lake.detach();
    }
  };
  // The younger update is counted; the older, still open, is not yet.
  await eventually(async () => (await seen()) === "3");
  await lake.attach();
  await lake.hold(["game"], await lake.fingerprint(["game"]));
  await lake.detach();
  const stamped = await psql(pg.url, "SELECT count(*), max(txid) FROM game");
  assertEquals(await lake.query("SELECT v FROM game ORDER BY id"), [{ v: 0 }, { v: 2 }]);
  await writer.write(new TextEncoder().encode("COMMIT;\n"));
  await writer.close();
  assert((await older.status).success);
  assertEquals(await psql(pg.url, "SELECT count(*), max(txid) FROM game"), stamped);
  await eventually(async () => (await seen()) === "4");
  await lake.attach();
  await lake.hold(["game"], await lake.fingerprint(["game"]));
  await lake.detach();
  assertEquals(await lake.query("SELECT v FROM game ORDER BY id"), [{ v: 1 }, { v: 2 }]);
});

pgTest("the fingerprint sees a TRUNCATE", async () => {
  // TRUNCATE moves none of the tuple counters, so a fingerprint of them alone
  // kept a lake copy of rows the table no longer held.
  await using pg = await postgres();
  await psql(pg.url, "CREATE TABLE game (id int PRIMARY KEY); INSERT INTO game VALUES (1)");
  const lake = await Lake.open(pg.url, await Deno.makeTempDir());
  const seen = async () => {
    await lake.attach();
    try {
      return await lake.fingerprint(["game"]);
    } finally {
      await lake.detach();
    }
  };
  await eventually(async () => JSON.parse(await seen())[0][0] === "1");
  const before = await seen();
  await psql(pg.url, "TRUNCATE game");
  await eventually(async () => (await seen()) !== before, 5);
});

pgTest("reads are copied from one snapshot", async () => {
  await using pg = await postgres();
  await psql(pg.url, "CREATE TABLE a (id int); CREATE TABLE b (id int); INSERT INTO a VALUES (1); INSERT INTO b VALUES (1)");
  const lake = await Lake.open(pg.url, await Deno.makeTempDir());
  await lake.attach();
  await lake.hold(["a"], await lake.fingerprint(["a"]));
  await lake.hold(["b"], await lake.fingerprint(["b"]));
  assertEquals(lake.snapshots, 2);
  // Each is current, but from two snapshots: read together, they are copied again.
  await lake.hold(["a", "b"], await lake.fingerprint(["a", "b"]));
  assertEquals(lake.snapshots, 3);
  await lake.hold(["a", "b"], await lake.fingerprint(["a", "b"]));
  await lake.hold(["b"], await lake.fingerprint(["b"]));
  assertEquals(lake.snapshots, 3);
  await lake.detach();
  await assertRejects(() => lake.query("SELECT * FROM pg.public.a"));
});

pgTest("a query answers plain rows", async () => {
  await using pg = await postgres();
  await psql(pg.url, "CREATE TABLE t (id uuid, n text, d date, k timestamptz)");
  await psql(
    pg.url,
    "INSERT INTO t VALUES ('00000000-0000-4000-8000-000000000001', '12', '2026-05-24', '2026-05-24 19:00:00+02')",
  );
  const lake = await Lake.open(pg.url, await Deno.makeTempDir());
  await lake.attach();
  await lake.hold(["t"], await lake.fingerprint(["t"]));
  await lake.detach();
  assertEquals(
    await lake.query(
      "SELECT id, n::BIGINT AS n, n::DECIMAL(5, 1) AS x, d, k, [n::INTEGER] AS l, {'n': n::HUGEINT} AS s FROM t",
    ),
    [{
      id: "00000000-0000-4000-8000-000000000001",
      n: 12,
      x: 12,
      d: "2026-05-24",
      k: "2026-05-24 17:00:00+00",
      l: [12],
      s: { n: 12 },
    }],
  );
  await assertRejects(() => lake.query("SELECT (2::HUGEINT ** 60)::HUGEINT AS big"), RangeError);
});

/** The roles crud switches to and the hook it calls on every request. */
const CRUD = `CREATE ROLE anon NOLOGIN; CREATE ROLE service NOLOGIN;
  CREATE FUNCTION public.app_pre_request() RETURNS void LANGUAGE plpgsql AS $$BEGIN END$$;`;

/** A token as crud reads it; the check reads its claims and never its signature. */
const jwt = (claims: Record<string, unknown>) =>
  `e30.${btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}.x`;

pgTest("a row breaking a constraint writes nothing", async () => {
  await using pg = await postgres();
  await using crud = new Crud();
  await psql(
    pg.url,
    `${CRUD} CREATE TABLE chance (id uuid PRIMARY KEY, percent float8 NOT NULL CHECK (percent <= 100.5));
     CREATE TABLE other (id uuid PRIMARY KEY); GRANT ALL ON chance, other TO anon`,
  );
  const a = "00000000-0000-4000-8000-000000000001";
  const b = "00000000-0000-4000-8000-000000000002";
  await psql(pg.url, `INSERT INTO chance VALUES ('${a}', 1)`);
  const sinks = new Sinks(await Database.open(pg.url, undefined), crud.url, undefined);
  const c = computation("chances", 30, ["game"], ["chance", "other"]);
  await assertRejects(
    () => sinks.apply(c, { other: [{ id: b }], chance: [{ id: b, percent: 50.5 }, { id: a, percent: 101.5 }] }),
    Error,
    "chance_percent_check",
  );
  assertEquals(crud.take(), []);
  // The check rolled its own writes back, and leaves a valid output to crud.
  assertEquals(await psql(pg.url, "SELECT count(*) FROM chance"), "1");
  assertEquals(await psql(pg.url, "SELECT count(*) FROM other"), "0");
  await sinks.apply(c, { other: [], chance: [{ id: b, percent: 50.5 }] });
  assertEquals(crud.take(), [
    ["POST", "/chance?on_conflict=id", [{ id: b, percent: 50.5 }]],
    ["DELETE", `/chance?id=in.("${a}")`, null],
  ]);
  assertEquals(await psql(pg.url, "SELECT count(*) FROM chance"), "1");
});

pgTest("the check deletes after every sink's upserts, as crud does", async () => {
  // Checked a table at a time, deleting a row another sink's upsert stops
  // referencing was refused although crud, upserting every sink first,
  // writes it cleanly.
  await using pg = await postgres();
  await using crud = new Crud();
  const token = jwt({ role: "service" });
  await psql(
    pg.url,
    `${CRUD} CREATE TABLE a (id text PRIMARY KEY);
     CREATE TABLE b (id text PRIMARY KEY, a_id text NOT NULL REFERENCES a (id));
     INSERT INTO a VALUES ('a1'); INSERT INTO b VALUES ('b0', 'a1'); GRANT ALL ON a, b TO service`,
  );
  const sinks = new Sinks(await Database.open(pg.url, token), crud.url, token);
  await sinks.apply(computation("moved", 30, ["game"], ["a", "b"]), { a: [{ id: "a2" }], b: [{ id: "b0", a_id: "a2" }] });
  assertEquals(crud.take(), [
    ["POST", "/a?on_conflict=id", [{ id: "a2" }]],
    ["POST", "/b?on_conflict=id", [{ id: "b0", a_id: "a2" }]],
    ["DELETE", '/a?id=in.("a1")', null],
  ]);
});

pgTest("a sink crud's role cannot write writes nothing", async () => {
  // Checked as the superuser the service connects as, a sink the service role
  // holds no grant on passed the check and failed at crud after other writes.
  await using pg = await postgres();
  await using crud = new Crud();
  const token = jwt({ role: "service" });
  await psql(
    pg.url,
    `${CRUD} CREATE TABLE open (id text PRIMARY KEY); CREATE TABLE locked (id text PRIMARY KEY);
     GRANT ALL ON open TO service; GRANT SELECT ON locked TO service`,
  );
  const sinks = new Sinks(await Database.open(pg.url, token), crud.url, token);
  await assertRejects(
    () => sinks.apply(computation("denied", 30, ["game"], ["open", "locked"]), { open: [{ id: "o" }], locked: [{ id: "l" }] }),
    Error,
    "permission denied",
  );
  assertEquals(crud.take(), []);
});

pgTest("the check runs under the limits crud's role sets", async () => {
  // Crud applies the role's own settings when it switches to it; a check that
  // only switched role ran a write past crud's statement_timeout to the end,
  // and crud then failed it after the other sinks were written.
  await using pg = await postgres();
  await using crud = new Crud();
  const token = jwt({ role: "service" });
  await psql(
    pg.url,
    `${CRUD} CREATE TABLE quick (id text PRIMARY KEY); CREATE TABLE slow (id text PRIMARY KEY);
     CREATE FUNCTION crawl() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(1); RETURN NEW; END$$;
     CREATE TRIGGER crawl BEFORE INSERT ON slow FOR EACH ROW EXECUTE FUNCTION crawl();
     GRANT ALL ON quick, slow TO service; ALTER ROLE service SET statement_timeout = '100ms';
     GRANT service TO postgres`,
  );
  const sinks = new Sinks(await Database.open(pg.url, token), crud.url, token);
  await assertRejects(
    () => sinks.apply(computation("slow", 30, ["game"], ["quick", "slow"]), { quick: [{ id: "q" }], slow: [{ id: "s" }] }),
    Error,
    "statement timeout",
  );
  assertEquals(crud.take(), []);
});

pgTest("the check applies only the role settings crud applies", async () => {
  // Crud (PostgREST 12.2.3) reads a role's cluster-wide settings, not an IN
  // DATABASE one, keeps those its authenticator may set, and sets them before
  // it switches role. Applying every pg_db_role_setting entry as the role
  // threw on a superuser-only one crud skips, and ran under a timeout crud
  // never sets.
  await using pg = await postgres();
  const token = jwt({ role: "service" });
  await psql(
    pg.url,
    `${CRUD} CREATE ROLE authenticator LOGIN NOINHERIT; GRANT service TO authenticator;
     CREATE TABLE t (id text PRIMARY KEY); GRANT ALL ON t TO service;
     CREATE FUNCTION show() RETURNS trigger LANGUAGE plpgsql AS
       $$BEGIN RAISE EXCEPTION 'statement_timeout=%', current_setting('statement_timeout'); END$$;
     CREATE TRIGGER show BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION show();
     ALTER ROLE service SET log_min_duration_statement = 0;
     ALTER ROLE service IN DATABASE postgres SET statement_timeout = '100ms'`,
  );
  const database = await Database.open(pg.url.replace("postgres@", "authenticator@"), token);
  await assertRejects(() => database.check({ t: [[{ id: "x" }], []] }), Error, "statement_timeout=0");
});

pgTest("the check reads the role's settings anew", async () => {
  // Read once when the service started, a timeout set with ALTER ROLE, which
  // crud applies after its config reloads, never reached the check.
  await using pg = await postgres();
  const token = jwt({ role: "service" });
  await psql(
    pg.url,
    `${CRUD} CREATE TABLE slow (id text PRIMARY KEY); GRANT ALL ON slow TO service; GRANT service TO postgres;
     CREATE FUNCTION crawl() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(1); RETURN NEW; END$$;
     CREATE TRIGGER crawl BEFORE INSERT ON slow FOR EACH ROW EXECUTE FUNCTION crawl();`,
  );
  const database = await Database.open(pg.url, token);
  await database.check({ slow: [[{ id: "s" }], []] });
  await psql(pg.url, "ALTER ROLE service SET statement_timeout = '100ms'");
  await assertRejects(() => database.check({ slow: [[{ id: "s" }], []] }), Error, "statement timeout");
});

pgTest("the check runs at the isolation level crud's role sets", async () => {
  // Crud (PostgREST 12.2.3) runs a request's transaction at the role's
  // default_transaction_isolation, else read committed; the check skipped the
  // setting and ran at repeatable read, where DuckDB's postgres scanner
  // begins its transactions.
  await using pg = await postgres();
  const token = jwt({ role: "service" });
  await psql(
    pg.url,
    `${CRUD} CREATE TABLE t (id text PRIMARY KEY); GRANT ALL ON t TO service; GRANT service TO postgres;
     CREATE FUNCTION show() RETURNS trigger LANGUAGE plpgsql AS
       $$BEGIN RAISE EXCEPTION 'isolation=%', current_setting('transaction_isolation'); END$$;
     CREATE TRIGGER show BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION show();`,
  );
  const database = await Database.open(pg.url, token);
  await assertRejects(() => database.check({ t: [[{ id: "x" }], []] }), Error, "isolation=read committed");
  await psql(pg.url, "ALTER ROLE service SET default_transaction_isolation = 'serializable'");
  await assertRejects(() => database.check({ t: [[{ id: "x" }], []] }), Error, "isolation=serializable");
});

// A run, end to end over a WASI command that echoes its stdin.

const uleb = (n: number): number[] => (n < 0x80 ? [n] : [(n & 0x7f) | 0x80, ...uleb(n >>> 7)]);
const vec = (items: number[][]) => [...uleb(items.length), ...items.flat()];
const name = (s: string) => vec([...new TextEncoder().encode(s)].map((b) => [b]));
const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body];
const i32 = (n: number) => [0x41, ...(n < 64 ? [n] : [(n & 0x7f) | 0x80, ...uleb(n >>> 7)])];
const store = (at: number, value: number[]) => [...i32(at), ...value, 0x36, 2, 0];
const load = (at: number) => [...i32(at), 0x28, 2, 0];
// fd_read one iovec of 4 KiB at 16, then fd_write what it read.
const ECHO = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(1, vec([[0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f], [0x60, 0, 0]])),
  ...section(2, vec(["fd_read", "fd_write"].map((f) => [...name("wasi_snapshot_preview1"), ...name(f), 0, 0]))),
  ...section(3, vec([[1]])),
  ...section(5, vec([[0, 1]])),
  ...section(7, vec([[...name("memory"), 2, 0], [...name("_start"), 0, 2]])),
  ...section(10, vec([(() => {
    const body = [
      0,
      ...store(0, i32(16)),
      ...store(4, i32(4096)),
      ...i32(0), ...i32(0), ...i32(1), ...i32(8), 0x10, 0, 0x1a,
      ...store(4, load(8)),
      ...i32(1), ...i32(0), ...i32(1), ...i32(12), 0x10, 1, 0x1a,
      0x0b,
    ];
    return [...uleb(body.length), ...body];
  })()])),
]);

const ROUNDS = `
export const reads = ["game"];
export const queries = { games: "SELECT 1" };
// A job per game, then one more that sums what the first ones wrote.
export const plan = (inputs, seed, outputs) => {
  const first = inputs.games.map((g) => ({ wasm: "echo", input: { id: g.id, seed } }));
  return outputs.length === 0 ? first : [...first, { wasm: "echo", input: outputs.slice(0, first.length).map((o) => o.id) }];
};
export const finish = (inputs, outputs) => ({
  sink: outputs.slice(0, -1).map((o) => ({ id: o.id, seed: o.seed, all: outputs.at(-1).join() })),
});
`;

Deno.test("a run plans in rounds and finishes in job order", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/rounds.js`, ROUNDS);
  await Deno.writeFile(`${dir}/echo.wasm`, ECHO);
  const games = Array.from({ length: 9 }, (_, i) => ({ id: `g${i}` }));
  const reader = { query: async () => games };
  const spec = { name: "rounds", file: `${dir}/rounds.js`, every: 1, to: ["sink"], wasm: [`${dir}/echo.wasm`] };
  const runner = new Runner({ echo: await WebAssembly.compile(ECHO) });
  try {
    const seed = await seedOf("rounds");
    const all = games.map((g) => g.id).join();
    assertEquals(
      await (await Computation.load(spec, runner)).run(reader),
      { sink: games.map((g) => ({ id: g.id, seed, all })) },
    );
  } finally {
    runner.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a failed job ends its run and leaves the runner to the next", async () => {
  // The runner outlives a run, so nothing of a run that failed may answer a
  // job of the next: a job queued behind the failed one, or its reply.
  const runner = new Runner({ echo: await WebAssembly.compile(ECHO) });
  try {
    await assertRejects(
      () => runner.run([{ wasm: "echo", input: "1" }, { wasm: "missing", input: "2" }, { wasm: "echo", input: "3" }]),
      Error,
      "job 1 (missing)",
    );
    assertEquals(await runner.run([{ wasm: "echo", input: "4" }, { wasm: "echo", input: "5" }]), [4, 5]);
  } finally {
    runner.close();
  }
});

Deno.test("a job naming a wasm the computation does not ship fails the run", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/stray.js`, ROUNDS.replace('wasm: "echo", input: { id', 'wasm: "other", input: { id'));
  const runner = new Runner({ echo: await WebAssembly.compile(ECHO) });
  try {
    const c = await Computation.load(
      { name: "stray", file: `${dir}/stray.js`, every: 1, to: ["sink"], wasm: [`${dir}/echo.wasm`] },
      runner,
    );
    await assertRejects(() => c.run({ query: async () => [{ id: "g" }] }), Error, "no {wasm, input} of echo");
  } finally {
    runner.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a plan that changes a job already answered fails the run", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/fickle.js`,
    `export const reads = []; export const queries = {};
     export const plan = (inputs, seed, outputs) =>
       outputs.length === 0 ? [{ wasm: "echo", input: 1 }] : [{ wasm: "echo", input: 2 }, { wasm: "echo", input: 3 }];
     export const finish = () => ({});`,
  );
  const runner = new Runner({ echo: await WebAssembly.compile(ECHO) });
  try {
    const c = await Computation.load(
      { name: "fickle", file: `${dir}/fickle.js`, every: 1, to: [], wasm: [`${dir}/echo.wasm`] },
      runner,
    );
    await assertRejects(() => c.run({ query: async () => [] }), Error, "plan changed the jobs it was answered");
  } finally {
    runner.close();
    await Deno.remove(dir, { recursive: true });
  }
});
