// Whether an address is one a cluster, its host or its cloud keeps for itself.
// A sink the cluster hosts dials a declared name, and a name can resolve
// anywhere (a wildcard-DNS name such as 10-0-0-5.sslip.io, or one whose owner
// points it at a private address); the mail bridge asks this of the address it
// actually connected, before a byte crosses (mail.ts).

const octets = (a: string): number[] | undefined => {
  const o = a.split(".");
  return o.length === 4 && o.every((x) => /^[0-9]{1,3}$/.test(x) && Number(x) < 256) ? o.map(Number) : undefined;
};

/** The eight 16-bit groups of an IPv6 address, a dotted tail folded in. */
function groups(a: string): number[] | undefined {
  const tail = /:([0-9]+\.[0-9.]+)$/.exec(a);
  const v4 = tail ? octets(tail[1]) : undefined;
  if (tail && v4 === undefined) return undefined;
  const text = v4 ? `${a.slice(0, tail!.index + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}` : a;
  const [left, right, ...more] = text.split("::");
  if (more.length > 0) return undefined;
  const part = (p: string) => (p === "" ? [] : p.split(":").map((h) => (/^[0-9a-f]{1,4}$/i.test(h) ? parseInt(h, 16) : NaN)));
  const l = part(left), r = right === undefined ? [] : part(right);
  const g = right === undefined ? l : [...l, ...Array(8 - l.length - r.length).fill(0), ...r];
  return g.length === 8 && g.every((x) => x >= 0 && x <= 0xffff) ? g : undefined;
}

function inward4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 || // this network, private, loopback, multicast and reserved
    (a === 100 && b >= 64 && b < 128) || // shared address space (carrier NAT)
    (a === 169 && b === 254) || // link-local, where clouds serve instance metadata
    (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168); // private
}

/**
 * Whether an address is one a cluster, its host or its cloud keeps for
 * itself: IPv4's this-network, private, shared (carrier NAT), loopback,
 * link-local, multicast and reserved ranges, and IPv6's loopback, unspecified, unique-local,
 * link-local and multicast, with IPv4-mapped and NAT64 forms read as the IPv4
 * address they carry. The documentation ranges are not among them: nothing
 * routes them, and the cluster smoke stands its stand-in internet on one.
 */
export function inward(address: string): boolean {
  const v4 = octets(address);
  if (v4) return inward4(v4);
  const g = groups(address);
  if (g === undefined) throw new Error(`inward: ${JSON.stringify(address)} is not an address`);
  const embedded = [(g[6] >> 8) & 255, g[6] & 255, g[7] >> 8, g[7] & 255];
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return g[5] === 0 && g[6] === 0 && g[7] <= 1 ? true : inward4(embedded); // ::, ::1, then mapped and compatible
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return inward4(embedded);
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00;
}
