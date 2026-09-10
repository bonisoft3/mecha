/** Adapter that creates TanStack DB collection options for a given table. */
export interface CollectionAdapter {
  collectionOptions(table: string, key: string): {
    getKey: (item: any) => string
    sync: (params: {
      collection: any
      begin: (options?: { immediate?: boolean }) => void
      write: (message: any) => void
      commit: () => void
      markReady: () => void
      truncate: () => void
    }) => () => void
  }
}

/** Returned by bootPlatform() from @mecha/browser or @mecha/client. */
export interface PlatformContext {
  adapter: CollectionAdapter
  restHandler: (req: Request) => Promise<Response>
  destroy?: () => Promise<void>
}

/** Table configuration for createCollections(). */
export interface CollectionTableConfig {
  /** Database table name (e.g. "card_set") */
  name: string
  /** Primary key column (e.g. "id") */
  key: string
  /** TanStack DB collection id (e.g. "cardSets") */
  id: string
}
