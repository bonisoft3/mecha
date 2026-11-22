// A multipart/form-data body (RFC 7578), which the airlock encodes for an
// effect that declares `contentType: "multipart/form-data"`: the handler hands
// its parts in the Fetch standard's FormData terms, and the airlock picks the
// boundary, so no part can name it. Bytes cross the cage as the type system's
// `bytes`, canonical base64, or as the content key of a blob the airlock reads
// itself (blobs.ts contentBlob). Both airlocks encode here.

/** The media type an effect declares for a body the airlock encodes. */
export const MULTIPART = "multipart/form-data";

/** One entry of the handler's body: a text field, or a file whose bytes are
 * base64 or a content-addressed blob. `type` is the file's media type,
 * application/octet-stream where it names none, as FormData sends a File
 * without one. */
export type Part =
  | { name: string; value: string }
  | { name: string; filename: string; type?: string; bytes: string }
  | { name: string; filename: string; type?: string; blob: string };

/** A part as the airlock holds it after the check: its own frozen copy, the
 * handler's values read once, a file's base64 already decoded, so nothing the
 * handler does later reaches the encoding. */
type Checked =
  | Readonly<{ name: string; value: string }>
  | Readonly<{ name: string; filename: string; type: string; bytes: Uint8Array }>
  | Readonly<{ name: string; filename: string; type: string; blob: string }>;

const TEXT = ["name", "value"];
const FILE = ["name", "filename", "type"];
// tchar, RFC 9110 §5.6.2.
const TCHAR = new Uint8Array(128);
for (const c of "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz") TCHAR[c.charCodeAt(0)] = 1;

/** Whether `s` is a media type as RFC 9110 §8.3.1 spells it, read in one pass
 * with no backtracking: token "/" token *( OWS ";" OWS [ token "=" ( token /
 * quoted-string ) ] ), OWS being SP or HTAB, visible ASCII otherwise, so no
 * CTL reaches the part's header, a CR or LF least of all. */
export function mediaType(s: string): boolean {
  const n = s.length;
  let i = 0;
  const tchar = (at: number) => {
    const c = s.charCodeAt(at);
    return c < 128 && TCHAR[c] === 1;
  };
  const token = () => {
    const from = i;
    while (i < n && tchar(i)) i++;
    return i > from;
  };
  const ows = () => {
    while (i < n && (s[i] === " " || s[i] === "\t")) i++;
  };
  // qdtext: HTAB, SP, 0x21, 0x23-0x5B, 0x5D-0x7E; quoted-pair: "\\" then HTAB, SP or VCHAR.
  const quoted = () => {
    i++;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 0x22) return (i++, true);
      if (c === 0x5c) {
        const d = s.charCodeAt(i + 1);
        if (!(d === 0x09 || d === 0x20 || (d >= 0x21 && d <= 0x7e))) return false;
        i += 2;
      } else if (c === 0x09 || c === 0x20 || c === 0x21 || (c >= 0x23 && c <= 0x5b) || (c >= 0x5d && c <= 0x7e)) i++;
      else return false;
    }
    return false;
  };
  if (!token() || s[i++] !== "/" || !token()) return false;
  while (i < n) {
    ows();
    if (s[i] !== ";") return false;
    i++;
    ows();
    if (i === n || s[i] === ";") continue;
    if (!token() || s[i++] !== "=") return false;
    if (s[i] === '"' ? !quoted() : !token()) return false;
  }
  return true;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const SEXTET = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) SEXTET[ALPHABET.charCodeAt(i)] = i;

/** The bytes canonical base64 spells, or null where `s` is not canonical: the
 * standard alphabet, padded to a multiple of four, `=` only at the end, and
 * the bits padding leaves unused zero, so one string names one byte string.
 * One pass, no regular expression and no spread, whatever the length. */
