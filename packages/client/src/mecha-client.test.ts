import { describe, expect, it, vi } from "vitest"
import { and, createCollection, createLiveQueryCollection, eq, or } from "@tanstack/db"
import { electricCollectionOptions } from "@tanstack/electric-db-collection"
import { WebLocksLeader } from "@tanstack/offline-transactions"
import { createMechaClient, type MechaClient, pageLeader, runsAlone, soleLeader } from "./mecha-client.js"
import { fakeElectric } from "./fake-electric.js"

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

// A table stating only the carriers these rows use. It is an input and not a
// definition: what canonical IS belongs to the generator that emits the table a
// client is served, and what is proved here is that this client applies the
// one it was handed — its int64 admits three digits and no more, which no
// program would emit and this client obeys.
const CARRIERS = {
  types: {
    decimal: {
      pg: "numeric",
      column: "domain" as const,
      subset: false,
      base: ["numeric"],
      json: "string" as const,
      pattern: "^(0|-?[1-9][0-9]*|-?(0|[1-9][0-9]*)\\.[0-9]*[1-9])$",
      order: "decimal" as const,
      beyond: ["decimal-profile" as const],
    },
    int64: {
      pg: "bigint",
      column: "domain" as const,
      subset: false,
      sql: "portable_int64",
      base: ["int8"],
      json: "string" as const,
      pattern: "^[0-9]{1,3}$",
      order: "integer" as const,
      beyond: ["int64-range" as const],
    },
  },
  aliases: { bigint: "int64" },
}

