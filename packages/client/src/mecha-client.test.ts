import { describe, expect, it } from "vitest"
import { createMechaClient } from "./mecha-client.js"

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

// A per-object share reaches a family of tables one row at a time, so those
// collections are unions that can take a shape; every other table is the one
// shape its scope names, and stays the library's own collection.
describe("a shared table's family", () => {
  const client = createMechaClient({
    tables: [
      { id: "note", table: "note", access: { mode: "owned", owner: "owner_id", shared: { via: "note_share", on: "note_id", user: "user_id" } } },
      { id: "note_item", table: "note_item", access: { mode: "through", parent: "note", on: "note_id" } },
      { id: "note_share", table: "note_share", access: { mode: "through", parent: "note", on: "note_id" } },
      { id: "label", table: "label", access: { mode: "owned", owner: "owner_id" } },
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
        { id: "note", table: "note", access: { mode: "owned", owner: "owner_id", shared: { via: "note_share", on: "note_id", user: "user_id" } } },
        { id: "note_share", table: "note_share", access: { mode: "through", parent: "note", on: "note_id" } },
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
          { id: "note", table: "note", access: { mode: "owned", owner: "owner_id", shared: { via: "note_share", on: "note_id", user: "user_id" } } },
          { id: "note_share", table: "note_share", durability: "tab", access: { mode: "through", parent: "note", on: "note_id" } },
        ],
        electricUrl: "http://localhost:0/electric",
        crudUrl: "http://localhost:0/crud",
        authUrl: "http://localhost:0/auth",
      })
    ).toThrow(/cannot be a tab tier/)
    expect(() =>
      createMechaClient({
        tables: [{ id: "note", table: "note", access: { mode: "owned", owner: "owner_id", shared: { via: "note_share", on: "note_id", user: "user_id" } } }],
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