export function canonicalBase64(s: string): Uint8Array<ArrayBuffer> | null {
  if (s.length % 4 !== 0) return null;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  const at = (i: number) => {
    const c = s.charCodeAt(i);
    return c < 128 ? SEXTET[c] : -1;
  };
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const last = i + 4 === s.length;
    const a = at(i), b = at(i + 1);
    const c = last && pad === 2 ? 0 : at(i + 2);
    const d = last && pad >= 1 ? 0 : at(i + 3);
    if (a < 0 || b < 0 || c < 0 || d < 0) return null;
    if (last && pad === 2 && (b & 0x0f) !== 0) return null;
    if (last && pad === 1 && (c & 0x03) !== 0) return null;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = n >> 16;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

// The WHATWG multipart/form-data encoding: a name's and a text value's line
// breaks become CRLF, then a name's or a filename's CR, LF and quote are
// percent-escaped in the header.
const crlf = (s: string) => s.replace(/\r\n|\r|\n/g, "\r\n");
const escaped = (s: string) => s.replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/"/g, "%22");

/** A boundary no one chose: 32 random hex digits, as unlikely in any part as a
 * browser's. */
export function boundary(): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  return `----mecha${[...random].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The parts `body` names, checked into the airlock's own frozen copies, all
 * before any await: a list of {name, value} or {name, filename, type?, bytes
 * | blob}, each with exactly one of value, bytes and blob, bytes canonical
 * base64. Each of the handler's values is read once, so a getter or a later
 * change cannot put an unchecked value in the encoding. */
export function parts(body: unknown): readonly Checked[] {
  if (!Array.isArray(body)) throw new TypeError(`sink body: a ${MULTIPART} effect sends a list of parts, got ${JSON.stringify(body)}`);
  const length = body.length;
  const out: Checked[] = [];
  for (let i = 0; i < length; i++) {
    const p: unknown = body[i];
    const at = `sink body part ${i}`;
    if (typeof p !== "object" || p === null || Array.isArray(p)) throw new TypeError(`${at}: an object, got ${JSON.stringify(p)}`);
    const keys = Object.keys(p);
    const content = keys.filter((k) => k === "value" || k === "bytes" || k === "blob");
    if (content.length !== 1) throw new TypeError(`${at}: exactly one of value, bytes or blob, got ${content.join(", ") || "none"}`);
    const [kind] = content;
    const allowed = kind === "value" ? TEXT : [...FILE, kind];
    const extra = keys.filter((k) => !allowed.includes(k));
    if (extra.length > 0) throw new TypeError(`${at}: ${kind === "value" ? "a text field is {name, value}" : `a file is {name, filename, type?, ${kind}}`}, got ${extra.join(", ")}`);
    // Only the part's own enumerable fields, as a structured clone carries
    // them into the container's cage: an inherited `type` means nothing on
    // either airlock.
    const own = (k: string): unknown => Object.prototype.propertyIsEnumerable.call(p, k) ? (p as Record<string, unknown>)[k] : undefined;
    const name = own("name");
    if (typeof name !== "string") throw new TypeError(`${at}: name is a string, got ${JSON.stringify(name)}`);
    if (kind === "value") {
      const value = own("value");
      if (typeof value !== "string") throw new TypeError(`${at} (${name}): value is a string, got ${JSON.stringify(value)}`);
      out.push(Object.freeze({ name, value }));
      continue;
    }
    const filename = own("filename");
    if (typeof filename !== "string") throw new TypeError(`${at} (${name}): a file names its filename, a string, got ${JSON.stringify(filename)}`);
    const type = own("type");
    if (type !== undefined && type !== "" && (typeof type !== "string" || !mediaType(type))) {
      throw new TypeError(`${at} (${name}): type is a media type of visible ASCII (RFC 9110), got ${JSON.stringify(type)}`);
    }
    const file = { name, filename, type: (type as string | undefined) || "application/octet-stream" };
    if (kind === "bytes") {
      const text = own("bytes");
      const bytes = typeof text === "string" ? canonicalBase64(text) : null;
      if (bytes === null) throw new TypeError(`${at} (${name}): bytes are canonical base64, the type system's bytes`);
      out.push(Object.freeze({ ...file, bytes }));
    } else {
      const blob = own("blob");
      if (typeof blob !== "string") throw new TypeError(`${at} (${name}): blob is a content key, got ${JSON.stringify(blob)}`);
      out.push(Object.freeze({ ...file, blob }));
    }
  }
  return Object.freeze(out);
}

/**
 * The encoded body and its content type, the boundary in it. `read` hands a
 * blob's bytes by its content key, refusing one the handler may not read; a
 * fresh boundary is picked per call unless one is given.
 */
export async function multipartBody(
  body: unknown,
  read: (key: string) => Promise<Uint8Array>,
  b: string = boundary(),
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
  const checked = parts(body);
  const utf8 = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const p of checked) {
    let head = `--${b}\r\nContent-Disposition: form-data; name="${escaped(crlf(p.name))}"`;
    let content: Uint8Array;
    if ("value" in p) {
      head += "\r\n\r\n";
      content = utf8.encode(crlf(p.value));
    } else {
      head += `; filename="${escaped(p.filename)}"\r\nContent-Type: ${p.type}\r\n\r\n`;
      content = "bytes" in p ? p.bytes : await read(p.blob);
    }
    chunks.push(utf8.encode(head), content, utf8.encode("\r\n"));
  }
  chunks.push(utf8.encode(`--${b}--\r\n`));
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, contentType: `${MULTIPART}; boundary=${b}` };
}
