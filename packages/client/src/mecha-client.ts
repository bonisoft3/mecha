import { createCollection } from "@tanstack/db"
import type { Collection } from "@tanstack/db"
import { electricCollectionOptions } from "@tanstack/electric-db-collection"
import { NonRetriableError, startOfflineExecutor } from "@tanstack/offline-transactions"
import { localOnlyCollectionOptions, localStorageCollectionOptions } from "@tanstack/db"
import { unionCollectionOptions } from "./union.js"

/**
 * Mecha client v2 — the platform's at-least-once data plane for one app.
 *
 * Reads: one Electric-synced TanStack DB collection per table (shape stream,
 * offset-resumable, at-least-once by construction).
 *
 * Writes: durable offline transactions (IndexedDB outbox, leader election,
 * retry-until-delivered) whose mutation functions POST/PATCH/DELETE against
 * PostgREST and then confirm against the shape stream before completing:
 * inserts and updates await the write's txid (the `txid` column every mecha
 * table carries, returned via Prefer: return=representation); deletes confirm
 * against the delete operation itself (see confirmDelete).
 *
 * Retries are idempotent end to end: keys are client-minted, mecha's proxy
 * injects `resolution=ignore-duplicates` on POST, PATCH/DELETE are naturally
 * idempotent by key.
 */

export interface MechaTable {
  /** Collection id (stable across reloads — outbox replay depends on it). */
  id: string
  /** Postgres table name. */
  table: string
  /** Primary key column. */
  key?: string
  /**
   * Where the rows live. "crud" (the default) is an Electric shape over a
   * Postgres table; "tab" is an in-memory collection that survives navigation
   * and nothing else; "device" survives a restart. A local tier has no shape
   * to subscribe and no server to write to, so its mutations never enter the
   * outbox — there is nothing for at-least-once delivery to deliver to.
   */
  durability?: "crud" | "tab" | "device"
  /**
   * The table's row visibility as the app declared it (shell.yaml `access`).
   * Two arms matter here, and they are what the floor cannot deliver: a
   * per-object share on an owned table, and a composition under one. Such a
   * table is reached by a changing set of shapes rather than one.
   */
  access?: TableAccess
}

export type TableAccess =
  | { mode: "owned"; owner: string; shared?: { via: string; on: string; user: string } }
  | { mode: "through"; parent: string; on: string }
  | { mode: "public-read" }
  | { mode: "service-only" }

export interface MechaClientConfig {
  tables: MechaTable[]
  /** Electric endpoint; relative values resolve against the page origin. */
  electricUrl?: string
  /** PostgREST endpoint (mecha's /crud gateway). */
  crudUrl?: string
  /** Bearer token supplier for authed clusters; omit for pre-auth stacks. */
  token?: () => string | null
  /** Injected fetch for tests. */
  fetcher?: typeof fetch
  /** Drop queued transactions older than this many ms (default 7 days). */
  maxTransactionAgeMs?: number
  /** Grace before an unsubscribed collection closes its shape (default 5s). */
  shapeIdleMs?: number
  /**
   * Gatekeeper route prefix, e.g. `/auth` -- endpoints hang off it as
   * `/auth/shape`, because the auth service mounts its routes with that prefix
   * and Caddy does not strip it. Every shape carries a token minted there, and
   * the predicate the mint answers: the proxy admits nothing else.
   */
  authUrl: string
  /** The signed-in subject, which is what a grant is addressed to. */
  subject?: () => string | null
}

// A shape token is re-minted before it dies, not after. Electric holds a live
// request open for 300s, so a token that expires mid-poll costs a reconnect and
// a re-sync; refreshing with more than that left means the swap always lands
// between requests.
const SHAPE_TOKEN_SKEW_MS = 400_000

export type RowKey = { column: string; value: string }

