import { describe, expect, it, vi } from "vitest"
import { createMechaClient } from "./mecha-client.js"

let protocolId = 0
function protocol() {
  const id = ++protocolId
  const requests: { url: URL; authorization: string | null }[] = []
  const mints: { table: string; authorization: string | null; key?: { column: string; value: string } }[] = []
  const waiting: { answer: (body: unknown, status?: number) => void }[] = []
  let handle = 1
  let offset = 0
  let cursor = 0
  let holdInitial = false
  const ready = () => ({ headers: { control: "up-to-date" } })
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const authorization = new Headers(init?.headers).get("authorization")
    if (url.pathname.endsWith("/auth/shape")) {
      const { table, key } = JSON.parse(String(init?.body))
      mints.push({ table, authorization, ...(key ? { key } : {}) })
      return Response.json({ token: `shape-${authorization}`, where: key ? `${key.column} = '${key.value}'` : `owner = '${authorization}'`, expires_in: 900 })
    }
    requests.push({ url, authorization })
    const response = (body: unknown, status = 200) => Response.json(body, { status, headers: {
      "electric-handle": `shape-${id}-${handle}`,
      "electric-offset": `0_${offset}`,
      "electric-schema": JSON.stringify({ id: { type: "text" } }),
      "electric-cursor": String(++cursor),
    } })
    if (url.searchParams.get("live") !== "true" && !holdInitial) return response([ready()])
    return await new Promise<Response>((resolve, reject) => {
      const remove = () => {
        const index = waiting.indexOf(pending)
        if (index >= 0) waiting.splice(index, 1)
        init?.signal?.removeEventListener("abort", aborted)
      }
      const pending = { answer(body: unknown, status = 200) {
        remove()
        resolve(response(body, status))
      } }
      const aborted = () => {
        remove()
        reject(new DOMException("aborted", "AbortError"))
      }
      waiting.push(pending)
      init?.signal?.addEventListener("abort", aborted, { once: true })
      if (init?.signal?.aborted) aborted()
    })
  }
  return {
    fetcher, requests, mints, waiting,
    url: `http://fake-${id}/electric`,
    holdInitial() { holdInitial = true },
    ready() { waiting[0].answer([ready()]) },
    fail(status: number) { waiting[0].answer({ error: "refused" }, status) },
    change(operation: "insert" | "update" | "delete") {
      offset++
      waiting[0].answer([{ key: '"public"."task"/"unloaded"', value: { id: "unloaded" }, headers: { operation } }, ready()])
    },
    send(...messages: unknown[]) {
      offset++
      waiting[0].answer([...messages, ready()])
    },
    reset() {
      handle++
      holdInitial = true
      waiting[0].answer([{ headers: { control: "must-refetch" } }], 409)
    },
  }
}

const client = (server: ReturnType<typeof protocol>, options: { token?: () => string | null; subject?: () => string | null } = {}) => createMechaClient({
  tables: [{ id: "tasks", table: "task" }],
  electricUrl: server.url,
  authUrl: "http://fake/auth",
  fetcher: server.fetcher,
  ...options,
})
const pending = async (server: ReturnType<typeof protocol>) => await vi.waitFor(() => expect(server.waiting).toHaveLength(1))

