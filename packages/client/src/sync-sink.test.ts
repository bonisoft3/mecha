import { describe, expect, it } from "vitest"
import { createCollection, createTransaction, localOnlyCollectionOptions } from "@tanstack/db"
import { createMechaClient } from "./mecha-client.js"
import { fakeElectric } from "./fake-electric.js"
import { unionCollectionOptions } from "./union.js"

// A write persists until the shape confirms it, and the collection holds
// every synced transaction back while one does. The interleaving under test
// is a key that leaves and returns across two of those held transactions.
function persisting(collection: any, row: any) {
  let release: () => void = () => {}
  const tx = createTransaction({ autoCommit: false, mutationFn: () => new Promise<void>((r) => (release = r)) })
  tx.mutate(() => collection.insert(row))
  const done = tx.commit()
  return { release: () => release(), done }
}

describe("a shape's sink", () => {
  it("takes a row back that left and returned while a write was in flight", async () => {
    const electric = fakeElectric({
      schema: { lobby: { id: { type: "text" }, handle: { type: "text" }, txid: { type: "int8" } } },
      rows: { lobby: [{ id: "k", handle: "one", txid: "1" }] },
    })
    const client = createMechaClient({
      tables: [{ id: "lobby", table: "lobby" }],
      electricUrl: "http://localhost:0/electric",
      crudUrl: "http://localhost:0/crud",
      authUrl: "http://localhost:0/auth",
      fetcher: electric.fetcher,
    })
    // The stream rethrows what its subscriber throws on a microtask, which is
    // how a refused write reaches the page as an uncaught exception.
    const uncaught: unknown[] = []
    const catchAll = (e: unknown) => void uncaught.push(e)
    process.on("uncaughtException", catchAll)
    try {
      const lobby = client.collections.lobby as any
      lobby.subscribeChanges(() => {})
      await lobby.preload()
      expect(lobby.get("k")?.handle).toBe("one")
      const held = persisting(lobby, { id: "j", handle: "me" })
      // The row leaves and returns in two live batches, each a synced
      // transaction the write holds back.
      electric.push("lobby", { operation: "delete", value: { id: "k" }, txid: 2 })
      electric.push("lobby", { operation: "insert", value: { id: "k", handle: "two", txid: "3" }, txid: 3 })
      await lobby.utils.awaitTxId(3)
      expect(lobby.get("k")?.handle).toBe("one")
      held.release()
      await held.done
      expect(uncaught).toEqual([])
      expect(lobby.get("k")?.handle).toBe("two")
      await lobby.cleanup()
    } finally {
      process.off("uncaughtException", catchAll)
    }
  })
})

describe("a union's sink", () => {
  function source(id: string, rows: Array<{ id: string; body: string }> = []) {
    const c = createCollection(localOnlyCollectionOptions({ id, getKey: (r: any) => r.id }))
    for (const r of rows) c.insert(r)
    return c
  }

  it("takes a row back that a source dropped and re-delivered while a write was in flight", async () => {
    const base = source("base", [{ id: "a", body: "one" }])
    const c = createCollection({
      gcTime: 60_000,
      ...unionCollectionOptions({ id: "u:held", getKey: (r: any) => r.id, base }),
    } as any) as any
    c.subscribeChanges(() => {})
    await c.preload()
    const held = persisting(c, { id: "j", body: "me" })
    base.delete("a")
    base.insert({ id: "a", body: "two" })
    held.release()
    await held.done
    expect(c.get("a")?.body).toBe("two")
  })
})