/**
 * Mints and holds one shape token per shape, and answers the two things a
 * shape request carries from it: the header and the predicate.
 *
 * Both are lazy: Electric resolves a function param per request, so nothing
 * is minted for a shape no region ever subscribes, and a refresh is a new
 * header on the next poll rather than a new shape. The predicate is the
 * mint's own string, which is what the gate compares.
 */
function shapeAuthority(authUrl: string, token: (() => string | null) | undefined, fetcher: typeof fetch) {
  type Held = { token: string; where: string; expiresAt: number }
  const held = new Map<string, Held>()
  const inflight = new Map<string, Promise<Held>>()
  const nameOf = (table: string, key?: RowKey) => (key ? `${table}|${key.column}=${key.value}` : table)

  async function mint(table: string, key?: RowKey): Promise<Held> {
    const session = token?.()
    const res = await fetcher(`${authUrl}/shape`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session ? { Authorization: `Bearer ${session}` } : {}),
      },
      body: JSON.stringify({ table, ...(key ? { key } : {}) }),
    })
    if (!res.ok) {
      throw new Error(`shape token refused for ${nameOf(table, key)}: ${res.status}`)
    }
    const body = await res.json()
    const rec: Held = {
      token: body.token,
      where: body.where,
      expiresAt: Date.now() + body.expires_in * 1000,
    }
    held.set(nameOf(table, key), rec)
    return rec
  }

  // One mint per shape in flight. Without this the `where` and the header --
  // two lazy values resolved for the same request -- each start their own.
  function current(table: string, key?: RowKey): Promise<Held> {
    const name = nameOf(table, key)
    const rec = held.get(name)
    if (rec && rec.expiresAt - Date.now() > SHAPE_TOKEN_SKEW_MS) return Promise.resolve(rec)
    let p = inflight.get(name)
    if (!p) {
      p = mint(table, key).finally(() => inflight.delete(name))
      inflight.set(name, p)
    }
    return p
  }

  return {
    authorization: (table: string, key?: RowKey) => async () => `Bearer ${(await current(table, key)).token}`,
    where: (table: string, key?: RowKey) => async () => (await current(table, key)).where,
    /** Drops a held token, so the next request mints. */
    forget: (table: string, key?: RowKey) => void held.delete(nameOf(table, key)),
  }
}

export type SyncPhase = "queued" | "delivered"

/** One row's worth of an update batch: which row, and what changes about it. */
export interface Edit {
  key: string
  changes: Record<string, unknown>
}

export interface MechaClient {
  collections: Record<string, Collection<any, any, any>>
  /** Resolves after storage probe, leader election, and outbox replay. */
  ready: Promise<void>
  /**
   * Every mutation takes a batch, and a single write is a batch of one.
   *
   * The collection behind a table maintains the live queries every region
   * reads it through, and it does that work per CALL, not per row. Offering a
   * singular form invites the loop that makes building a table quadratic in
   * its own size, so there is no singular form to reach for.
   *
   * UPGRADE (@tanstack/db 0.6.17 → 0.8.7): batching fixes the write side of a
   * large table; the read side is still every row of it in the DOM. 0.8.7 ships
   * `live-query-window-controller` and virtual row props, which is the seam for
   * windowing a collection a region draws.
   */
  insert(tableId: string, rows: Record<string, unknown>[]): Promise<void>
  update(tableId: string, edits: Edit[]): Promise<void>
  remove(tableId: string, keys: string[]): Promise<void>
  /** `${tableId}:${key}` → phase while a write is in flight; cleared on delivery. */
  syncPhase(tableId: string, key: string): SyncPhase | undefined
  subscribeSyncPhases(listener: () => void): () => void
}

const DELETE_CONFIRM_TIMEOUT_MS = 30_000

/**
 * A collection opens its Electric shape on its first subscriber and closes it
 * this long after the last one leaves. The window need only outlast one
 * navigation's teardown-then-hydrate gap, so a table both screens show is not
 * resynced from scratch; the connection-scarcity ceiling that caps it is
 * documented with the client tests.
 */