describe("dependency invalidation", () => {
  it("delivers changes to never-loaded rows without starting or retaining a collection", async () => {
    const server = protocol()
    const c = client(server)
    const wake = vi.fn()
    const stop = c.subscribeInvalidation("tasks", wake)
    try {
      await pending(server)
      expect(wake).toHaveBeenCalledTimes(1)
      expect(server.requests[0].url.searchParams.get("log")).toBe("changes_only")
      expect(server.requests[0].url.searchParams.get("offset")).toBe("now")
      for (const [i, operation] of ["insert", "update", "delete"].entries()) {
        server.change(operation as "insert" | "update" | "delete")
        await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(i + 2))
        await pending(server)
      }
      expect(c.collections.tasks.status).toBe("idle")
      expect(c.collections.tasks.size).toBe(0)
      server.ready()
      await pending(server)
      expect(wake).toHaveBeenCalledTimes(4)
    } finally { stop() }
    expect(server.waiting).toHaveLength(0)
  })

  // A read decides whether a change could move it by testing its own filter
  // on the rows the change named; without them every write to the table, to
  // any row, re-runs every read over it.
  it("hands listeners the changed rows, whole, and nothing when which rows moved is unknown", async () => {
    const server = protocol()
    const c = client(server)
    const wake = vi.fn()
    const stop = c.subscribeInvalidation("tasks", wake)
    try {
      await pending(server)
      expect(server.requests[0].url.searchParams.get("replica")).toBe("full")
      expect(wake).toHaveBeenLastCalledWith(undefined)
      const key = (id: string) => `"public"."task"/"${id}"`
      server.send(
        { key: key("a"), value: { id: "a", team: "x" }, headers: { operation: "insert" } },
        { key: key("b"), value: { id: "b", team: "y" }, old_value: { team: "x" }, headers: { operation: "update" } },
        { key: key("c"), value: { id: "c", team: "z" }, headers: { operation: "delete" } },
      )
      await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2))
      expect(wake).toHaveBeenLastCalledWith([
        { type: "insert", key: key("a"), value: { id: "a", team: "x" } },
        { type: "update", key: key("b"), value: { id: "b", team: "y" }, previousValue: { id: "b", team: "x" } },
        { type: "delete", key: key("c"), previousValue: { id: "c", team: "z" } },
      ])
      await pending(server)
      server.reset()
      await pending(server)
      server.ready()
      await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(3))
      expect(wake).toHaveBeenLastCalledWith(undefined)
    } finally { stop() }
  })

  it("invalidates after initial catch-up and after reset catch-up, closing reads made during either gap", async () => {
    const server = protocol()
    server.holdInitial()
    const c = client(server)
    const wake = vi.fn()
    const stop = c.subscribeInvalidation("tasks", wake)
    try {
      await pending(server)
      expect(wake).not.toHaveBeenCalled()
      server.ready()
      await pending(server)
      expect(wake).toHaveBeenCalledTimes(1)
      server.reset()
      await pending(server)
      expect(wake).toHaveBeenCalledTimes(1)
      expect(server.requests.at(-1)!.url.searchParams.get("log")).toBe("changes_only")
      server.ready()
      await pending(server)
      await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2))
    } finally { stop() }
  })

  it("shares a stream, catches up late subscribers, and aborts only when the final reference leaves", async () => {
    const server = protocol()
    const c = client(server)
    const wake = vi.fn()
    const first = c.subscribeInvalidation("tasks", wake)
    await pending(server)
    const second = c.subscribeInvalidation("tasks", wake)
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2))
    expect(server.mints).toHaveLength(1)
    expect(server.requests.filter(r => r.url.searchParams.get("offset") === "now")).toHaveLength(1)
    first()
    first()
    expect(server.waiting).toHaveLength(1)
    server.change("delete")
    await pending(server)
    expect(wake).toHaveBeenCalledTimes(3)
    second()
    expect(server.waiting).toHaveLength(0)
    const again = c.subscribeInvalidation("tasks", wake)
    try {
      await pending(server)
      expect(server.requests.filter(r => r.url.searchParams.get("offset") === "now")).toHaveLength(2)
      expect(wake).toHaveBeenCalledTimes(4)
    } finally { again() }
  })

  it("uses the authority's predicate and header and never reuses another account's minted token", async () => {
    const server = protocol()
    let account = "alice"
    const c = client(server, { token: () => account, subject: () => account })
    const first = c.subscribeInvalidation("tasks", vi.fn())
    await pending(server)
    expect(server.requests[0].url.searchParams.get("where")).toBe("owner = 'Bearer alice'")
    expect(server.requests[0].authorization).toBe("Bearer shape-Bearer alice")
    account = "bob"
    expect(() => c.subscribeInvalidation("tasks", vi.fn())).toThrow(/outlived its account/)
    first()
    const second = c.subscribeInvalidation("tasks", vi.fn())
    try {
      await pending(server)
      expect(server.mints.map(m => m.authorization)).toEqual(["Bearer alice", "Bearer bob"])
      expect(server.requests.at(-1)!.url.searchParams.get("where")).toBe("owner = 'Bearer bob'")
      expect(server.requests.at(-1)!.authorization).toBe("Bearer shape-Bearer bob")
    } finally { second() }
  })

  it("surfaces terminal stream failures instead of silently leaving reads stale", async () => {
    const server = protocol()
    const c = client(server)
    const errors: unknown[] = []
    const enqueue = globalThis.queueMicrotask
    const intercepted = vi.spyOn(globalThis, "queueMicrotask").mockImplementation(fn => enqueue(() => {
      try { fn() } catch (error) { errors.push(error) }
    }))
    const stop = c.subscribeInvalidation("tasks", vi.fn())
    try {
      await pending(server)
      server.fail(403)
      await vi.waitFor(() => expect(errors).toHaveLength(1))
      expect(errors[0]).toMatchObject({ status: 403 })
      expect(server.waiting).toHaveLength(0)
    } finally {
      stop()
      intercepted.mockRestore()
    }
  })

  it("retains the authorized family union for grant-reachable dependencies", async () => {
    const server = protocol()
    const c = createMechaClient({
      tables: [
        { id: "note", table: "note", access: { scope: "private", owner: "owner_id", shared: { via: "note_share", on: "note_id", user: "user_id" } } },
        { id: "note_share", table: "note_share", access: { scope: "folder", parent: "note", on: "note_id" } },
      ],
      electricUrl: server.url,
      authUrl: "http://fake/auth",
      fetcher: server.fetcher,
      subject: () => null,
    })
    const wake = vi.fn()
    const stop = c.subscribeInvalidation("note", wake)
    try {
      await vi.waitFor(() => expect(wake).toHaveBeenCalled())
      expect(c.collections.note.status).toBe("ready")
      expect(server.requests.every(r => r.url.searchParams.get("log") !== "changes_only")).toBe(true)
      expect(server.mints.map(m => m.table)).toEqual(["note"])
    } finally {
      stop()
      await c.collections.note.cleanup()
    }
  })

  it("keeps local dependencies local", async () => {
    const server = protocol()
    const c = createMechaClient({ tables: [{ id: "drafts", table: "draft", durability: "tab" }], authUrl: "http://fake/auth", fetcher: server.fetcher })
    const wake = vi.fn()
    const stop = c.subscribeInvalidation("drafts", wake)
    try {
      await c.insert("drafts", [{ id: "one" }])
      const calls = wake.mock.calls.length
      await c.remove("drafts", ["one"])
      expect(wake.mock.calls.length).toBeGreaterThan(calls)
      expect(server.requests).toHaveLength(0)
      expect(server.mints).toHaveLength(0)
    } finally { stop() }
  })

  it.each(["invalidation", "collection"])("requires a fresh client after an account used a grant family through %s", async (reader) => {
    const server = protocol()
    let account = "alice"
    let token = "alice-1"
    const makeClient = () => createMechaClient({
      tables: [
        { id: "note", table: "note", access: { scope: "private", owner: "owner_id", shared: { via: "note_share", on: "note_id", user: "user_id" } } },
        { id: "note_share", table: "note_share", access: { scope: "folder", parent: "note", on: "note_id" } },
      ],
      electricUrl: server.url,
      authUrl: "http://fake/auth",
      fetcher: server.fetcher,
      subject: () => account,
      token: () => token,
    })
    const alice = makeClient()
    const first = reader === "invalidation"
      ? alice.subscribeInvalidation("note", vi.fn())
      : (() => {
        const subscription = alice.collections.note.subscribeChanges(() => {})
        return () => subscription.unsubscribe()
      })()
    let stopBob: (() => void) | undefined
    let bob: ReturnType<typeof makeClient> | undefined
    try {
      await vi.waitFor(() => expect(alice.collections.note.isReady()).toBe(true))
      expect(server.mints).toContainEqual({ table: "note_share", authorization: "Bearer alice-1", key: { column: "user_id", value: "alice" } })
      first()
      token = "alice-2"
      const refreshed = alice.subscribeInvalidation("note", vi.fn())
      refreshed()
      expect(alice.collections.note.status).toBe("ready")
      account = "bob"
      token = "bob-1"
      expect(() => alice.subscribeInvalidation("note", vi.fn())).toThrow(/create a new client/)
      expect(() => alice.subscribeInvalidation("note_share", vi.fn())).toThrow(/create a new client/)
      bob = makeClient()
      const wake = vi.fn()
      stopBob = bob.subscribeInvalidation("note", wake)
      await vi.waitFor(() => expect(wake).toHaveBeenCalled())
      expect(server.mints).toContainEqual({ table: "note_share", authorization: "Bearer bob-1", key: { column: "user_id", value: "bob" } })
    } finally {
      first()
      stopBob?.()
      await Promise.all([alice, bob].flatMap(c => c ? Object.values(c.collections).map(collection => collection.cleanup()) : []))
    }
  })
})
