// A tick's key, shared by the ticker and the edge object's clock
// (packages/mecha-edge/src/clock.ts), which sweeps one-shot schedules without
// the ticker's cron reader.
// mecha's own namespace for tick keys. Fixed forever: changing it would make
// every schedule owe its whole history again.
const TICK_NAMESPACE = "ae72b8e0-46f3-4bba-907c-646629b08839";

/** RFC 4122 name-based UUIDv5, on the platform's own SHA-1. */
export async function uuid5(namespace: string, name: string): Promise<string> {
  const ns = Uint8Array.from(
    namespace.replaceAll("-", "").match(/../g)!.map((h) => parseInt(h, 16)),
  );
  const bytes = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + bytes.length);
  input.set(ns);
  input.set(bytes, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The key of a tick, and therefore of the row it emits.
 *
 * Derived rather than random so that a redelivery, a second clock and a
 * retried sweep all write the same row. `tick_at` is normalised first because
 * it arrives from two places — computed here as `…Z`, read back from Postgres
 * as `…+00:00` — and the two must hash alike.
 */
export function tickId(schedule: string, tickAt: string): Promise<string> {
  return uuid5(TICK_NAMESPACE, `${schedule}\n${new Date(tickAt).toISOString()}`);
}
