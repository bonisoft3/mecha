export interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<Array<string>>;
  clear(): Promise<void>;
}

export interface SqlBridge {
  exec(sql: string, params?: readonly unknown[]): Promise<unknown> | unknown;
  query(sql: string, params?: readonly unknown[]): Promise<readonly Record<string, unknown>[]> | readonly Record<string, unknown>[];
}

// Resilient IndexedDB adapter for offline transactions.
//
// Upstream @tanstack/offline-transactions IndexedDBAdapter caches an IDBDatabase
// without tracking connection lifecycle (onclose, onversionchange). When Chromium
// closes or suspends the connection (e.g. on background, navigation, or version change),
// subsequent transaction() calls throw InvalidStateError: "The database connection is closing."
//
// This adapter listens to connection lifecycle events to reset the cached reference,
// and transparently re-opens a fresh connection if transaction() encounters a closing state.
export class ResilientIndexedDBAdapter implements StorageAdapter {
  private dbName: string;
  private storeName: string;
  private db: IDBDatabase | null = null;
  private openPromise: Promise<IDBDatabase> | null = null;

  constructor(dbName = "offline-transactions", storeName = "transactions") {
    this.dbName = dbName;
    this.storeName = storeName;
  }

  private async openDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    if (this.openPromise) return this.openPromise;

    this.openPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => {
        this.openPromise = null;
        reject(request.error ?? new Error("IndexedDB open failed"));
      };

      request.onsuccess = () => {
        const db = request.result;
        this.db = db;
        this.openPromise = null;

        db.onversionchange = () => {
          db.close();
          if (this.db === db) this.db = null;
        };
        db.onclose = () => {
          if (this.db === db) this.db = null;
        };

        resolve(db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
    });

    return this.openPromise;
  }

  private async getStore(mode: IDBTransactionMode = "readonly"): Promise<IDBObjectStore> {
    let db = await this.openDB();
    try {
      const transaction = db.transaction([this.storeName], mode);
      return transaction.objectStore(this.storeName);
    } catch (err: any) {
      if (err?.name === "InvalidStateError" || (typeof err?.message === "string" && /closing/i.test(err.message))) {
        if (this.db === db) this.db = null;
        db = await this.openDB();
        const transaction = db.transaction([this.storeName], mode);
        return transaction.objectStore(this.storeName);
      }
      throw err;
    }
  }

  async get(key: string): Promise<string | null> {
    const store = await this.getStore("readonly");
    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? null);
    });
  }

  async set(key: string, value: string): Promise<void> {
    const store = await this.getStore("readwrite");
    return new Promise((resolve, reject) => {
      const request = store.put(value, key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async delete(key: string): Promise<void> {
    const store = await this.getStore("readwrite");
    return new Promise((resolve, reject) => {
      const request = store.delete(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async keys(): Promise<Array<string>> {
    const store = await this.getStore("readonly");
    return new Promise((resolve, reject) => {
      const request = store.getAllKeys();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve((request.result ?? []) as string[]);
    });
  }

  async clear(): Promise<void> {
    const store = await this.getStore("readwrite");
    return new Promise((resolve, reject) => {
      const request = store.clear();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
}

export class MemoryStorageAdapter implements StorageAdapter {
  private map = new Map<string, string>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }

  keys(): Promise<Array<string>> {
    return Promise.resolve([...this.map.keys()]);
  }

  clear(): Promise<void> {
    this.map.clear();
    return Promise.resolve();
  }
}

export class SqliteStorageAdapter implements StorageAdapter {
  private sql: SqlBridge;
  private tableName: string;
  private initPromise: Promise<void> | null = null;

  constructor(sql: SqlBridge, tableName = "mecha_outbox") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
      throw new Error(`invalid SQLite outbox table name: ${tableName}`);
    }
    this.sql = sql;
    this.tableName = tableName;
  }

  private ensureTable(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = Promise.resolve(
      this.sql.exec(`CREATE TABLE IF NOT EXISTS "${this.tableName}" (key TEXT PRIMARY KEY, value TEXT NOT NULL)`),
    ).then(
      () => undefined,
      (err) => {
        this.initPromise = null;
        throw err;
      },
    );
    return this.initPromise;
  }

  async get(key: string): Promise<string | null> {
    await this.ensureTable();
    const rows = await this.sql.query(`SELECT value FROM "${this.tableName}" WHERE key = ?`, [key]);
    const val = rows[0]?.value;
    return typeof val === "string" ? val : null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.ensureTable();
    await this.sql.exec(
      `INSERT INTO "${this.tableName}" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  async delete(key: string): Promise<void> {
    await this.ensureTable();
    await this.sql.exec(`DELETE FROM "${this.tableName}" WHERE key = ?`, [key]);
  }

  async keys(): Promise<Array<string>> {
    await this.ensureTable();
    const rows = await this.sql.query(`SELECT key FROM "${this.tableName}" ORDER BY rowid ASC`);
    return rows.map((row) => String(row.key));
  }

  async clear(): Promise<void> {
    await this.ensureTable();
    await this.sql.exec(`DELETE FROM "${this.tableName}"`);
  }
}

export function createStorageAdapter(options?: { storage?: StorageAdapter; sql?: SqlBridge }): StorageAdapter {
  if (options?.storage) return options.storage;
  const sql = options?.sql ?? (globalThis as { __mechaSql?: SqlBridge }).__mechaSql;
  if (sql) return new SqliteStorageAdapter(sql);
  if (typeof indexedDB !== "undefined") {
    return new ResilientIndexedDBAdapter();
  }
  return new MemoryStorageAdapter();
}
