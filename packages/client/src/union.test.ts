import { describe, expect, it } from "vitest"
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { unionCollectionOptions } from "./union.js"

// Sources are in-memory collections: the union mirrors collections, not
// streams, so what Electric does inside a source is not its concern.
function source(id: string, rows: Array<{ id: string; body: string }> = []) {
  const c = createCollection(localOnlyCollectionOptions({ id, getKey: (r: any) => r.id }))
  for (const r of rows) c.insert(r)
  return c
}

function union(base: ReturnType<typeof source>) {
  const c = createCollection({
    gcTime: 60_000,
    ...unionCollectionOptions({ id: `u:${base.id}`, getKey: (r: any) => r.id, base }),
  } as any)
  // A subscriber is what starts the sync, as a region's read would.
  const sub = c.subscribeChanges(() => {})
  return { c, sub }
}

const rows = (c: any) => [...c.entries()].map(([, v]: any) => v.id).sort()

describe("union of shapes", () => {
  it("mirrors the base and becomes ready with it", async () => {
    const base = source("base", [{ id: "a", body: "mine" }])
    const { c } = union(base)
    await c.preload()
    expect(rows(c)).toEqual(["a"])
    expect(c.isReady()).toBe(true)
  })

  it("adds a source's rows while open, and follows its changes", async () => {
    const base = source("base", [{ id: "a", body: "mine" }])
    const { c } = union(base)
    await c.preload()
    const grant = source("grant", [{ id: "x", body: "shared" }])
    ;(c.utils as any).add(grant)
    expect(rows(c)).toEqual(["a", "x"])
    grant.update("x", (d: any) => void (d.body = "edited"))
    expect(c.get("x")?.body).toBe("edited")
    grant.delete("x")
    expect(rows(c)).toEqual(["a"])
  })

  it("dropping a source takes only the rows nobody else delivers", async () => {
    // The owner's scope and a grant can name the same row; revoking the grant
    // must not take a row the scope still shows.
    const base = source("base", [{ id: "a", body: "mine" }])
    const { c } = union(base)
    await c.preload()
    const grant = source("grant", [
      { id: "a", body: "mine" },
      { id: "x", body: "shared" },
    ])
    ;(c.utils as any).add(grant)
    expect(rows(c)).toEqual(["a", "x"])
    ;(c.utils as any).drop(grant)
    expect(rows(c)).toEqual(["a"])
  })

  it("a delete from one source leaves a row another still holds", async () => {
    const base = source("base", [{ id: "a", body: "mine" }])
    const { c } = union(base)
    await c.preload()
    const grant = source("grant", [{ id: "a", body: "mine" }])
    ;(c.utils as any).add(grant)
    grant.delete("a")
    expect(rows(c)).toEqual(["a"])
    base.delete("a")
    expect(rows(c)).toEqual([])
  })

  it("a source added before any subscriber attaches when sync starts", async () => {
    const base = source("base", [{ id: "a", body: "mine" }])
    const grant = source("grant", [{ id: "x", body: "shared" }])
    const c = createCollection({
      gcTime: 60_000,
      ...unionCollectionOptions({ id: "u:late", getKey: (r: any) => r.id, base }),
    } as any)
    ;(c.utils as any).add(grant)
    expect(c.status).toBe("idle")
    c.subscribeChanges(() => {})
    await c.preload()
    expect(rows(c)).toEqual(["a", "x"])
  })

  it("confirms at once when nobody is reading, and asks its sources when someone is", async () => {
    const base: any = source("base")
    base.utils = { awaitTxId: () => new Promise(() => {}) }
    const c = createCollection({
      gcTime: 60_000,
      ...unionCollectionOptions({ id: "u:idle", getKey: (r: any) => r.id, base }),
    } as any)
    await expect((c.utils as any).awaitTxId(1, 50)).resolves.toBe(true)
    c.subscribeChanges(() => {})
    await c.preload()
    const pending = (c.utils as any).awaitTxId(1, 50)
    const raced = await Promise.race([pending, new Promise((r) => setTimeout(() => r("still waiting"), 30))])
    expect(raced).toBe("still waiting")
  })

  it("confirms a write against whichever source sees it", async () => {
    const base = source("base")
    const { c } = union(base)
    await c.preload()
    const seen: any = source("grant")
    seen.utils = { awaitTxId: async (t: number) => t === 7 }
    ;(c.utils as any).add(seen)
    await expect((c.utils as any).awaitTxId(7)).resolves.toBe(true)
    ;(c.utils as any).drop(seen)
    await expect((c.utils as any).awaitTxId(7)).rejects.toThrow(/no source/)
  })
})