describe("carrier rows", () => {
  it("canonicalizes declared writes before an optimistic local collection stores them", async () => {
    const client = createMechaClient({
      carriers: CARRIERS,
      tables: [{
        id: "ledger",
        table: "ledger",
        durability: "tab",
        fields: [
          { name: "amount", type: "decimal", precision: 8, scale: 2 },
          { name: "sequence", type: "int64" },
        ],
      }],
      authUrl: "http://localhost:0/auth",
    })

    await client.insert("ledger", [{ id: "entry", amount: "001.20", sequence: "00042" }])
    expect(client.collections.ledger.toArray[0]).toMatchObject({ id: "entry", amount: "1.2", sequence: "42" })
  })

  it("refuses a value the served table's spelling refuses", async () => {
    const client = createMechaClient({
      carriers: CARRIERS,
      tables: [{ id: "narrow", table: "narrow", durability: "tab", fields: [{ name: "sequence", type: "int64" }] }],
      authUrl: "http://localhost:0/auth",
    })

    await client.insert("narrow", [{ id: "entry", sequence: "42" }])
    expect(client.collections.narrow.toArray[0]).toMatchObject({ id: "entry", sequence: "42" })
    // Refused where the row is read, before anything is optimistic about it.
    expect(() => client.insert("narrow", [{ id: "wide", sequence: "4200" }])).toThrow(/not canonical/)
  })

  it("does not reinterpret an existing physical bigint field", async () => {
    const client = createMechaClient({
      carriers: CARRIERS,
      tables: [{ id: "legacy", table: "legacy", durability: "tab", fields: [{ name: "counter", type: "bigint" }] }],
      authUrl: "http://localhost:0/auth",
    })

    await client.insert("legacy", [{ id: "entry", counter: "00042" }])
    expect(client.collections.legacy.toArray[0]).toMatchObject({ id: "entry", counter: "00042" })
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
// when asked and no Web Locks ever, which is why a Deno consumer met this and
// these tests did not. Both halves are staged below.
// A type with no domain reaches Electric as its base column, and Electric
// names the column by that type in the schema it sends. The row converts the
// same as when every column was a portable_* domain: each value arrives as
// Postgres's text and normalizeRow, which knows the column, converts it once.
describe("rows synced from base-typed columns", () => {
  const BASE = {
    types: {
      string: { pg: "text", column: "plain" as const, subset: true, base: ["text"], json: "string" as const, order: "text" as const, beyond: [] },
      bool: { pg: "boolean", column: "plain" as const, subset: true, base: ["bool"], json: "boolean" as const, order: "boolean" as const, beyond: [] },
      int32: { pg: "integer", column: "plain" as const, subset: true, base: ["int4"], json: "number" as const, min: -2147483648, max: 2147483647, order: "number" as const, beyond: [] },
      double: { pg: "double precision", column: "checked" as const, subset: true, base: ["float8"], json: "number" as const, order: "number" as const, beyond: [] },
      uuid: { pg: "uuid", column: "plain" as const, subset: true, base: ["uuid"], json: "string" as const, order: "text" as const, beyond: [] },
      date: { pg: "date", column: "checked" as const, subset: true, base: ["date"], json: "string" as const, order: "text" as const, beyond: [] },
      timestamp: { pg: "timestamptz", column: "domain" as const, subset: false, sql: "portable_timestamp", base: ["timestamptz"], json: "string" as const, order: "text" as const, beyond: [] },
    },
    aliases: {},
  }

  it("normalizes each value by its field, whatever SQL type Electric names", async () => {
    const electric = fakeElectric({
      schema: {
        game: {
          id: { type: "uuid" }, name: { type: "text" }, done: { type: "bool" }, score: { type: "int4" },
          ratio: { type: "float8" }, day: { type: "date" }, at: { type: "portable_timestamp" }, txid: { type: "int8" },
        },
      },
      rows: {
        game: [{
          id: "8c1f3a56-7e0b-4e3d-9c62-6a6fcb7b4a5e", name: "x", done: "t", score: "-7", ratio: "1.5",
          day: "2026-09-21", at: "2026-09-21 11:00:00.123456+00", txid: "9007199254740993",
        }],
      },
    })
    const client = createMechaClient({
      types: BASE,
      tables: [{
        id: "game", table: "game",
        fields: [
          { name: "id", type: "uuid" }, { name: "name", type: "string" }, { name: "done", type: "bool" },
          { name: "score", type: "int32" }, { name: "ratio", type: "double" }, { name: "day", type: "date" },
          { name: "at", type: "timestamp" },
        ],
      }],
      electricUrl: "http://fake/electric",
      authUrl: "http://fake/auth",
      fetcher: electric.fetcher,
    })
    const game = client.collections.game
    await game.toArrayWhenReady()
    expect(game.toArray[0]).toMatchObject({
      id: "8c1f3a56-7e0b-4e3d-9c62-6a6fcb7b4a5e", name: "x", done: true, score: -7, ratio: 1.5,
      day: "2026-09-21", at: "2026-09-21T11:00:00.123456Z", txid: "9007199254740993",
    })
    await game.cleanup()
  })
})

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

// A collection on demand loads each live query's rows as a subset of its one
// shape. What reaches Electric, and what the collection does with the answer,
// is driven here through a real ShapeStream against fakeElectric.
describe("a table synced on demand", () => {
  const schema = { id: { type: "uuid" }, game_id: { type: "uuid" }, a: { type: "int4" }, b: { type: "int4" }, txid: { type: "int8" } }
  const fields = [{ name: "id", type: "int32" }]
  const TYPES = {
    types: {
      int32: { pg: "integer", column: "plain" as const, subset: true, base: ["int4"], json: "number" as const, min: -2147483648, max: 2147483647, order: "number" as const, beyond: [] },
    },
    aliases: {},
  }
  const where = (row: any) => and(eq(row.game_id, "g1"), or(eq(row.a, 1), eq(row.b, 2)))
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 100; i++) {
      if (cond()) return
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error(`never ${what}`)
  }
  const settledLoad = async (view: any) => {
    view.startSyncImmediate()
    await until(() => view.isReady() && !view.isLoadingSubset, "settled")
  }
  const viewOf = (c: MechaClient, game: string) =>
    createLiveQueryCollection({ query: (q) => q.from({ row: c.collections.player_game }).where(({ row }) => eq(row.game_id, game)) })

  // electric-db-collection 0.4.0 compiles a two-argument `or` under an `and`
  // with no parentheses. This pins that upstream bug, so the day an upgrade
  // parenthesizes it fails, and parenthesizeOr can go.
  it("is sent unparenthesized by electric-db-collection itself", async () => {
    const electric = fakeElectric({ schema: { player_game: schema } })
    const collection = createCollection(electricCollectionOptions({
      id: "pinned", getKey: (r: any) => r.id, syncMode: "on-demand",
      shapeOptions: { url: "http://fake/electric/v1/shape", params: { table: "player_game" }, fetchClient: electric.fetcher },
    }) as any)
    const view = createLiveQueryCollection({ query: (q) => q.from({ row: collection }).where(({ row }) => where(row)) })
    await settledLoad(view)
    expect(new Set(electric.subsets.map((s) => s.where))).toEqual(new Set([`"game_id" = $1 AND "a" = $2 OR "b" = $3`]))
    await view.cleanup()
    await collection.cleanup()
  })

  const client = (electric: ReturnType<typeof fakeElectric>) => createMechaClient({
    types: TYPES,
    tables: [{ id: "player_game", table: "player_game", sync: "on-demand", fields: [] }],
    electricUrl: "http://fake/electric",
    authUrl: "http://fake/auth",
    fetcher: electric.fetcher,
  })

  it("sends every `or` as a group, and asks for whole rows", async () => {
    const electric = fakeElectric({ schema: { player_game: schema } })
    const c = client(electric)
    const view = createLiveQueryCollection({ query: (q) => q.from({ row: c.collections.player_game }).where(({ row }) => where(row)) })
    await settledLoad(view)
    const [subset] = electric.subsets
    expect(subset.where).toBe(`"game_id" = $1 AND NOT (NOT ("a" = $2 OR "b" = $3))`)
    expect(subset.url.searchParams.get("replica")).toBe("full")
    expect(subset.url.searchParams.get("log")).toBe("changes_only")
    await view.cleanup()
  })

  // A subset is a snapshot of the shape at one moment, and the live stream
  // carries every change to the shape from the moment the collection opened.
  // The two must merge without a row going back in time or arriving partial:
  // a change to a row no subset loaded comes whole (replica=full), and a
  // subset loaded after it carries that row at least as new.
  it("merges a late subset with the live stream monotonically", async () => {
    const server = new Map<string, Record<string, string>>()
    const put = (row: Record<string, string>) => server.set(row.id, row)
    for (const [id, game] of [["p1", "g1"], ["p2", "g1"], ["p3", "g2"], ["p4", "g3"], ["p5", "g2"]]) {
      put({ id, game_id: game, a: "0", b: "0", txid: "5" })
    }
    const electric = fakeElectric({ schema: { player_game: schema }, rows: { player_game: [...server.values()] }, xmin: 1 })
    const c = client(electric)
    const seen = new Map<string, bigint[]>()
    const partial: string[] = []
    c.collections.player_game.subscribeChanges((changes: any[]) => {
      for (const ch of changes) {
        if (ch.type === "delete") continue
        const v = ch.value
        if (["id", "game_id", "a", "b", "txid"].some((k) => !(k in v))) partial.push(JSON.stringify(v))
        seen.set(v.id, [...(seen.get(v.id) ?? []), BigInt(v.txid)])
      }
      // Observing, not reading: an initial state would load the whole shape.
    }, { includeInitialState: false })
    const a = viewOf(c, "g1")
    await settledLoad(a)
    expect(a.toArray.map((r: any) => r.id).sort()).toEqual(["p1", "p2"])

    const change = (row: Record<string, string>, txid: number) => {
      const next = { ...row, txid: String(txid) }
      put(next)
      electric.push("player_game", { operation: "update", value: next, txid })
    }
    change({ ...server.get("p1")!, a: "1" }, 10)
    change({ ...server.get("p3")!, a: "1" }, 11)
    change({ ...server.get("p4")!, game_id: "g1" }, 12)
    await until(() => a.toArray.length === 3, "took the moved row in")
    expect(a.toArray.map((r: any) => r.id).sort()).toEqual(["p1", "p2", "p4"])

    const b = viewOf(c, "g2")
    await settledLoad(b)
    change({ ...server.get("p3")!, b: "2" }, 13)
    await until(() => (c.collections.player_game.get("p3") as any)?.txid === "13", "took the last change")

    for (const id of ["p1", "p2", "p3", "p4", "p5"]) {
      const held = c.collections.player_game.get(id) as any
      expect(Object.fromEntries(["id", "game_id", "a", "b", "txid"].map((k) => [k, String(held[k])])), id).toEqual(server.get(id))
      const txids = seen.get(id)!
      expect(txids.every((t, i) => i === 0 || t >= txids[i - 1]), `${id}: ${txids}`).toBe(true)
    }
    expect(b.toArray.map((r: any) => r.id).sort()).toEqual(["p3", "p5"])
    expect(partial).toEqual([])
    await a.cleanup()
    await b.cleanup()
  })

  // Regression: the failure was kept on the collection and never cleared, so
  // one refused subset failed every later view of the table, the same view's
  // retry included, until the page reloaded.
  it("tells a refused subset to its listeners as it happens, and keeps no later load from succeeding", async () => {
    const rows = [{ id: "p1", game_id: "g1", a: "0", b: "0", txid: "5" }, { id: "p3", game_id: "g2", a: "0", b: "0", txid: "5" }]
    const electric = fakeElectric({ schema: { player_game: schema }, rows: { player_game: rows } })
    electric.fail("player_game", [400, { message: "Could not select an operator overload" }])
    const c = client(electric)
    const failures: unknown[] = []
    ;(c.collections.player_game.utils as any).onSubsetFailure((e: unknown) => failures.push(e))
    const refused = viewOf(c, "g1")
    refused.startSyncImmediate()
    await until(() => failures.length > 0, "told the refusal")
    expect(failures.map(String)).toEqual([expect.stringMatching(/400/)])
    const other = viewOf(c, "g2")
    await settledLoad(other)
    expect(other.toArray.map((r: any) => r.id)).toEqual(["p3"])
    const again = viewOf(c, "g1")
    await settledLoad(again)
    expect(again.toArray.map((r: any) => r.id)).toEqual(["p1"])
    expect(failures).toHaveLength(1)
    await refused.cleanup()
    await other.cleanup()
    await again.cleanup()
  })

  it("forgets the shape's token when a subset is refused it, as the stream does", async () => {
    const electric = fakeElectric({ schema: { player_game: schema } })
    electric.fail("player_game", [401, { message: "expired" }])
    let minted = 0
    const sent: string[] = []
    const c = createMechaClient({
      types: TYPES,
      tables: [{ id: "player_game", table: "player_game", sync: "on-demand", fields: [] }],
      electricUrl: "http://fake/electric",
      authUrl: "http://fake/auth",
      fetcher: async (input, init) => {
        if (String(input).endsWith("/auth/shape")) {
          minted += 1
          return new Response(JSON.stringify({ token: `t${minted}`, where: "table player_game", expires_in: 900 }))
        }
        if (new URL(String(input)).searchParams.has("subset__where")) sent.push(new Headers(init?.headers).get("authorization")!)
        return electric.fetcher(input, init)
      },
    })
    const failures: unknown[] = []
    ;(c.collections.player_game.utils as any).onSubsetFailure((e: unknown) => failures.push(e))
    const first = viewOf(c, "g1")
    first.startSyncImmediate()
    await until(() => failures.length > 0, "told the refused token")
    const second = viewOf(c, "g2")
    await settledLoad(second)
    expect(sent[0]).toBe("Bearer t1")
    expect(sent.length).toBeGreaterThan(1)
    expect(sent.slice(1).filter((h) => h === "Bearer t1")).toEqual([])
    await first.cleanup()
    await second.cleanup()
  })

  it("is refused for a table with no single shape", () => {
    for (const durability of ["tab", "device"] as const) {
      expect(() => createMechaClient({ tables: [{ id: "t", table: "t", durability, sync: "on-demand" }], authUrl: "http://fake/auth" }))
        .toThrow(/cannot sync on demand/)
    }
    expect(() => createMechaClient({
      tables: [
        { id: "note", table: "note", sync: "on-demand", access: { scope: "private", owner: "owner_id", shared: { via: "note_share", on: "note_id", user: "user_id" } } },
        { id: "note_share", table: "note_share", access: { scope: "folder", parent: "note", on: "note_id" } },
      ],
      authUrl: "http://fake/auth",
    })).toThrow(/reached by a grant/)
  })
})

// The election holds a Web Lock for as long as it leads, and a page holding
// one is not put in the back/forward cache. Navigator.locks is answered here
// by a lock manager in process, which keeps what the real one would report.
describe("the outbox's leadership across the back/forward cache", () => {
  function locks() {
    const held = new Map<string, () => void>()
    return {
      held,
      async request(name: string, options: any, fn: (lock: unknown) => any) {
        if (options.ifAvailable && held.has(name)) return fn(null)
        if (options.ifAvailable) return fn({ name })
        let release!: () => void
        const done = new Promise<void>((resolve) => { release = resolve })
        held.set(name, release)
        await fn({ name })
        held.delete(name)
        return done
      },
      async query() {
        return { held: [...held.keys()].map((name) => ({ name, mode: "exclusive" })), pending: [] }
      },
    }
  }

  it("releases the lock on pagehide and leads again on a restored pageshow", async () => {
    const manager = locks()
    vi.stubGlobal("navigator", { locks: manager })
    try {
      const page = new EventTarget()
      const leader = pageLeader(page, new WebLocksLeader())
      expect(await leader.requestLeadership()).toBe(true)
      // The executor subscribes once its first request has answered.
      const changes: boolean[] = []
      leader.onLeadershipChange((isLeader) => changes.push(isLeader))
      await new Promise((r) => setTimeout(r, 0))
      expect((await manager.query()).held.length).toBe(1)

      page.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: true }))
      await new Promise((r) => setTimeout(r, 0))
      expect((await manager.query()).held).toEqual([])
      expect(leader.isLeader()).toBe(false)

      // A page loaded afresh is a new client; only a restored one asks back.
      page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }))
      await new Promise((r) => setTimeout(r, 0))
      expect((await manager.query()).held).toEqual([])
      page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }))
      await new Promise((r) => setTimeout(r, 0))
      expect((await manager.query()).held.length).toBe(1)
      expect(leader.isLeader()).toBe(true)
      // The executor replays its outbox on the change to leading.
      expect(changes).toEqual([false, true])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
