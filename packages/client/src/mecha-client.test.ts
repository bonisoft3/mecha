import { describe, expect, it, vi } from "vitest"
import { createLiveQueryCollection } from "@tanstack/db"
import { createMechaClient, runsAlone, soleLeader } from "./mecha-client.js"

// Transport and delivery are exercised E2E against a live cluster (todo's
// verify walk); these cover the config-level contracts only.
describe("createMechaClient", () => {
  const client = createMechaClient({
    tables: [{ id: "tasks", table: "task" }],
    electricUrl: "http://localhost:0/electric",
    crudUrl: "http://localhost:0/crud",
    authUrl: "http://localhost:0/auth",
  })

  it("creates one collection per table", () => {
    expect(Object.keys(client.collections)).toEqual(["tasks"])
  })

  it("rejects writes to unknown table ids", () => {
    expect(() => client.insert("nope", [{ id: "x" }])).toThrow(/unknown table id/)
  })

  it("refuses inserts without a client-minted key — retries depend on it", () => {
    expect(() => client.insert("tasks", [{ title: "no id" }])).toThrow(/must mint 'id'/)
  })

  it("tracks a queued sync phase per key", () => {
    expect(client.syncPhase("tasks", "absent")).toBeUndefined()
  })

  // Shapes are the scarce resource: each open one holds a browser connection,
  // and HTTP/1.1 grants about six per origin. Constructing the client must
  // therefore open nothing — a collection stays idle until a region subscribes.
  it("opens no shape until something subscribes", () => {
    expect(client.collections.tasks.status).toBe("idle")
  })

  // And it must let go promptly: a shape held for the library's default idle
  // window (5 minutes) outlives the screen that opened it by long enough to
  // starve the next two screens.
  it("closes an idle shape within one navigation, not five minutes", () => {
    expect((client.collections.tasks as any).config.gcTime).toBe(5_000)
  })
})

