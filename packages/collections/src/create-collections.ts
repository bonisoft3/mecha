import { createCollection } from "@tanstack/db"
import type { CollectionAdapter, CollectionTableConfig } from "./types.js"

/**
 * Create TanStack DB collections from a platform adapter.
 *
 * Pure function — no platform awareness. The adapter (from @mecha/browser
 * or @mecha/client) provides the collection options; this function just
 * wires them into createCollection().
 */
export function createCollections(
  adapter: CollectionAdapter,
  tables: CollectionTableConfig[],
): Record<string, any> {
  const collections: Record<string, any> = {}
  for (const table of tables) {
    const opts = adapter.collectionOptions(table.name, table.key)
    collections[table.id] = createCollection({
      id: `mecha:${table.id}`,
      getKey: opts.getKey,
      sync: { sync: opts.sync },
    } as any)
  }
  return collections
}
