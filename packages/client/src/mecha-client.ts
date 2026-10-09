import { createCollection, IR } from "@tanstack/db"
import { ShapeStream } from "@electric-sql/client"
import type { Collection, LoadSubsetOptions } from "@tanstack/db"
import { electricCollectionOptions } from "@tanstack/electric-db-collection"
import { BroadcastChannelLeader, NonRetriableError, startOfflineExecutor, WebLocksLeader } from "@tanstack/offline-transactions"
import type { LeaderElection } from "@tanstack/offline-transactions"
import { localOnlyCollectionOptions, localStorageCollectionOptions } from "@tanstack/db"
import { idempotentSink } from "./sync-sink.js"
import { unionCollectionOptions } from "./union.js"
import { carriers, types } from "./types.js"
import type { CarrierField, Carriers, CarrierTable, TypeField, Types, TypeTable } from "./types.js"
import { createStorageAdapter } from "./storage.js"

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
  /** Field types emitted in shell.schema for this table. */
  fields?: TypeField[]
  /**
   * Where the rows live. "crud" (the default) is an Electric shape over a
   * Postgres table; "tab" is an in-memory collection that survives navigation
   * and nothing else; "device" survives a restart. A local tier has no shape
   * to subscribe and no server to write to, so its mutations never enter the
   * outbox — there is nothing for at-least-once delivery to deliver to.
   */
  durability?: "crud" | "tab" | "device"
  /**
   * The table's row visibility as the app declared it.
   * Two arms matter here, and they are what the floor cannot deliver: a
   * per-object share on an owned table, and a composition under one. Such a
   * table is reached by a changing set of shapes rather than one.
   */
  access?: TableAccess
  /**
   * How the rows arrive. "eager" (the default) syncs the whole shape before
   * the collection is ready; "on-demand" syncs only changes from the moment
   * it opens, and loads the rows each live query asks for as a subset
   * snapshot of the same shape. Only a "crud" table a grant cannot reach can
   * be on demand: a local tier has no shape, and a family is a union of
   * per-row shapes with no single one to take a subset of.
   */
  sync?: "eager" | "on-demand"
}

export type TableAccess =
  | { scope: "private"; owner: string; shared?: { via: string; on: string; user: string } }
  | { scope: "folder"; parent: string; on: string }
  | { scope: "public" }
  | { scope: "internal" }

export interface MechaClientConfig {
  tables: MechaTable[]
  /**
   * The type table the caller was handed. It decides what a canonical value
   * is; this client converts transport spellings into it and holds no
   * definition of its own, so there is nothing to fall back to when it is
   * missing. Absent only where no table declares a field: with
   * no type in play there is nothing to be canonical about.
   */
  types?: TypeTable
  /** Backwards compatibility alias for `types`. */
  carriers?: CarrierTable
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

  async function mint(table: string, key: RowKey | undefined, session: string | null | undefined, name: string): Promise<Held> {
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
    held.set(name, rec)
    return rec
  }

  // One mint per shape in flight. Without this the `where` and the header --
  // two lazy values resolved for the same request -- each start their own.
  function current(table: string, key?: RowKey): Promise<Held> {
    const session = token?.()
    const name = JSON.stringify([session, nameOf(table, key)])
    const rec = held.get(name)
    if (rec && rec.expiresAt - Date.now() > SHAPE_TOKEN_SKEW_MS) return Promise.resolve(rec)
    let p = inflight.get(name)
    if (!p) {
      p = mint(table, key, session, name).finally(() => inflight.delete(name))
      inflight.set(name, p)
    }
    return p
  }