// Leader election decides which tab drains the outbox. The library takes Web
// Locks where it exists and otherwise falls back to a BroadcastChannel
// implementation that times its election with `window`, so a runtime with
// BroadcastChannel and neither of the other two rejects `ready` — and, since
// nothing here awaits it, does so as an unhandled rejection that fails the
// file rather than a test.
//
// Reaching that fallback takes two things this suite's runtime denies it: an
// executor only elects anyone once a storage probe finds somewhere to keep the
// outbox, and Node offers `navigator.locks` in any case. Deno offers storage
// when asked and no Web Locks ever, which is why omnishell met this and these
// tests did not. Both halves are staged below.
describe("a runtime with no Web Locks", () => {
  function withStorageAndNoWebLocks() {
    const kv = new Map<string, string>()
    vi.stubGlobal("navigator", { userAgent: "test" })
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => kv.get(k) ?? null,
      setItem: (k: string, v: string) => void kv.set(k, v),
      removeItem: (k: string) => void kv.delete(k),
      key: (i: number) => [...kv.keys()][i] ?? null,
      clear: () => kv.clear(),
      get length() {
        return kv.size
      },
    })
  }

  it("elects nobody and is ready anyway", async () => {
    withStorageAndNoWebLocks()
    try {
      const client = createMechaClient({
        tables: [{ id: "tasks", table: "task" }],
        electricUrl: "http://localhost:0/electric",
        crudUrl: "http://localhost:0/crud",
        authUrl: "http://localhost:0/auth",
      })
      await expect(client.ready).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // Web Locks needs a secure context, so a browser served over plain http —
  // a phone on the LAN, a file:// page — has tabs and no `navigator.locks`.
  // Handing that a leader who always wins puts every open tab on the same
  // outbox at once. It has `window`, and BroadcastChannel arbitrates it.
  it("is not a browser that merely lacks a secure context", () => {
    withStorageAndNoWebLocks()
    try {
      vi.stubGlobal("window", { location: { origin: "http://192.168.1.9" } })
      expect(runsAlone()).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("is a runtime with neither", () => {
    withStorageAndNoWebLocks()
    try {
      expect(runsAlone()).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("is not an ordinary browser either", () => {
    try {
      vi.stubGlobal("navigator", { userAgent: "test", locks: {} })
      vi.stubGlobal("window", { location: { origin: "https://app.example" } })
      expect(runsAlone()).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // The executor replays the outbox on the answer to requestLeadership, and
  // again for anyone its leadership subscriber notifies. A sole leader that
  // announces itself to that subscriber is therefore replayed twice, and the
  // scheduler does not dedupe by id: every queued write is sent a second time.
  it("announces its leadership to nobody", () => {
    let told = 0
    const stop = soleLeader().onLeadershipChange(() => (told += 1))
    expect(told).toBe(0)
    expect(stop).toBeTypeOf("function")
  })
})

// The device tier is a localStorage-backed collection, and a region reads it
// through a live query. @tanstack/db 0.8.1 through 0.8.7 throw `Query
// contributors with the same row key are not congruent` when such a row is
// updated — the engine sees the old and new row as two positive contributors
// for one key. It is why the workspace pins 0.8.0, and this is what says so:
// it passes on 0.8.0 and on everything before it, and fails on the rest.
describe("a device tier under a live query", () => {
  it("carries an update through to the query", async () => {
    const kv = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => kv.get(k) ?? null,
      setItem: (k: string, v: string) => void kv.set(k, v),
      removeItem: (k: string) => void kv.delete(k),
      key: (i: number) => [...kv.keys()][i] ?? null,
      clear: () => kv.clear(),
      get length() {
        return kv.size
      },
    })
    try {
      const client = createMechaClient({
        tables: [{ id: "match", table: "match", durability: "device" }],
        electricUrl: "http://localhost:0/electric",
        crudUrl: "http://localhost:0/crud",
        authUrl: "http://localhost:0/auth",
      })
      const view = createLiveQueryCollection({ query: (q) => q.from({ row: client.collections.match }) })
      view.subscribeChanges(() => {}, { includeInitialState: true })

      await client.insert("match", [{ id: "m1", variant: "mineiro" }])
      await new Promise((r) => setTimeout(r, 60))
      await client.update("match", [{ key: "m1", changes: { variant: "paulista" } }])
      await new Promise((r) => setTimeout(r, 60))

      expect([...view.values()].map((r: any) => r.variant)).toEqual(["paulista"])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// A per-object share reaches a family of tables one row at a time, so those
// collections are unions that can take a shape; every other table is the one
// shape its scope names, and stays the library's own collection.
describe("a shared table's family", () => {
  const client = createMechaClient({
    tables: [
      { id: "note", table: "note", access: { scope: "private", owner: "owner_id", shared: { via: "note_share", on: "note_id", user: "user_id" } } },
      { id: "note_item", table: "note_item", access: { scope: "folder", parent: "note", on: "note_id" } },
      { id: "note_share", table: "note_share", access: { scope: "folder", parent: "note", on: "note_id" } },
      { id: "label", table: "label", access: { scope: "private", owner: "owner_id" } },
    ],
    electricUrl: "http://localhost:0/electric",
    crudUrl: "http://localhost:0/crud",
    authUrl: "http://localhost:0/auth",
    subject: () => "u1",
  })

  it("is a union over the shared table, its grant table and its compositions", () => {
    for (const id of ["note", "note_item", "note_share"]) {
      expect(typeof (client.collections[id].utils as any).add, id).toBe("function")
    }
    expect((client.collections.label.utils as any).add).toBeUndefined()
  })

  // The grant list opens for the first reader that has a subject. Counting
  // the first reader instead would leave a client built before sign-in with
  // readers and no list, whatever the sign-in that follows.
  it("opens the grant list once a subject exists, whichever reader that is", async () => {
    let me: string | null = null
    const opened: string[] = []
    const late = createMechaClient({
      tables: [
        { id: "note", table: "note", access: { scope: "private", owner: "owner_id", shared: { via: "note_share", on: "note_id", user: "user_id" } } },
        { id: "note_share", table: "note_share", access: { scope: "folder", parent: "note", on: "note_id" } },
      ],
      electricUrl: "http://localhost:0/electric",
      crudUrl: "http://localhost:0/crud",
      authUrl: "http://localhost:0/auth",
      subject: () => me,
      fetcher: (async (url: any, init: any) => {
        opened.push(JSON.parse(init.body).key?.value ?? "scope")
        return new Response(JSON.stringify({ token: "t", where: "x", expires_in: 900 }), { status: 200 })
      }) as any,
    })
    const first = late.collections.note.subscribeChanges(() => {})
    await new Promise((r) => setTimeout(r, 20))
    expect(opened).not.toContain("u1")
    me = "u1"
    late.collections.note_share.subscribeChanges(() => {})
    await new Promise((r) => setTimeout(r, 20))
    expect(opened).toContain("u1")
    first.unsubscribe()
  })

  it("refuses a family with a member that has no shape to reach it by", () => {
    expect(() =>
      createMechaClient({
        tables: [
          { id: "note", table: "note", access: { scope: "private", owner: "owner_id", shared: { via: "note_share", on: "note_id", user: "user_id" } } },
          { id: "note_share", table: "note_share", durability: "tab", access: { scope: "folder", parent: "note", on: "note_id" } },
        ],
        electricUrl: "http://localhost:0/electric",
        crudUrl: "http://localhost:0/crud",
        authUrl: "http://localhost:0/auth",
      })
    ).toThrow(/cannot be a tab tier/)
    expect(() =>
      createMechaClient({
        tables: [{ id: "note", table: "note", access: { scope: "private", owner: "owner_id", shared: { via: "note_share", on: "note_id", user: "user_id" } } }],
        electricUrl: "http://localhost:0/electric",
        crudUrl: "http://localhost:0/crud",
        authUrl: "http://localhost:0/auth",
      })
    ).toThrow(/not a table of this client/)
  })

  it("opens nothing until something subscribes, union or not", () => {
    for (const id of ["note", "note_item", "label"]) {
      expect(client.collections[id].status, id).toBe("idle")
    }
  })
})