const SHAPE_IDLE_MS = 5_000

function resolveUrl(raw: string): string {
  if (raw.startsWith("/") && typeof window !== "undefined") {
    return window.location.origin + raw
  }
  return raw
}

export function createMechaClient(config: MechaClientConfig): MechaClient {
  const electricUrl = resolveUrl(config.electricUrl ?? "/electric")
  const crudUrl = config.crudUrl ?? "/crud"
  const shapes = shapeAuthority(config.authUrl, config.token, config.fetcher ?? fetch)
  const doFetch = config.fetcher ?? fetch
  const maxAge = config.maxTransactionAgeMs ?? 7 * 24 * 60 * 60 * 1000

  type Table = Required<Omit<MechaTable, "access">> & { access?: TableAccess }
  const byId = new Map<string, Table>()
  for (const t of config.tables) {
    byId.set(t.id, { id: t.id, table: t.table, key: t.key ?? "id", durability: t.durability ?? "crud", access: t.access })
  }

  const phases = new Map<string, SyncPhase>()
  const phaseListeners = new Set<() => void>()
  function setPhase(k: string, phase: SyncPhase | null) {
    if (phase === null) phases.delete(k)
    else phases.set(k, phase)
    phaseListeners.forEach((fn) => fn())
  }

  const gcTime = config.shapeIdleMs ?? SHAPE_IDLE_MS
  // One Electric shape as a collection. Its `where` and its header are the
  // authority's, resolved together per request from one token.
  function shape(t: Table, key?: RowKey) {
    return createCollection({
      // Never startSync: true. Sync begins on the first subscriber, so a
      // screen opens only the shapes its regions actually read.
      gcTime,
      ...electricCollectionOptions({
        id: key ? `mecha:${t.id}@${key.column}=${key.value}` : `mecha:${t.id}`,
        getKey: (item: any) => item[t.key],
        shapeOptions: {
          url: `${electricUrl}/v1/shape`,
          // Typed as a string upstream, resolved as a supplier at runtime like
          // any other param.
          params: { table: t.table, where: shapes.where(t.table, key) as any },
          headers: { Authorization: shapes.authorization(t.table, key) },
          // A refused token is re-minted, not retried: the refresh runs ahead
          // of expiry by a margin, but a machine asleep through it resumes
          // into a 401, and the retry resolves the header afresh. Anything
          // else stops the stream, as it would unhandled.
          onError: (e: any) => {
            if (e?.status === 401) {
              shapes.forget(t.table, key)
              return {}
            }
            throw e
          },
          // int8 (every mecha table's txid) must land as Number, not the
          // client default BigInt: synced rows become mutation originals in
          // the offline outbox, whose JSON serialization has no BigInt path
          // and would throw on every update/delete of a synced row. txids
          // stay far below 2^53, so Number is lossless here.
          parser: { int8: (value: string) => Number(value) },
        },
        // No persistence handlers: writes ride the offline executor below —
        // handlers would tie delivery to the optimistic transaction's
        // lifetime instead of the durable outbox's.
      }),
    } as any)
  }

  // The tables a grant can reach: a shared table, its grant table, and every
  // composition under it. Each is a union of shapes; every other table is
  // the one shape its scope names.
  const byTable = new Map<string, Table>()
  for (const t of byId.values()) byTable.set(t.table, t)
  type Family = { owner: Table; shared: { via: string; on: string; user: string }; via: Table; members: Table[] }
  const families: Family[] = []
  for (const owner of byId.values()) {
    const a = owner.access
    if (a?.mode !== "owned" || a.shared === undefined) continue
    const via = byTable.get(a.shared.via)
    if (via === undefined) {
      throw new Error(`${owner.table} is shared via ${a.shared.via}, which is not a table of this client`)
    }
    // A grant opens one shape per row on the shared table and each
    // composition under it, the edges the emit declares; the grant table
    // takes the grant list, and a per-row shape only if it is a composition.
    const children = [...byId.values()].filter((c) => c.access?.mode === "through" && c.access.parent === owner.table)
    const members = [owner, ...children]
    // A grant reaches a member through a shape, and a local tier has none.
    for (const m of [...members, via]) {
      if (m.durability !== "crud") throw new Error(`${m.table} is reached by a grant and cannot be a ${m.durability} tier`)
    }
    families.push({ owner, shared: a.shared, via, members })
  }
  const reachable = new Set<string>()
  for (const f of families) for (const m of [...f.members, f.via]) reachable.add(m.id)

  const collections: Record<string, Collection<any, any, any>> = {}
  const isLocal = (t: Table) => t.durability === "tab" || t.durability === "device"
  for (const t of byId.values()) {
    if (isLocal(t)) {
      collections[t.id] = createCollection(
        t.durability === "device"
          ? localStorageCollectionOptions({
              id: `mecha:${t.id}`,
              storageKey: `mecha:${t.id}`,
              getKey: (item: any) => item[t.key],
            })
          : localOnlyCollectionOptions({ id: `mecha:${t.id}`, getKey: (item: any) => item[t.key] }),
      )
      continue
    }
    if (!reachable.has(t.id)) {
      collections[t.id] = shape(t)
      continue
    }
    collections[t.id] = createCollection({
      gcTime,
      ...unionCollectionOptions({ id: `mecha:${t.id}`, getKey: (item: any) => item[t.key], base: shape(t) }),
    } as any)
  }

  // A family's reach opens with its first reader and closes with its last:
  // the grant list is a shape over the grant table addressed to the subject,
  // and each grant opens one shape per member, keyed by the row it names.
  // Whichever member a screen reads first opens the whole family, so a
  // composition read alone still arrives.
  for (const { owner, shared, via, members } of families) {
    let readers = 0
    let grants: Collection<any, any, any> | null = null
    let grantSub: { unsubscribe(): void } | null = null
    const opened = new Map<string, Collection<any, any, any>[]>()

    // The column a member's per-row shape is keyed on: the shared table by
    // its key, its grant table by the column naming the row, a composition
    // by its edge to the parent.
    const keyed = (m: Table) => (m === owner ? m.key : (m.access as { on: string }).on)
    const open = (row: string) => {
      if (opened.has(row)) return
      const shapes = members.map((m) => {
        const c = shape(m, { column: keyed(m), value: row })
        ;(collections[m.id].utils as any).add(c)
        return c
      })
      opened.set(row, shapes)
    }
    const close = (row: string) => {
      const shapes = opened.get(row)
      if (!shapes) return
      opened.delete(row)
      members.forEach((m, i) => {
        ;(collections[m.id].utils as any).drop(shapes[i])
        void shapes[i].cleanup()
      })
    }
    // Opened by the first reader that has a subject.
    const acquire = () => {
      readers++
      if (grants !== null) return
      const me = config.subject?.()
      if (!me) return
      grants = shape(via, { column: shared.user, value: me })
      ;(collections[via.id].utils as any).add(grants)
      // A grant names one row; re-pointed, it is a close and an open.
      grantSub = grants.subscribeChanges(
        (changes) => {
          for (const c of changes) {
            const row = String(c.value[shared.on])
            const was = c.previousValue === undefined ? undefined : String(c.previousValue[shared.on])
            if (c.type === "delete") close(row)
            else {
              if (was !== undefined && was !== row) close(was)
              open(row)
            }
          }
        },
        { includeInitialState: true },
      )
    }
    const release = () => {
      if (--readers > 0) return
      grantSub?.unsubscribe()
      grantSub = null
      for (const row of [...opened.keys()]) close(row)
      if (grants) {
        ;(collections[via.id].utils as any).drop(grants)
        void grants.cleanup()
        grants = null
      }
    }
    for (const m of new Set([...members, via])) {
      const c = collections[m.id] as any
      const inner = c.config.sync.sync
      c.config.sync.sync = (params: any) => {
        acquire()
        let stop: () => void
        try {
          stop = inner(params)
        } catch (e) {
          release()
          throw e
        }
        return () => {
          stop()
          release()
        }
      }
    }
  }

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    const token = config.token?.()
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    }
  }

  async function requireOk(res: Response, what: string): Promise<Response> {
    // 4xx = the server rejected the write: retrying cannot help, and the
    // executor must roll back the optimistic state (NonRetriableError is the
    // executor's contract for that). Anything else stays retryable and the
    // outbox keeps trying.
    if (res.ok) return res
    const body = await res.text().catch(() => "")
    const message = `${what} failed: ${res.status} ${body.slice(0, 200)}`
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      throw new NonRetriableError(message)
    }
    throw new Error(message)
  }

  /** Await the write's txid in the shape stream (inserts and updates). */
  async function confirmTxid(collectionId: string, rows: any[]): Promise<void> {
    const txid = rows?.[0]?.txid
    if (txid === undefined || txid === null) return // ignore-duplicates replay: nothing new to await
    await (collections[collectionId] as any).utils.awaitTxId(Number(txid))
  }

  /**
   * Await the key's delete operation in the shape stream. A DELETE response
   * can only carry the row's previous txid, so deletes confirm by matching
   * the operation itself (the package's awaitMatch util).
   */
  async function confirmDelete(collectionId: string, keyColumn: string, key: string): Promise<void> {
    const utils = (collections[collectionId] as any).utils
    await utils.awaitMatch(
      (message: any) =>
        message?.headers?.operation === "delete" &&
        String(message?.value?.[keyColumn] ?? message?.key ?? "") === String(key),
      DELETE_CONFIRM_TIMEOUT_MS,
    )
  }

  // Static per-table mutation function names: outbox replay after a reload
  // looks handlers up by name, so the registry must be derivable from config
  // alone.
  const mutationFns: Record<string, any> = {}
  for (const t of byId.values()) {
    // Local tiers take no mutation handlers — see `durability`.
    if (isLocal(t)) continue
    mutationFns[`insert:${t.id}`] = async ({ transaction, idempotencyKey }: any) => {
      const row = transaction.mutations[0].modified
      const res = await doFetch(`${crudUrl}/${t.table}`, {
        method: "POST",
        headers: headers({ Prefer: "return=representation", "Idempotency-Key": idempotencyKey }),
        body: JSON.stringify(row),
      })
      await requireOk(res, `insert ${t.table}`)
      await confirmTxid(t.id, await res.json().catch(() => []))
      setPhase(`${t.id}:${row[t.key]}`, null)
    }
    mutationFns[`update:${t.id}`] = async ({ transaction }: any) => {
      const m = transaction.mutations[0]
      const key = m.key ?? m.original?.[t.key]
      const res = await doFetch(`${crudUrl}/${t.table}?${t.key}=eq.${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: headers({ Prefer: "return=representation" }),
        body: JSON.stringify(m.changes),
      })
      await requireOk(res, `update ${t.table}`)
      await confirmTxid(t.id, await res.json().catch(() => []))
      setPhase(`${t.id}:${key}`, null)
    }
    mutationFns[`delete:${t.id}`] = async ({ transaction }: any) => {
      const m = transaction.mutations[0]
      const key = m.key ?? m.original?.[t.key]
      const res = await doFetch(`${crudUrl}/${t.table}?${t.key}=eq.${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: headers(),
      })
      await requireOk(res, `delete ${t.table}`)
      await confirmDelete(t.id, t.key, key)
      setPhase(`${t.id}:${key}`, null)
    }
  }

  const executor = startOfflineExecutor({
    collections,
    mutationFns,
    jitter: true,
    beforeRetry: (txs: any[]) => {
      const cutoff = Date.now() - maxAge
      return txs.filter((tx) => tx.createdAt.getTime() > cutoff)
    },
  })

  // A remote batch is one offline transaction over the whole set: one commit,
  // one retry, all of it or none. What it does NOT do is pace itself — a fold
  // that states ten thousand rows against a synced table sends them as one
  // commit and hopes.
  //
  // UPGRADE (@tanstack/db 0.6.17 → 0.8.7): `paced-mutations` is where this
  // belongs. It takes an `onMutate` for the optimistic half, a `mutationFn` for
  // the durable half, and a pluggable `Strategy` (debounce / queue / throttle),
  // which is this function's job done properly and by the library. Moving
  // `run` onto it would also retire the hand-rolled phase bookkeeping below.
  //
  // Two more things the upgrade has to answer for, measured on 0.6.17 with
  // ten thousand rows in a tab collection. A collection keeps its keys in a
  // sorted array and splices per row, so a batch deleting in key order moves
  // half the array per row: 40 ms of a clear, and quadratic in the table. And
  // a local tier's write still builds a transaction, a mutation object and a
  // UUID per row for a collection with nothing to be optimistic against:
  // 33 ms of the same clear. `writeBatch` on the sync side is the door out
  // of the second; the first is the collection's own state.
  function run(mutationFnName: string, phaseKeys: string[], mutate: () => void): Promise<void> {
    for (const phaseKey of phaseKeys) setPhase(phaseKey, "queued")
    // autoCommit off: mutate() would otherwise self-commit and race the
    // explicit commit below into "no longer pending".
    const tx = executor.createOfflineTransaction({ mutationFnName, autoCommit: false })
    tx.mutate(mutate)
    return tx.commit().then(() => undefined)
  }

  return {
    collections,
    ready: executor.waitForInit().then(() => undefined),
    insert(tableId, rows) {
      const t = byId.get(tableId)
      if (!t) throw new Error(`unknown table id: ${tableId}`)
      for (const row of rows) {
        if (row[t.key] === undefined) {
          throw new Error(`insert ${tableId}: caller must mint '${t.key}' — retries depend on it`)
        }
      }
      if (rows.length === 0) return Promise.resolve()
      // One call, whatever the batch's size: the collection recomputes the live
      // queries over this table once for it.
      if (isLocal(t)) return Promise.resolve(void collections[tableId].insert(rows))
      return run(
        `insert:${tableId}`,
        rows.map((row) => `${tableId}:${String(row[t.key])}`),
        () => collections[tableId].insert(rows),
      )
    },
    update(tableId, edits) {
      const t = byId.get(tableId)
      if (!t) throw new Error(`unknown table id: ${tableId}`)
      if (edits.length === 0) return Promise.resolve()
      const keys = edits.map((e) => e.key)
      // The collection hands back one draft per key, in the order asked for, so
      // each edit's changes land on its own row.
      const apply = () =>
        collections[tableId].update(keys, (drafts: any) => {
          const list = Array.isArray(drafts) ? drafts : [drafts]
          list.forEach((draft, i) => Object.assign(draft, edits[i].changes))
        })
      if (isLocal(t)) return Promise.resolve(void apply())
      return run(`update:${tableId}`, keys.map((k) => `${tableId}:${k}`), apply)
    },
    remove(tableId, keys) {
      const t = byId.get(tableId)
      if (!t) throw new Error(`unknown table id: ${tableId}`)
      if (keys.length === 0) return Promise.resolve()
      if (isLocal(t)) return Promise.resolve(void collections[tableId].delete(keys))
      return run(
        `delete:${tableId}`,
        keys.map((k) => `${tableId}:${k}`),
        () => collections[tableId].delete(keys),
      )
    },
    syncPhase(tableId, key) {
      return phases.get(`${tableId}:${key}`)
    },
    subscribeSyncPhases(listener) {
      phaseListeners.add(listener)
      return () => phaseListeners.delete(listener)
    },
  }
}