  return {
    authorization: (table: string, key?: RowKey) => async () => `Bearer ${(await current(table, key)).token}`,
    where: (table: string, key?: RowKey) => async () => (await current(table, key)).where,
    /** Drops a held token, so the next request mints. */
    forget: (table: string, key?: RowKey) => void held.delete(JSON.stringify([token?.(), nameOf(table, key)])),
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
  /**
   * Authorized dependency changes, without retaining a table snapshot. The
   * first caught-up position and every shape reset also invalidate reads.
   * Grant families retain their existing authorized union; local tables watch
   * their local collection. Dispose subscriptions before changing accounts;
   * once a grant family has been used, an account change needs a new client.
   */
  subscribeInvalidation(tableId: string, listener: () => void): () => void
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

/**
 * Whether this runtime holds the outbox by itself.
 *
 * Web Locks is secure-context-only, so its absence alone says nothing: a
 * browser on plain http has tabs, has no `navigator.locks`, and arbitrates
 * them over BroadcastChannel perfectly well. It takes the absence of `window`
 * too before a runtime is one the outbox belongs to alone.
 */
export function runsAlone(): boolean {
  const hasWebLocks = typeof navigator !== "undefined" && "locks" in navigator
  return typeof window === "undefined" && !hasWebLocks
}

/**
 * The election a lone process wins by being the only candidate.
 *
 * Leadership is answered once, by `requestLeadership`, and never changes
 * hands.
 */
export function soleLeader(): LeaderElection {
  return {
    requestLeadership: () => Promise.resolve(true),
    releaseLeadership: () => {},
    isLeader: () => true,
    onLeadershipChange: () => () => {},
  }
}

/**
 * The outbox's election, chosen as the executor would choose it, but held
 * here so the page can give it up: a Web Lock held for the page's life keeps
 * the page out of the back/forward cache.
 */
export function electLeader(): LeaderElection {
  if (runsAlone()) return soleLeader()
  if (WebLocksLeader.isSupported()) return new WebLocksLeader()
  if (BroadcastChannelLeader.isSupported()) return new BroadcastChannelLeader()
  return soleLeader()
}

/**
 * An election the page gives up as it is hidden and asks for again when it is
 * restored from the back/forward cache. A restored page's executor replays its
 * outbox once this says it leads again; a page discarded instead has released
 * a lock it would have dropped anyway.
 *
 * It keeps its own state rather than the inner election's: WebLocksLeader
 * marks itself leader before it announces it, so a second acquisition is never
 * announced, and the executor, told it lost on pagehide, would never hear it
 * won back.
 */
export function pageLeader(page: EventTarget, inner: LeaderElection): LeaderElection {
  let leading = false
  const listeners = new Set<(isLeader: boolean) => void>()
  const set = (isLeader: boolean) => {
    if (isLeader === leading) return
    leading = isLeader
    for (const listener of listeners) listener(isLeader)
  }
  inner.onLeadershipChange(set)
  const election: LeaderElection = {
    async requestLeadership() {
      const won = await inner.requestLeadership()
      set(won)
      return won
    },
    releaseLeadership() {
      inner.releaseLeadership()
      set(false)
    },
    isLeader: () => leading,
    onLeadershipChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  page.addEventListener("pagehide", () => election.releaseLeadership())
  page.addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) void election.requestLeadership()
  })
  return election
}

/**
 * electric-db-collection 0.4.0 compiles a two-argument `and`/`or` as `lhs OP
 * rhs` with no parentheses, so an `or` under an `and` binds wrong (`a AND b OR
 * c`). A NOT is always parenthesized, so NOT (NOT (x)) carries every `or` as
 * a group. The pinned-bug test in mecha-client.test.ts fails once an upgrade
 * parenthesizes, which is when this goes.
 */
export function parenthesizeOr(e: IR.BasicExpression<any>): IR.BasicExpression<any> {
  if (e.type !== "func") return e
  const inner = new IR.Func(e.name, e.args.map(parenthesizeOr))
  return e.name === "or" ? new IR.Func("not", [new IR.Func("not", [inner])]) : inner
}

function parenthesizedLoad(opts: LoadSubsetOptions): LoadSubsetOptions {
  return {
    ...opts,
    ...(opts.where ? { where: parenthesizeOr(opts.where) } : {}),
    ...(opts.cursor
      ? { cursor: { ...opts.cursor, whereFrom: parenthesizeOr(opts.cursor.whereFrom), whereCurrent: parenthesizeOr(opts.cursor.whereCurrent) } }
      : {}),
  }
}

