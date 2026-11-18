// A secret field's sealed values, as the cluster object holds them: in this
// instance's memory and nowhere else, from the write that named them until
// the last effect naming them settles or their time runs out.
//
// A write's values are held before the write reaches the database, since the
// interpreter enqueues the effect at the write's commit and its claim may
// reach the object before the write's answer does. Until the write settles a
// claim waits on it, and then finds the values kept for the rows the write
// landed on alone: one turned away (a conflict, a row the caller may not
// write) keeps nothing, so no caller can hand another reader's row a value.

/** A value kept for a row, and the invocations that claimed it. */
export type Held = { value: string; expires: number; keys: Set<string>; order?: number }

/** A write's value, under every spelling its row may be named by. */
export type Offer = { at: string[]; value: string }

/** Whether 32-bit transaction id `a` committed after `b`, as PostgreSQL
 * compares them: modulo 2^32, so one past the wraparound is the later. */
export function xidAfter(a: number, b: number): boolean {
  const d = ((a - b) % 2 ** 32 + 2 ** 32) % 2 ** 32
  return d !== 0 && d < 2 ** 31
}

export class SealedValues {
  readonly #held = new Map<string, Held>()
  readonly #writing = new Map<string, Promise<void>>()
  readonly #ttlMs: number
  readonly #now: () => number

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs
    this.#now = now
  }

  /** Holds a write's offers back from every claim until the answer it returns
   * is called with the spellings the write landed on (none, where it failed)
   * and the order it committed in (its transaction): of two writes to one
   * row the later commit's value stands, whichever answer came back first. */
  writing(offers: Offer[]): (landed: (at: string) => boolean, order?: number) => Promise<void> {
    const at = [...new Set(offers.flatMap((o) => o.at))]
    const before = Promise.all(at.flatMap((k) => this.#writing.get(k) ?? []))
    let done!: () => void
    const gate = new Promise<void>((resolve) => (done = resolve))
    for (const k of at) this.#writing.set(k, gate)
    return async (landed, order) => {
      try {
        await before
        const now = this.#now()
        this.#expire(now)
        for (const o of offers) {
          for (const k of o.at) {
            if (!landed(k)) continue
            const was = this.#held.get(k)
            if (was?.order !== undefined && order !== undefined && xidAfter(was.order, order)) continue
            this.#held.set(k, { value: o.value, expires: now + this.#ttlMs, keys: new Set(), ...(order === undefined ? {} : { order }) })
          }
        }
      } finally {
        for (const k of at) if (this.#writing.get(k) === gate) this.#writing.delete(k)
        done()
      }
    }
  }

  /** The value kept under `at`, once every write offering one there settled. */
  async take(at: string): Promise<Held | undefined> {
    for (let w = this.#writing.get(at); w !== undefined; w = this.#writing.get(at)) await w
    this.#expire(this.#now())
    return this.#held.get(at)
  }

  entries(): IterableIterator<[string, Held]> {
    return this.#held.entries()
  }

  delete(at: string): void {
    this.#held.delete(at)
  }

  #expire(now: number) {
    for (const [k, v] of this.#held) if (v.expires <= now) this.#held.delete(k)
  }
}
