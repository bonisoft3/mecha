import type { Collection } from "@tanstack/db"

/**
 * One collection over several sources of the same table, each source a shape.
 *
 * A subject's reach over a table is a set of shapes: its scopes, and one per
 * row it was granted (a note shared to it) -- a set that changes while the
 * screen is open. Electric's collection is one shape, so this is the seam: it
 * mirrors every source into itself and lets the set change underneath.
 *
 * A row is present while any source delivers it. Sources over one table can
 * overlap -- the owner's scope and a grant name the same note -- so a delete
 * from one source removes the row only when no other still holds it, and a
 * source dropped whole takes its unshared rows with it.
 */
export interface UnionUtils {
  /** Adds a source; attached at once if the union is syncing, else when it starts. */
  add(source: Collection<any, any, any>): void
  /** Drops a source and the rows only it delivered. The source itself is left to its owner. */
  drop(source: Collection<any, any, any>): void
  /** Resolves when any source has seen the txid; write confirmation reads this. */
  awaitTxId(txid: number, timeout?: number): Promise<boolean>
  awaitMatch(matchFn: (message: any) => boolean, timeout?: number): Promise<boolean>
}

export interface UnionConfig {
  id: string
  getKey: (row: any) => string | number
  /** The source whose readiness is the union's: the subject's scopes over the table. */
  base: Collection<any, any, any>
}

type Sink = {
  collection: Collection<any, any, any>
  begin: () => void
  write: (message: { type: "insert" | "update" | "delete"; value: any }) => void
  commit: () => void
  markReady: () => void
}

export function unionCollectionOptions(config: UnionConfig) {
  const sources = new Set<Collection<any, any, any>>([config.base])
  // Per attached source: its subscription, and what it has delivered by key.
  // The values are kept because a drop writes their deletes, and the union's
  // own view of a row is missing while an optimistic delete of it is pending.
  const attached = new Map<Collection<any, any, any>, { sub: { unsubscribe(): void }; rows: Map<string | number, any> }>()
  // How many sources hold each key, kept as the sets change rather than
  // counted across them per row.
  const holding = new Map<string | number, number>()
  let sink: Sink | null = null

  const holders = (key: string | number) => holding.get(key) ?? 0
  const hold = (mine: Map<string | number, any>, key: string | number, value: any) => {
    if (!mine.has(key)) holding.set(key, holders(key) + 1)
    mine.set(key, value)
  }
  const unhold = (mine: Map<string | number, any>, key: string | number) => {
    if (!mine.delete(key)) return
    const n = holders(key) - 1
    if (n === 0) holding.delete(key)
    else holding.set(key, n)
  }

  function attach(source: Collection<any, any, any>) {
    if (sink === null || attached.has(source)) return
    const out = sink
    const mine = new Map<string | number, any>()
    const sub = source.subscribeChanges(
      (changes) => {
        out.begin()
        for (const c of changes) {
          if (c.type === "delete") {
            unhold(mine, c.key)
            if (holders(c.key) === 0) out.write({ type: "delete", value: c.value })
            continue
          }
          const present = holders(c.key) > 0
          hold(mine, c.key, c.value)
          out.write({ type: present ? "update" : "insert", value: c.value })
        }
        out.commit()
      },
      { includeInitialState: true },
    )
    attached.set(source, { sub, rows: mine })
  }

  function detach(source: Collection<any, any, any>, dropRows: boolean) {
    const entry = attached.get(source)
    if (entry === undefined) return
    attached.delete(source)
    entry.sub.unsubscribe()
    const mine = entry.rows
    const rows = [...mine]
    for (const [key] of rows) unhold(mine, key)
    if (!dropRows || sink === null) return
    const out = sink
    out.begin()
    for (const [key, value] of rows) {
      if (holders(key) === 0) out.write({ type: "delete", value })
    }
    out.commit()
  }

  const utils: UnionUtils = {
    add(source) {
      sources.add(source)
      attach(source)
    },
    drop(source) {
      sources.delete(source)
      detach(source, true)
    },
    // Confirmation is against what is being watched. A union nobody reads
    // has no view to reconcile, and the server has already answered, so a
    // write confirms at once rather than waiting on a shape that is closed.
    // While it is read, whichever source sees the txid answers; a row only a
    // dropped grant delivered is confirmed when that grant's shape reopens,
    // whose snapshot vouches for every earlier transaction.
    awaitTxId(txid, timeout) {
      if (sink === null) return Promise.resolve(true)
      return anyOf([...sources], (s) => (s as any).utils?.awaitTxId?.(txid, timeout))
    },
    awaitMatch(matchFn, timeout) {
      if (sink === null) return Promise.resolve(true)
      return anyOf([...sources], (s) => (s as any).utils?.awaitMatch?.(matchFn, timeout))
    },
  }

  return {
    id: config.id,
    getKey: config.getKey,
    sync: {
      sync: (params: Sink) => {
        sink = params
        for (const s of sources) attach(s)
        if (config.base.isReady()) params.markReady()
        else config.base.onFirstReady(() => params.markReady())
        return () => {
          for (const s of [...attached.keys()]) detach(s, false)
          if (sink === params) sink = null
        }
      },
    },
    utils,
  }
}

// The first source to answer wins; a source that cannot answer is not asked.
// Rejects only when every asked source has, so one timing out does not
// pre-empt another that confirms.
async function anyOf<T>(
  sources: Collection<any, any, any>[],
  ask: (s: Collection<any, any, any>) => Promise<T> | undefined,
): Promise<T> {
  const asked = sources.map(ask).filter((p): p is Promise<T> => p !== undefined)
  if (asked.length === 0) throw new Error("no source to confirm against")
  return await Promise.any(asked)
}
