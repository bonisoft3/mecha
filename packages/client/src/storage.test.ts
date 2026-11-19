import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import "fake-indexeddb/auto";
import {
  ResilientIndexedDBAdapter,
  MemoryStorageAdapter,
  SqliteStorageAdapter,
  createStorageAdapter,
  type SqlBridge,
} from "./storage.js";
import { SqliteShapeSnapshotStore } from "./shape-snapshot.js";
import { createMechaClient } from "./mecha-client.js";

function nodeSqliteBridge(): SqlBridge {
  const db = new DatabaseSync(":memory:");
  return {
    exec(sql, params = []) {
      return db.prepare(sql).run(...(params as any[]));
    },
    query(sql, params = []) {
      return db.prepare(sql).all(...(params as any[])) as Record<string, unknown>[];
    },
  };
}

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

  it("prefers SqliteStorageAdapter when an SqlBridge is supplied", async () => {
    const sql = nodeSqliteBridge();
    const adapter = createStorageAdapter({ sql });
    expect(adapter).toBeInstanceOf(SqliteStorageAdapter);
    await adapter.set("tx-a", '{"id":"a"}');
    await adapter.set("tx-b", '{"id":"b"}');
    await adapter.set("tx-a", '{"id":"a2"}');
    expect(await adapter.get("tx-a")).toBe('{"id":"a2"}');
    expect(await adapter.keys()).toEqual(["tx-a", "tx-b"]);
    await adapter.delete("tx-a");
    expect(await adapter.get("tx-a")).toBeNull();
    await adapter.clear();
    expect(await adapter.keys()).toEqual([]);
  });
});

describe("SqliteShapeSnapshotStore & offline cold boot", () => {
  it("compacts batches in SQLite and hydrates MechaClient offline before Electric answers", async () => {
    const sql = nodeSqliteBridge();
    const store = new SqliteShapeSnapshotStore(sql);

    expect(await store.load("card_set", "")).toEqual({ ready: false, rows: [] });
    await store.applyBatch(
      "card_set",
      "",
      [
        { type: "upsert", key: "d1", value: { id: "d1", name: "Animais", count: 5 } },
        { type: "upsert", key: "d2", value: { id: "d2", name: "Frutas", count: 3 } },
      ],
      true,
    );
    await store.applyBatch(
      "card_set",
      "",
      [
        { type: "upsert", key: "d1", value: { id: "d1", name: "Animais Brasileiros", count: 7 } },
        { type: "delete", key: "d2" },
      ],
      true,
    );
    expect(await store.load("card_set", "")).toEqual({
      ready: true,
      rows: [{ id: "d1", name: "Animais Brasileiros", count: 7 }],
    });

    // Cold-boot a MechaClient completely offline (network throws TypeError) over the same SQLite database.
    const kv = new Map<string, string>();
    const deviceStorage = {
      getItem: (k: string) => kv.get(k) ?? null,
      setItem: (k: string, v: string) => { kv.set(k, v); },
    };
    let provisional = true;
    let currentSubject: string | null = "00000000-0000-4000-8000-000000000001";
    const client = createMechaClient({
      authUrl: "https://offline.invalid/auth",
      electricUrl: "https://offline.invalid/electric",
      crudUrl: "https://offline.invalid/crud",
      sql,
      deviceStorage,
      subject: () => currentSubject,
      provisional: () => provisional,
      fetcher: () => Promise.reject(new TypeError("Failed to fetch")),
      tables: [
        { id: "card_set", table: "card_set", access: { scope: "public" } },
        { id: "my_decks", table: "my_decks", access: { scope: "private", owner: "owner" } },
        { id: "generation_form", table: "generation_form", durability: "device" },
      ],
    });
    await client.ready;

    // Device collection persists through custom deviceStorage.
    await client.insert("generation_form", [{ id: "draft", topic: "Planetas" }]);
    expect(kv.get("mecha:generation_form")).toContain("Planetas");

    // Eager public collection hydrates from SQLite snapshot and becomes ready while offline.
    const sub = client.collections.card_set.subscribeChanges(() => {}, { includeInitialState: true });
    await new Promise<void>((resolve) => {
      if (client.collections.card_set.isReady()) resolve();
      else client.collections.card_set.once("status:ready", () => resolve());
    });
    expect(client.collections.card_set.get("d1")).toMatchObject({ id: "d1", name: "Animais Brasileiros", count: 7, $synced: true });
    sub.unsubscribe();

    // Offline-first-boot provisional write is adopted onto the server-minted guest UUID.
    void client.insert("my_decks", [{ id: "u1", owner: currentSubject, name: "Offline Deck" }]);
    await new Promise((r) => setTimeout(r, 25));
    const realGuest = "11111111-1111-4111-8111-111111111111";
    provisional = false;
    const prevSubject = currentSubject;
    currentSubject = realGuest;
    const adopted = await client.adoptProvisionalSubject(prevSubject, realGuest);
    expect(adopted).toBe(1);
    const outbox = new SqliteStorageAdapter(sql);
    const keys = await outbox.keys();
    expect(keys.length).toBe(1);
    const savedTx = JSON.parse((await outbox.get(keys[0]))!);
    expect(savedTx.metadata.subject).toBe(realGuest);
    expect(savedTx.metadata.provisional).toBe(false);
    expect(savedTx.mutations[0].modified.owner).toBe(realGuest);
  });
});
