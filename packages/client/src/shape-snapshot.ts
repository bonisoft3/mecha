import type { SqlBridge } from "./storage.js";

export type ShapeSnapshotOp =
  | { type: "upsert"; key: string; value: Record<string, unknown> }
  | { type: "delete"; key: string };

export interface ShapeSnapshot<T = Record<string, unknown>> {
  ready: boolean;
  rows: T[];
}

export interface ShapeSnapshotStore {
  load(shapeId: string, subject: string): Promise<ShapeSnapshot>;
  applyBatch(shapeId: string, subject: string, ops: readonly ShapeSnapshotOp[], markReady: boolean): Promise<void>;
  truncate(shapeId: string, subject: string): Promise<void>;
}

// Compacted per-shape snapshot in native SQLite so cold-booting offline hydrates
// Electric collections before the network answers, scoped by subject so private
// shapes never bleed across account switches.
export class SqliteShapeSnapshotStore implements ShapeSnapshotStore {
  private sql: SqlBridge;
  private initPromise: Promise<void> | null = null;

  constructor(sql: SqlBridge) {
    this.sql = sql;
  }

  private ensureTables(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      await this.sql.exec(
        `CREATE TABLE IF NOT EXISTS mecha_shape_row (
          shape_id TEXT NOT NULL,
          subject TEXT NOT NULL,
          row_key TEXT NOT NULL,
          row_json TEXT NOT NULL,
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          UNIQUE (shape_id, subject, row_key)
        )`,
      );
      await this.sql.exec(
        `CREATE TABLE IF NOT EXISTS mecha_shape_meta (
          shape_id TEXT NOT NULL,
          subject TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (shape_id, subject)
        )`,
      );
    })().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  async load(shapeId: string, subject: string): Promise<ShapeSnapshot> {
    await this.ensureTables();
    const meta = await this.sql.query(
      `SELECT updated_at FROM mecha_shape_meta WHERE shape_id = ? AND subject = ?`,
      [shapeId, subject],
    );
    if (meta.length === 0) return { ready: false, rows: [] };
    const stored = await this.sql.query(
      `SELECT row_json FROM mecha_shape_row WHERE shape_id = ? AND subject = ? ORDER BY seq ASC`,
      [shapeId, subject],
    );
    const rows = stored.map((r) => JSON.parse(String(r.row_json)) as Record<string, unknown>);
    return { ready: true, rows };
  }

  async applyBatch(
    shapeId: string,
    subject: string,
    ops: readonly ShapeSnapshotOp[],
    markReady: boolean,
  ): Promise<void> {
    if (ops.length === 0 && !markReady) return;
    await this.ensureTables();
    for (const op of ops) {
      if (op.type === "upsert") {
        await this.sql.exec(
          `INSERT INTO mecha_shape_row (shape_id, subject, row_key, row_json) VALUES (?, ?, ?, ?)
           ON CONFLICT(shape_id, subject, row_key) DO UPDATE SET row_json = excluded.row_json`,
          [shapeId, subject, op.key, JSON.stringify(op.value)],
        );
      } else {
        await this.sql.exec(
          `DELETE FROM mecha_shape_row WHERE shape_id = ? AND subject = ? AND row_key = ?`,
          [shapeId, subject, op.key],
        );
      }
    }
    if (markReady) {
      await this.sql.exec(
        `INSERT INTO mecha_shape_meta (shape_id, subject, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(shape_id, subject) DO UPDATE SET updated_at = excluded.updated_at`,
        [shapeId, subject, Date.now()],
      );
    }
  }

  async truncate(shapeId: string, subject: string): Promise<void> {
    await this.ensureTables();
    await this.sql.exec(`DELETE FROM mecha_shape_row WHERE shape_id = ? AND subject = ?`, [shapeId, subject]);
    await this.sql.exec(`DELETE FROM mecha_shape_meta WHERE shape_id = ? AND subject = ?`, [shapeId, subject]);
  }
}
