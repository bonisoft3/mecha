import "fake-indexeddb/auto"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createLiveQueryCollection, eq } from "@tanstack/db"
import { createMechaClient } from "./mecha-client.js"
import { fakeElectric } from "./fake-electric.js"

// Its own file: fake-indexeddb is the outbox two clients share, as a page and
// the page reloaded after it do, and it must not reach the other suites.

// Web Locks as a browser grants them: one holder per name, the rest waiting,
// `ifAvailable` answered at once. In-process, so both pages contend for one.
function webLocks() {
  const held = new Map<string, Promise<void>>()
  return {
    async request(name: string, options: { ifAvailable?: boolean }, grant: (lock: unknown) => unknown) {
      if (options.ifAvailable && held.has(name)) return grant(null)
      while (held.has(name)) await held.get(name)
      let release!: () => void
      held.set(name, new Promise<void>((resolve) => (release = resolve)))
      try {
        return await grant({ name })
      } finally {
        held.delete(name)
        release()
      }
    },
  }
}

// A browser page, so the outbox elects its leader as one does: by Web Lock,
// given up on pagehide. A second page that opened while the first still held
// it would never lead, and never replay.
beforeEach(() => {
  vi.stubGlobal("navigator", { userAgent: "test", onLine: true, locks: webLocks() })
  vi.stubGlobal("window", new EventTarget())
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible", hidden: false }))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const schema = { task: { id: { type: "text" }, title: { type: "text" }, txid: { type: "int8" } } }

// Regression: a reader who left before the stream confirmed their delete had
// it replayed on the next page, against a changes-only stream that opened after
// the delete committed. Matching the delete operation in that stream waited for
// a change it could never carry, for 30 s and then again on every retry, and
// the outbox, one transaction at a time, held the next page's writes behind it.
it("confirms a delete replayed after a reload without holding the next page's writes", async () => {
  const server = new Map([["t1", { id: "t1", title: "kept", txid: "1" }]])
  let txid = 1
  const crud = (methods: string[], electric: ReturnType<typeof fakeElectric>) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      if (!url.pathname.startsWith("/crud/")) return electric.fetcher(input, init)
      const method = init?.method ?? "GET"
      methods.push(method)
      txid += 1
      const named = { headers: { "x-txid": String(txid) } }
      if (method === "DELETE") {
        const key = url.searchParams.get("id")!.replace(/^eq\./, "")
        const gone = server.get(key)
        server.delete(key)
        return Response.json(gone === undefined ? [] : [gone], named)
      }
      const row = { ...JSON.parse(String(init?.body)), txid: String(txid) }
      server.set(row.id, row)
      electric.push("task", { operation: "insert", value: row, txid })
      return Response.json([row], { status: 201, ...named })
    }) as typeof fetch
  const page = (methods: string[], electric: ReturnType<typeof fakeElectric>) =>
    createMechaClient({
      tables: [{ id: "task", table: "task", sync: "on-demand" }],
      electricUrl: "http://fake/electric",
      crudUrl: "http://fake/crud",
      authUrl: "http://fake/auth",
      fetcher: crud(methods, electric),
    })

  // The first page deletes the row, and its stream never says so: the reader
  // leaves with the delete still in the outbox.
  const firstMethods: string[] = []
  const first = page(firstMethods, fakeElectric({ schema, rows: { task: [...server.values()] } }))
  await first.ready
  const shown = createLiveQueryCollection({
    query: (q) => q.from({ row: first.collections.task }).where(({ row }) => eq(row.id, "t1")),
  })
  await shown.toArrayWhenReady()
  void first.remove("task", ["t1"])
  await vi.waitFor(() => expect(firstMethods).toEqual(["DELETE"]))
  expect(server.has("t1")).toBe(false)

  // The reader reloads: the page is hidden, which hands its leadership on, and
  // its collections go with it.
  window.dispatchEvent(new Event("pagehide"))
  await shown.cleanup()
  await first.collections.task.cleanup()

  // The reloaded page replays it on a stream that opened after it committed,
  // then writes something of its own.
  const nextMethods: string[] = []
  const next = page(nextMethods, fakeElectric({ schema }))
  await next.ready
  await next.insert("task", [{ id: "t2", title: "next" }])

  expect(nextMethods).toEqual(["DELETE", "POST"])
}, 10_000)
