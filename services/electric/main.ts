// Host Electric service: serves Electric's /v1/health and /v1/shape protocol
// over Postgres on the host using mecha-browser's createShapes (LISTEN/NOTIFY
// triggers + pg_current_snapshot), verified by the shape JWT and Caddy's
// ELECTRIC_SECRET.
import postgres from "postgres";
import { createShapes, type ShapesDb } from "../../packages/mecha-browser/shapes.ts";
import { verifyJwt } from "../auth/jwt.ts";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const DATABASE_URL = Deno.env.get("ADMIN_DATABASE_URL") || required("DATABASE_URL");
const ELECTRIC_SECRET = required("ELECTRIC_SECRET");
const JWT_SECRET = required("PGRST_JWT_SECRET");
const PORT = Number(Deno.env.get("PORT") || 3000);

const sql = postgres(DATABASE_URL, {
  max: 8,
  connection: {
    "pgroll.no_inferred_migrations": "TRUE",
  },
});

// Serialize writes/reads on the shape log queue as createShapes expects.
let running = false;
const queue: Array<() => void> = [];
function pump() {
  if (running) return;
  const next = queue.shift();
  if (!next) return;
  running = true;
  next();
}
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push(() => {
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        running = false;
        pump();
      });
    });
    pump();
  });
}

const db: ShapesDb = {
  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const rows = await sql.unsafe(text, params as never[]);
    return { rows: Array.from(rows) as unknown as T[] };
  },
  async exec(text: string): Promise<void> {
    await sql.unsafe(`SET pgroll.no_inferred_migrations TO 'TRUE'; ${text}`);
  },
  async listen(channel: string, onNotify: (payload: string) => void): Promise<() => Promise<void>> {
    const sub = await sql.listen(channel, onNotify);
    return () => sub.unlisten();
  },
};

const pubRows = await sql<{ tablename: string }[]>`
  SELECT tablename
  FROM pg_publication_tables
  WHERE pubname = 'electric_publication_default' AND schemaname = 'public'
  ORDER BY tablename
`;
if (pubRows.length === 0) {
  throw new Error("electric_publication_default has no tables");
}
const tables = pubRows.map((r) => r.tablename);

const shapes = await createShapes({
  db,
  tables,
  serialize,
  fail: (err) => {
    console.error("electric shape log failure:", err);
    Deno.exit(1);
  },
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/v1/health") {
    return json(200, { status: "active" });
  }
  if (req.method === "GET" && url.pathname === "/v1/shape") {
    if (url.searchParams.get("secret") !== ELECTRIC_SECRET) {
      return json(401, { message: "Unauthorized" });
    }
    url.searchParams.delete("secret");
    const cleanReq = new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
      signal: req.signal,
    });
    const auth = req.headers.get("authorization");
    const claims = auth?.startsWith("Bearer ") ? await verifyJwt(JWT_SECRET, auth.slice("Bearer ".length)) : null;
    if (!claims || typeof claims.sub !== "string") {
      return json(401, { message: "Unauthorized" });
    }
    const sub = claims.sub;
    const whereParam = url.searchParams.get("where");
    const keyMatch = whereParam && !whereParam.startsWith("scope_id IN (") && whereParam !== "false"
      ? /^([a-z_][a-z0-9_]{0,62}) = '((?:[^']|'')*)'$/.exec(whereParam)
      : null;
    const shapeKey = keyMatch
      ? { column: keyMatch[1], value: keyMatch[2].replaceAll("''", "'") }
      : undefined;
    const reachOf = async (): Promise<string[]> => {
      if (whereParam === "scope_id IN ('public:')") return ["public:"];
      const rows = await sql<{ s: string[] }[]>`SELECT public.subject_scopes(${sub}) AS s`;
      if (!rows[0]?.s) throw new Error(`subject_scopes returned no scopes for ${sub}`);
      return rows[0].s;
    };
    return await shapes.serve(cleanReq, reachOf, shapeKey);
  }
  return json(404, { error: "not found" });
});