export function createMechaClient(config: MechaClientConfig): MechaClient {
  let bound: Types | undefined
  const typeTable = (): Types => {
    const table = config.types ?? config.carriers
    if (table === undefined) throw new Error("no type table was given, and a table declaring fields needs one (`types`)")
    return bound ??= (types ?? carriers)(table)
  }
  const canonicalType = (type: string) => typeTable().canonicalType(type)
  // The SQL type names Electric may report a field's column under: its type's
  // base names and domain, and a decimal's per-profile domain. A field still
  // declared by a physical label is not normalized, so Electric's own parser
  // keeps it.
  const transportNames = (fields: readonly TypeField[]): Set<string> => {
    const table = (config.types ?? config.carriers)!
    const names = new Set<string>()
    for (const field of fields) {
      if (table.aliases[field.type] !== undefined) continue
      const entry = table.types[canonicalType(field.type)]
      for (const name of entry.base) names.add(name)
      if (entry.sql !== undefined) names.add(entry.sql)
      if (field.type === "decimal") names.add(`portable_decimal_${field.precision}_${field.scale}`)
    }
    return names
  }
  // One per table, however many shapes a grant opens of it.
  const parsers = new Map<string, Record<string, (value: string) => string>>()
  const parserOf = (t: { id: string; fields: readonly TypeField[] }) => {
    let parser = parsers.get(t.id)
    if (parser === undefined) {
      parser = Object.fromEntries([...transportNames(t.fields), "int8"].map((name) => [name, (value: string) => value]))
      parsers.set(t.id, parser)
    }
    return parser
  }
  // A table declaring no field declares no type, and a row with nothing to
  // canonicalize asks the type table nothing.
  const normalizeRow: Types["normalizeRow"] = (fields, row, source) =>
    fields.length === 0 ? row : typeTable().normalizeRow(fields, row, source)
  const electricUrl = resolveUrl(config.electricUrl ?? "/electric")
  const crudUrl = config.crudUrl ?? "/crud"
  const shapes = shapeAuthority(config.authUrl, config.token, config.fetcher ?? fetch)
  const doFetch = config.fetcher ?? fetch
  const maxAge = config.maxTransactionAgeMs ?? 7 * 24 * 60 * 60 * 1000

  type Table = Required<Omit<MechaTable, "access">> & { access?: TableAccess }
  const byId = new Map<string, Table>()
  for (const t of config.tables) {
    const durability = t.durability ?? "crud"
    const sync = t.sync ?? "eager"
    if (sync === "on-demand" && durability !== "crud") {
      throw new Error(`${t.table} is a ${durability} tier, which has no shape to load a subset of; it cannot sync on demand`)
    }
    byId.set(t.id, {
      id: t.id,
      table: t.table,
      key: t.key ?? "id",
      fields: t.fields ?? [],
      durability,
      access: t.access,
      sync,
    })
  }

  const phases = new Map<string, SyncPhase>()
  const phaseListeners = new Set<() => void>()
  function setPhase(k: string, phase: SyncPhase | null) {
    if (phase === null) phases.delete(k)
    else phases.set(k, phase)
    phaseListeners.forEach((fn) => fn())
  }

  const gcTime = config.shapeIdleMs ?? SHAPE_IDLE_MS
  const identity = () => config.subject ? config.subject() : config.token?.()
  // Unions and their nested shapes outlive readers; their account cannot be
  // rebound safely while retained rows or optimistic writes still use them.
  let familyAccount: { subject: ReturnType<typeof identity> } | undefined
  function checkFamilyAccount(bind = false) {
    const subject = identity()
    if (familyAccount !== undefined && familyAccount.subject !== subject) {
      throw new Error("grant family outlived its account; create a new client after changing accounts")
    }
    if (bind && familyAccount === undefined) familyAccount = { subject }
  }
  // One Electric shape as a collection. Its `where` and its header are the
  // authority's, resolved together per request from one token.
  function shape(t: Table, key?: RowKey) {
    const getKey = (item: any) => item[t.key]
    const onDemand = t.sync === "on-demand"
    const options = electricCollectionOptions({
      id: key ? `mecha:${t.id}@${key.column}=${key.value}` : `mecha:${t.id}`,
      getKey,
      syncMode: t.sync,
      shapeOptions: {
        url: `${electricUrl}/v1/shape`,
        // Typed as a string upstream, resolved as a supplier at runtime like
        // any other param. An on-demand shape asks for whole rows: a change
        // to a row no subset loaded would otherwise arrive as the columns that
        // changed, and land in the collection as a row missing the rest.
        params: { table: t.table, where: shapes.where(t.table, key) as any, ...(onDemand ? { replica: "full" as const } : {}) },
        headers: { Authorization: shapes.authorization(t.table, key) },
        fetchClient: config.fetcher,
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
        // Every column a field declares arrives as Postgres's text and is
        // converted once, by normalizeRow below, which knows the column. A
        // parser is keyed on the SQL type alone: it cannot tell two decimal
        // profiles apart, nor a string from a timezone that are both `text`.
        // An int8 is not necessarily txid, so it stays text too.
        parser: parserOf(t),
      },
      // No persistence handlers: writes ride the offline executor below —
      // handlers would tie delivery to the optimistic transaction's
      // lifetime instead of the durable outbox's.
    })
    // The shape writes through the sink sync-sink.ts describes: a row's
    // return is an update.
    const inner = options.sync.sync
    // A subset that failed leaves the live query that asked for it waiting
    // with nothing to say why, and TanStack drops the rejection. It is told to
    // whoever listens as it happens and kept nowhere: the failure belongs to
    // the load, and a collection-wide record would fail every later view of
    // the table for one load's sake.
    const failureListeners = new Set<(error: unknown) => void>()
    const utils = options.utils as typeof options.utils & { onSubsetFailure: (fn: (error: unknown) => void) => () => void }
    utils.onSubsetFailure = (fn) => {
      failureListeners.add(fn)
      return () => void failureListeners.delete(fn)
    }
    options.sync.sync = (params) => {
      const sink = idempotentSink(params, getKey)
      // Electric's parsers run per SQL type, while a carrier belongs to a
      // column. Normalize here, where both the message and its field list are
      // present; this is also before a synced row can become an optimistic
      // mutation original or reach the durable outbox.
      const result = inner({
        ...sink,
        write: (message: any) =>
          sink.write(
            message.value === undefined
              ? message
              : { ...message, value: normalizeRow(t.fields, message.value, "electric") },
          ),
      })
      const load = (result as any)?.loadSubset as ((opts: LoadSubsetOptions) => true | Promise<void>) | undefined
      if (!onDemand || load === undefined) return result
      return {
        ...(result as object),
        loadSubset: (opts: LoadSubsetOptions) => {
          const loaded = load(parenthesizedLoad(opts))
          if (loaded === true) return true
          return loaded.catch((error) => {
            // A subset's request carries the stream's header but not its
            // onError, so a refused token is forgotten here as it is there.
            if ((error as { status?: number })?.status === 401) shapes.forget(t.table, key)
            for (const fn of failureListeners) fn(error)
            throw error
          })
        },
      }
    }
    return createCollection({
      // Never startSync: true. Sync begins on the first subscriber, so a
      // screen opens only the shapes its regions actually read.
      gcTime,
      ...options,
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
    if (a?.scope !== "private" || a.shared === undefined) continue
    const via = byTable.get(a.shared.via)
    if (via === undefined) {
      throw new Error(`${owner.table} is shared via ${a.shared.via}, which is not a table of this client`)
    }
    // A grant opens one shape per row on the shared table and each
    // composition under it, the edges the emit declares; the grant table
    // takes the grant list, and a per-row shape only if it is a composition.
    const children = [...byId.values()].filter((c) => c.access?.scope === "folder" && c.access.parent === owner.table)
    const members = [owner, ...children]
    // A grant reaches a member through a shape, and a local tier has none.
    for (const m of [...members, via]) {
      if (m.durability !== "crud") throw new Error(`${m.table} is reached by a grant and cannot be a ${m.durability} tier`)
    }
    families.push({ owner, shared: a.shared, via, members })
  }
  const reachable = new Set<string>()
  for (const f of families) for (const m of [...f.members, f.via]) reachable.add(m.id)
  for (const id of reachable) {
    const t = byId.get(id)!
    if (t.sync === "on-demand") throw new Error(`${t.table} is reached by a grant, a union of per-row shapes; it cannot sync on demand`)
  }

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
      checkFamilyAccount(config.subject?.() != null)
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
  function platformTxid(value: unknown): number {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
      throw new Error(`txid is not an integer: ${String(value)}`)
    }
    const parsed = typeof value === "bigint" ? value : BigInt(value)
    if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`txid is outside JavaScript's safe integer range: ${parsed}`)
    }
    return Number(parsed)
  }

  async function confirmTxid(collectionId: string, rows: any[]): Promise<void> {
    const txid = rows?.[0]?.txid
    if (txid === undefined || txid === null) return // ignore-duplicates replay: nothing new to await
    await (collections[collectionId] as any).utils.awaitTxId(platformTxid(txid))
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
  // Outbox replay has no screen-owned subscriber; its acknowledgement keeps
  // the changes-only shape alive for the network request and its txid.
  const mutationLease = async (tableId: string) => {
    const collection = collections[tableId]
    if (collection.status === "error") {
      throw new Error(`collection ${tableId} cannot acknowledge a mutation while its changefeed is in error`)
    }
    let stopReady = () => {}
    let stopError = () => {}
    let readinessError: Error | undefined
    const ready = collection.isReady()
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
        stopReady = collection.once("status:ready", () => resolve())
        stopError = collection.once("status:error", () => {
          readinessError = new Error(`collection ${tableId} failed while preparing mutation acknowledgement`)
          resolve()
        })
      })
    let subscription: ReturnType<typeof collection.subscribeChanges> | undefined
    try {
      subscription = collection.subscribeChanges(() => {}, { includeInitialState: false })
      await ready
      if (readinessError !== undefined) throw readinessError
      stopReady()
      stopError()
      const active = subscription
      return () => active.unsubscribe()
    } catch (error) {
      stopReady()
      stopError()
      subscription?.unsubscribe()
      throw error
    }
  }
  // PostgREST rejects generated and trigger-managed columns on write.
  const cleanRow = (row: any) => {
    if (!row || typeof row !== "object") return row
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith("$") && k !== "txid" && k !== "scope_id") {
        out[k] = v
      }
    }
    return out
  }
  for (const t of byId.values()) {
    // Local tiers take no mutation handlers — see `durability`.
    if (isLocal(t)) continue
    mutationFns[`insert:${t.id}`] = async ({ transaction, idempotencyKey }: any) => {
      const release = await mutationLease(t.id)
      try {
        const row = transaction.mutations[0].modified
        const res = await doFetch(`${crudUrl}/${t.table}`, {
          method: "POST",
          headers: headers({ Prefer: "return=representation", "Idempotency-Key": idempotencyKey }),
          body: JSON.stringify(cleanRow(row)),
        })
        await requireOk(res, `insert ${t.table}`)
        const returned = await res.json()
        if (!Array.isArray(returned)) throw new Error(`insert ${t.table} returned a non-array representation`)
        await confirmTxid(t.id, returned.map((item) => normalizeRow(t.fields, item, "postgres")))
        setPhase(`${t.id}:${row[t.key]}`, null)
      } finally {
        release()
      }
    }
    mutationFns[`update:${t.id}`] = async ({ transaction }: any) => {
      const release = await mutationLease(t.id)
      try {
        const m = transaction.mutations[0]
        const key = m.key ?? m.original?.[t.key]
        const res = await doFetch(`${crudUrl}/${t.table}?${t.key}=eq.${encodeURIComponent(key)}`, {
          method: "PATCH",
          headers: headers({ Prefer: "return=representation" }),
          body: JSON.stringify(cleanRow(m.changes)),
        })
        await requireOk(res, `update ${t.table}`)
        const returned = await res.json()
        if (!Array.isArray(returned)) throw new Error(`update ${t.table} returned a non-array representation`)
        await confirmTxid(t.id, returned.map((item) => normalizeRow(t.fields, item, "postgres")))
        setPhase(`${t.id}:${key}`, null)
      } finally {
        release()
      }
    }
    mutationFns[`delete:${t.id}`] = async ({ transaction }: any) => {
      const release = await mutationLease(t.id)
      try {
        const m = transaction.mutations[0]
        const key = m.key ?? m.original?.[t.key]
        const res = await doFetch(`${crudUrl}/${t.table}?${t.key}=eq.${encodeURIComponent(key)}`, {
          method: "DELETE",
          headers: headers(),
        })
        await requireOk(res, `delete ${t.table}`)
        await confirmDelete(t.id, t.key, key)
        setPhase(`${t.id}:${key}`, null)
      } finally {
        release()
      }
    }
  }

  const leader = typeof window === "undefined" ? electLeader() : pageLeader(window, electLeader())
  const executor = startOfflineExecutor({
    collections,
    mutationFns,
    storage: createStorageAdapter(),
    jitter: true,
    leaderElection: leader,
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
  // Pacing it here is easy and wrong: splitting the set buys a bounded commit
  // by giving up the all-or-nothing that is the reason to have one. Both at
  // once takes a single request the server applies in a single transaction, so
  // what reopens this is a bulk endpoint on the proxy, not a library.
  //
  // Two costs measured at ten thousand rows in a tab collection, both live on
  // @tanstack/db 0.8.7. A batch deleting in key order splices a shared sorted
  // key array once per row — half the array each time, quadratic in the table,
  // 40 ms of a clear. And a local tier's write mints a UUID and builds a
  // transaction per row for a collection with nothing to be optimistic
  // against: 33 ms of the same clear. The library has the fast path for each —
  // truncate() drops the sorted keys in one assignment, and the sync writer's
  // begin/write/commit skips the optimistic machinery entirely — but both sit
  // inside a SyncConfig.sync belonging to whoever wrote the collection
  // options, and for these rows that is the library: electric's exposes
  // awaitTxId and awaitMatch, local-only's exposes acceptMutations. Either one
  // publishing a truncate or a bulk write reopens this; so would taking over
  // their sync the way union.ts takes over its own.
  function run(mutationFnName: string, phaseKeys: string[], mutate: () => void): Promise<void> {
    for (const phaseKey of phaseKeys) setPhase(phaseKey, "queued")
    // autoCommit off: mutate() would otherwise self-commit and race the
    // explicit commit below into "no longer pending".
    const tx = executor.createOfflineTransaction({ mutationFnName, autoCommit: false })
    tx.mutate(mutate)
    return tx.commit().then(() => undefined)
  }

  type Invalidation = { listeners: Set<() => void>; stop: () => void; ready: boolean; checkScope: () => void }
  const invalidations = new Map<string, Invalidation>()
  function subscribeInvalidation(tableId: string, listener: () => void): () => void {
    const t = byId.get(tableId)
    if (t === undefined) throw new Error(`unknown table id: ${tableId}`)
    if (reachable.has(tableId)) checkFamilyAccount(true)
    let state = invalidations.get(tableId)
    if (state === undefined) {
      const subject = identity()
      const checkScope = () => {
        if (identity() !== subject) throw new Error(`invalidation subscription for ${t.table} outlived its account`)
      }
      state = { listeners: new Set(), stop: () => {}, ready: false, checkScope }
      invalidations.set(tableId, state)
      const active = state
      const publish = () => {
        checkScope()
        for (const fn of active.listeners) fn()
      }
      if (isLocal(t) || reachable.has(tableId)) {
        // Grant families need their authorized per-row shape union. They
        // remain eager independently of server-read invalidation.
        const subscription = collections[tableId].subscribeChanges(publish, { includeInitialState: false })
        let stopped = false
        collections[tableId].onFirstReady(() => {
          if (stopped) return
          active.ready = true
          publish()
        })
        active.stop = () => {
          stopped = true
          subscription.unsubscribe()
        }
      } else {
        const controller = new AbortController()
        const scoped = (value: () => Promise<string>) => async () => {
          checkScope()
          const result = await value()
          checkScope()
          return result
        }
        const stream = new ShapeStream({
          url: `${electricUrl}/v1/shape`,
          log: "changes_only",
          offset: "now",
          params: { table: t.table, where: scoped(shapes.where(t.table)) as any },
          headers: { Authorization: scoped(shapes.authorization(t.table)) },
          fetchClient: config.fetcher,
          signal: controller.signal,
          onError: (error: any) => {
            if (error?.status === 401 && identity() === subject) {
              shapes.forget(t.table)
              return {}
            }
          },
        })
        const unsubscribe = stream.subscribe((messages) => {
          if (controller.signal.aborted) return
          let changed = false
          for (const message of messages) {
            const headers = message.headers
            if (headers.control === "must-refetch") active.ready = false
            if (headers.operation !== undefined) changed = true
            if (headers.control === "up-to-date" && !active.ready) {
              active.ready = true
              changed = true
            }
          }
          if (changed) publish()
        }, (error) => {
          if (controller.signal.aborted) return
          active.stop()
          invalidations.delete(tableId)
          queueMicrotask(() => { throw error })
        })
        active.stop = () => {
          controller.abort()
          unsubscribe()
        }
      }
    }
    state.checkScope()
    // A listener can be reused by callers; each subscription still owns one
    // reference, so stopping one must not detach another.
    const active = state
    const notify = () => listener()
    active.listeners.add(notify)
    if (active.ready) queueMicrotask(() => {
      if (active.listeners.has(notify)) {
        active.checkScope()
        notify()
      }
    })
    return () => {
      active.listeners.delete(notify)
      if (active.listeners.size === 0 && invalidations.get(tableId) === active) {
        invalidations.delete(tableId)
        active.stop()
      }
    }
  }

  return {
    collections,
    subscribeInvalidation,
    ready: executor.waitForInit().then(() => undefined),
    insert(tableId, rows) {
      const t = byId.get(tableId)
      if (!t) throw new Error(`unknown table id: ${tableId}`)
      const normalizedRows = rows.map((row) => normalizeRow(t.fields, row))
      for (const row of normalizedRows) {
        if (row[t.key] === undefined) {
          throw new Error(`insert ${tableId}: caller must mint '${t.key}' — retries depend on it`)
        }
      }
      if (normalizedRows.length === 0) return Promise.resolve()
      // One call, whatever the batch's size: the collection recomputes the live
      // queries over this table once for it.
      if (isLocal(t)) return Promise.resolve(void collections[tableId].insert(normalizedRows))
      return run(
        `insert:${tableId}`,
        normalizedRows.map((row) => `${tableId}:${String(row[t.key])}`),
        () => collections[tableId].insert(normalizedRows),
      )
    },
    update(tableId, edits) {
      const t = byId.get(tableId)
      if (!t) throw new Error(`unknown table id: ${tableId}`)
      if (edits.length === 0) return Promise.resolve()
      const normalizedEdits = edits.map((edit) => ({ ...edit, changes: normalizeRow(t.fields, edit.changes) }))
      const keys = normalizedEdits.map((e) => e.key)
      // The collection hands back one draft per key, in the order asked for, so
      // each edit's changes land on its own row.
      const apply = () =>
        collections[tableId].update(keys, (drafts: any) => {
          const list = Array.isArray(drafts) ? drafts : [drafts]
          list.forEach((draft, i) => Object.assign(draft, normalizedEdits[i].changes))
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
