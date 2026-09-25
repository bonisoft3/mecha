/// <reference types="vite/client" />
// The engine assets ride the consumer's bundle via ?url imports (same-origin,
// no CDN), so this package is vite-consumed like the rest of the browser
// platform.

import * as duckdb from "@duckdb/duckdb-wasm"
import duckdbWasmUrl from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url"
import duckdbWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url"
import { normalizeLakeRows, typedSql } from "./lake-types.js"
import { types as bindTypes, carriers as bindCarriers } from "@mecha/client/types"
import type { TypeField, Types, TypeTable, CarrierField, Carriers, CarrierTable } from "@mecha/client/types"

/**
 * The engine generation this package boots. The DuckDB that WRITES a
 * published catalog must pair with it: a catalog written by a newer DuckDB
 * storage generation is unreadable here (and vice versa for DuckLake spec
 * versions). Bump the @duckdb/duckdb-wasm dependency and the publish-side
 * duckdb together.
 */
export const DUCKDB_WASM_VERSION = "1.33.1-dev57.0"

export interface LakeEngine {
  db: duckdb.AsyncDuckDB
  conn: duckdb.AsyncDuckDBConnection
  /** Run SQL, rows as plain objects. */
  q: (sql: string, fields?: readonly (TypeField | CarrierField)[]) => Promise<Record<string, unknown>[]>
  /** Explicit name for a type-aware query at a call site. */
  qTyped: (sql: string, fields: readonly (TypeField | CarrierField)[]) => Promise<Record<string, unknown>[]>
}

/** Files a published lake ships, emitted by the publish step's manifest. */
export interface LakeManifest {
  catalog: string
  files: string[]
}

/**
 * The type table decides what a queried value must come out as, so a query
 * that names fields needs one. An engine that only hands its `db` to something
 * else — a terminal, a notebook — names none, and is owed no table.
 */
export async function bootLakeEngine(table?: TypeTable | CarrierTable): Promise<LakeEngine> {
  let bound: Types | undefined
  const boundTypes = () => (bound ??= bindTypes(table as TypeTable))
  // A worker built from fetched source stays interceptable by the page's
  // service worker; importScripts inside a blob worker is not.
  const workerSrc = await (await fetchOk(duckdbWorkerUrl)).text()
  const workerUrl = URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }))
  const db = new duckdb.AsyncDuckDB(
    new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING),
    new Worker(workerUrl),
  )
  // Absolute: the blob worker's base URL has an opaque path, so the
  // root-relative form the bundler emits cannot be parsed inside it.
  await db.instantiate(new URL(duckdbWasmUrl, location.href).href)
  const conn = await db.connect()
  const q = async (sql: string, fields: readonly (TypeField | CarrierField)[] = []) => {
    if (fields.length === 0) {
      return (await conn.query(sql)).toArray().map((r: { toJSON(): Record<string, unknown> }) => r.toJSON())
    }
    const rows = (await conn.query(typedSql(boundTypes().canonicalType, sql, fields)))
      .toArray()
      .map((r: { toJSON(): Record<string, unknown> }) => r.toJSON())
    return normalizeLakeRows(boundTypes(), fields, rows)
  }
  return { db, conn, q, qTyped: q }
}

/**
 * Attach a published lake served under baseUrl (catalog.ducklake + data/).
 * OVERRIDE_DATA_PATH is required: the publish step records its local data
 * path, and attaching from an HTTP vantage must override it.
 */
export async function attachPublishedLake(
  engine: LakeEngine,
  baseUrl: string,
  alias = "lake",
): Promise<void> {
  const base = baseUrl.replace(/\/$/, "")
  await engine.q(
    `ATTACH 'ducklake:${base}/catalog.ducklake' AS ${alias} (DATA_PATH '${base}/data/', OVERRIDE_DATA_PATH true, READ_ONLY)`,
  )
}

/**
 * Fetch a published lake's bytes into duckdb-wasm's virtual filesystem and
 * attach from there — no network after this resolves. Extensions load
 * lazily at ATTACH, so callers going offline must attach (or LOAD ducklake)
 * while the extension host is still reachable or cached.
 */
export async function preloadPublishedLake(
  engine: LakeEngine,
  baseUrl: string,
  alias = "lake",
): Promise<void> {
  const base = baseUrl.replace(/\/$/, "")
  const manifest = (await (await fetchOk(`${base}/manifest.json`)).json()) as LakeManifest
  const entries = await Promise.all(
    [manifest.catalog, ...manifest.files].map(async (f) => {
      const name = f === manifest.catalog ? "lake/catalog.ducklake" : `lake/${f}`
      return [name, await (await fetchOk(`${base}/${f}`)).arrayBuffer()] as const
    }),
  )
  for (const [name, buf] of entries) {
    await engine.db.registerFileBuffer(name, new Uint8Array(buf))
  }
  await engine.q(
    `ATTACH 'ducklake:lake/catalog.ducklake' AS ${alias} (DATA_PATH 'lake/data/', OVERRIDE_DATA_PATH true, READ_ONLY)`,
  )
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`)
  return res
}
