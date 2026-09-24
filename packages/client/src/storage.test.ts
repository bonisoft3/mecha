import { describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { ResilientIndexedDBAdapter, MemoryStorageAdapter, createStorageAdapter } from "./storage.js";

describe("ResilientIndexedDBAdapter", () => {
  it("performs basic CRUD operations", async () => {
    const adapter = new ResilientIndexedDBAdapter("test-crud-db", "txs");
    await adapter.set("tx-1", JSON.stringify({ id: 1, action: "create" }));
    await adapter.set("tx-2", JSON.stringify({ id: 2, action: "update" }));

    expect(await adapter.get("tx-1")).toBe(JSON.stringify({ id: 1, action: "create" }));
    expect(await adapter.keys()).toEqual(["tx-1", "tx-2"]);

    await adapter.delete("tx-1");
    expect(await adapter.get("tx-1")).toBeNull();
    expect(await adapter.keys()).toEqual(["tx-2"]);

    await adapter.clear();
    expect(await adapter.keys()).toEqual([]);
  });

  it("recovers and re-opens connection after connection is closed", async () => {
    const adapter = new ResilientIndexedDBAdapter("test-reconnect-db", "txs");
    await adapter.set("tx-1", "value-1");

    // Browser tab backgrounding or eviction closes IDBDatabase; subsequent writes must reopen.
    const db = (adapter as any).db as IDBDatabase;
    expect(db).toBeDefined();
    db.close();

    await adapter.set("tx-2", "value-2");
    expect(await adapter.get("tx-1")).toBe("value-1");
    expect(await adapter.get("tx-2")).toBe("value-2");
  });

  it("handles versionchange event by cleanly closing and resetting cached connection", async () => {
    const adapter = new ResilientIndexedDBAdapter("test-versionchange-db", "txs");
    await adapter.set("init", "ok");

    const db = (adapter as any).db as IDBDatabase;
    expect(db).toBeDefined();

    // A concurrent tab or service worker upgrade raises versionchange; the cached handle must yield.
    (db as any).onversionchange?.(new Event("versionchange"));

    await adapter.set("after", "resilient");
    expect(await adapter.get("init")).toBe("ok");
    expect(await adapter.get("after")).toBe("resilient");
  });
});

describe("MemoryStorageAdapter", () => {
  it("stores and retrieves key-values in memory", async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.set("a", "1");
    expect(await adapter.get("a")).toBe("1");
    expect(await adapter.keys()).toEqual(["a"]);
    await adapter.delete("a");
    expect(await adapter.get("a")).toBeNull();
  });
});

describe("createStorageAdapter", () => {
  it("creates ResilientIndexedDBAdapter when indexedDB is available", () => {
    const adapter = createStorageAdapter();
    expect(adapter).toBeInstanceOf(ResilientIndexedDBAdapter);
  });
});
