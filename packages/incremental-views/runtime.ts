interface Database {
  exec(sql: string): Promise<unknown>
}

/** Restored databases need the hooks before their first write, even without CREATE EXTENSION. */
export async function loadIncrementalViews<T extends Database>(db: T): Promise<T> {
  await db.exec(`LOAD 'pg_ivm';
    DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_extension WHERE extname = 'pg_ivm' AND extversion <> '1.13') THEN
        RAISE EXCEPTION 'mecha requires pg_ivm 1.13';
      END IF;
    END $$;`)
  return db
}
