import { afterEach, describe, expect, it, vi } from "vitest"
import { createCollection, createTransaction, localOnlyCollectionOptions } from "@tanstack/db"
import { createMechaClient } from "./mecha-client.js"
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
  afterEach(() => vi.unstubAllGlobals())

  // The shape server, as the stream reads it: a snapshot holding the row,
  // then two live batches, its delete and its return. Every later poll hangs.
  function shapeServer(table: string) {
    const schema = JSON.stringify({ id: { type: "text" }, handle: { type: "text" }, txid: { type: "int8" } })
    const batches: Record<string, { offset: string; body: unknown[] }> = {
      "-1": {
        offset: "0_0",
        body: [
          {
            key: `"public"."${table}"/"k"`,
            value: { id: "k", handle: "one", txid: "1" },
            headers: { operation: "insert", txids: [1] },
          },
          { headers: { control: "up-to-date", global_last_seen_lsn: "1" } },
        ],
      },
      "0_0": {
        offset: "1_0",
        body: [
          { key: `"public"."${table}"/"k"`, value: { id: "k" }, headers: { operation: "delete", txids: [2] } },
          { headers: { control: "up-to-date", global_last_seen_lsn: "2" } },
        ],
      },
      "1_0": {
        offset: "2_0",
        body: [
          {
            key: `"public"."${table}"/"k"`,
            value: { id: "k", handle: "two", txid: "3" },
            headers: { operation: "insert", txids: [3] },
          },
          { headers: { control: "up-to-date", global_last_seen_lsn: "3" } },
        ],
      },
    }
    return (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const batch = batches[url.searchParams.get("offset") ?? ""]
      if (batch === undefined) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        })
      }
      return Promise.resolve(
        new Response(JSON.stringify(batch.body), {
          headers: {
            "content-type": "application/json",
            "electric-handle": "h1",
            "electric-offset": batch.offset,
            "electric-schema": schema,
            "electric-cursor": "c1",
          },
        }),
      )
    }
  }

  const mint = () =>
    Promise.resolve(new Response(JSON.stringify({ token: "t", where: "true", expires_in: 3600 }), { status: 200 }))

  it("takes a row back that left and returned while a write was in flight", async () => {
    vi.stubGlobal("fetch", shapeServer("lobby"))
    const client = createMechaClient({
      tables: [{ id: "lobby", table: "lobby" }],
      electricUrl: "http://localhost:0/electric",
      crudUrl: "http://localhost:0/crud",
      authUrl: "http://localhost:0/auth",
      fetcher: mint as any,
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
      // The stream has seen the return; both live batches are committed and
      // waiting on the write.
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
