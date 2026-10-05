// HS256 over WebCrypto for the auth service's tokens, and the shape predicate
// and subset grammar the browser cluster shares: one derivation of a `where`,
// so the CRUD path and the shape path cannot disagree about a subject's reach,
// and one statement of what a subset may say, so the gate and the page's
// cluster admit the same ones.
import { decodeBase64Url, encodeBase64Url } from "jsr:@std/encoding@1.0.7/base64url";

const enc = new TextEncoder();

const keys = new Map<string, Promise<CryptoKey>>();
function key(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (k === undefined) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, k);
  }
  return k;
}

export async function signJwt(secret: string, claims: Record<string, unknown>): Promise<string> {
  const head = encodeBase64Url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = encodeBase64Url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(`${head}.${payload}`)));
  return `${head}.${payload}.${encodeBase64Url(sig)}`;
}

/** The claims a token carries, or null for anything that is not a live token of this secret. */
export async function verifyJwt(secret: string, token: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await key(secret), decodeBase64Url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
    if (typeof claims.exp !== "number") return null;
    if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

/** The `where` a shape may carry, canonical so the gate compares by equality.
 * Built from `subject_scopes`, the same function `app_pre_request` uses for
 * the CRUD path: one derivation, two deliveries, so the paths cannot disagree
 * about a subject's reach without disagreeing here first. */
export function shapeWhere(scopes: string[]): string {
  // `IN ()` is no SQL; a subject with no scope reaches no row.
  if (scopes.length === 0) return "false";
  return `scope_id IN (${scopes.map((s) => `'${s.replaceAll("'", "''")}'`).join(",")})`;
}

// A guard over SQL a machine wrote, not a language anyone writes: an author
// writes PostgREST's filters in markup, and a subset's `where` is what its
// client compiles a view's predicate to from them (electric-db-collection
// 0.4.0's sql-compiler, fed by data-sync.js's
// `clause`, a join's key and a capped view's cursor) and nothing else:
// comparisons of a quoted column with a $n parameter or a literal (a number,
// a string, TRUE or FALSE) and of two such values (the compiler's
// `true = true`), `"col" = ANY($n)`, `"col" IS [NOT] NULL`, TRUE and FALSE,
// under AND, OR, NOT and parentheses. A pattern or a function is no
// view the store maintains (fragment.js routeOf), so it never reaches a
// subset.
//
// Postgres evaluates a subset's predicate in whatever order its planner costs
// it, so on rows the shape's `where` excludes too, and an error the predicate
// raises comes back to the client. So what the grammar admits raises no error
// a row's value decides: a column meets only a value, whose type Postgres
// infers from the column, so it casts the value once or the column to a type
// that holds all of the column's values. Where the request picks the type
// instead, the column is cast to it on every row and raises on a value beyond
// its range: two columns of different numeric types, and a typed literal
// (`"amount" = "float8" '1'` raises on a numeric beyond float8's range).
// Neither parses, nor does arithmetic, a function or a pattern.
const SUBSET_TOKEN = /\s+|"[^"]+"|'(?:[^']|'')*'|\$[1-9][0-9]*|[0-9]+(?:\.[0-9]+)?|<=|>=|<>|!=|[=<>(),]|[A-Za-z_]+/y;
const SUBSET_COMPARE = new Set(["=", "<>", "!=", "<", "<=", ">", ">="]);

/** The parameters a client of a shape synced on demand sends for a subset. */
export const SUBSET_PARAMS = new Set(["subset__where", "subset__params", "subset__order_by", "subset__limit"]);

/** A parameter a shape request carries at one value only. `replica=full`
 * sends an update's unchanged columns too, of a row the token already
 * reaches; an on-demand collection needs it, because a partial update of a
 * row it never loaded would otherwise land as a row missing columns. Any
 * other value is a mode nothing here has weighed. */
export const SHAPE_FIXED_PARAMS: Record<string, string> = { replica: "full" };

/** A subset's `subset__params`, by the position each binds: a JSON object of
 * decimal positions to strings, the compiler's serialization. A position it
 * leaves out is a null it compiled. Undefined where the text is no such
 * object. */
export function subsetParams(text: string | null): Map<number, string> | undefined {
  if (text === null) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const params = new Map<number, string>();
  for (const [k, v] of Object.entries(parsed)) {
    if (!/^[1-9][0-9]*$/.test(k) || typeof v !== "string") return undefined;
    params.set(Number(k), v);
  }
  return params;
}

/** A `where`'s tokens, or null where some text is no token of the grammar. */
function subsetTokens(where: string): string[] | null {
  const tokens: string[] = [];
  SUBSET_TOKEN.lastIndex = 0;
  while (SUBSET_TOKEN.lastIndex < where.length) {
    const at = SUBSET_TOKEN.lastIndex;
    const m = SUBSET_TOKEN.exec(where);
    if (m === null || m.index !== at) return null;
    if (!/^\s+$/.test(m[0])) tokens.push(m[0]);
  }
  return tokens;
}

/** Whether a subset's `where` is one its client's compiler states and no
 * row's value can make fail. */
export function isSubsetWhere(where: string): boolean {
  const tokens = subsetTokens(where);
  if (tokens === null) return false;
  let i = 0;
  const take = (word: string) => {
    if (tokens[i]?.toUpperCase() !== word) return false;
    i += 1;
    return true;
  };
  const column = (t: string | undefined) => t?.startsWith('"') === true;
  const bool = (t: string | undefined) => /^(TRUE|FALSE)$/i.test(t ?? "");
  const value = (t: string | undefined) => /^(\$|'|[0-9])/.test(t ?? "") || bool(t);
  const predicate = (): boolean => {
    const lhs = tokens[i++];
    if (column(lhs) && take("IS")) {
      take("NOT");
      return take("NULL");
    }
    if (column(lhs) && tokens[i] === "=" && tokens[i + 1]?.toUpperCase() === "ANY") {
      i += 2;
      return take("(") && tokens[i++]?.startsWith("$") === true && take(")");
    }
    if (!SUBSET_COMPARE.has(tokens[i])) return bool(lhs);
    const rhs = tokens[++i];
    i += 1;
    return (column(lhs) && value(rhs)) || (value(lhs) && (column(rhs) || value(rhs)));
  };
  const negation = (): boolean => take("NOT") ? negation() : take("(") ? disjunction() && take(")") : predicate();
  const conjunction = (): boolean => {
    if (!negation()) return false;
    while (take("AND")) if (!negation()) return false;
    return true;
  };
  const disjunction = (): boolean => {
    if (!conjunction()) return false;
    while (take("OR")) if (!conjunction()) return false;
    return true;
  };
  return disjunction() && i === tokens.length;
}

/** The `$n` positions a subset's `where` binds; a `$` inside a literal or a
 * quoted name is none. */
export function subsetPositions(where: string): number[] {
  return (subsetTokens(where) ?? []).filter((t) => t.startsWith("$")).map((t) => Number(t.slice(1)));
}

/** A subset's `order_by`: quoted columns, each with its direction and nulls. */
export const SUBSET_ORDER = /^"[^"]+"( (ASC|DESC))?( NULLS (FIRST|LAST))?(,"[^"]+"( (ASC|DESC))?( NULLS (FIRST|LAST))?)*$/;
/** A subset's `limit`: a count. */
export const SUBSET_LIMIT = /^[0-9]+$/;
