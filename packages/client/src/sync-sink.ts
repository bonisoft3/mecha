/** What a sync function writes through: the collection's own sink, or a wrap of it. */
export interface SyncSink {
  write(message: { type: "insert" | "update" | "delete"; value?: any; metadata?: any }): void
  truncate(): void
}

/**
 * A sync sink whose inserts are idempotent by key.
 *
 * The collection applies a committed sync transaction only when none of its
 * own optimistic transactions is persisting; until then the transaction
 * waits, and the collection's synced rows stay as they were. Its duplicate
 * check on an insert reads those rows, so a key deleted in one waiting
 * transaction and inserted in the next is refused as a duplicate, although
 * the delete lands first once the wait ends. A mecha write persists until the
 * shape delivers its txid, so the wait spans exactly the batches the shape
 * delivers meanwhile, and a row that leaves and returns across two of them
 * (a lobby seat given up on unload and retaken by the reload) is that case.
 *
 * A key this sink has delivered is therefore written as an update from then
 * on. An update lands on a missing row as the row itself, and on a present
 * one as its replacement, since a shape's insert carries every column. The
 * memory is dropped on truncate, the one point the collection drops every
 * row it holds.
 */
export function idempotentSink<T extends SyncSink>(sink: T, getKey: (row: any) => string | number): T {
  const delivered = new Set<string | number>()
  return {
    ...sink,
    write: (message) => {
      if (message.type === "delete") return sink.write(message)
      const key = getKey(message.value)
      const type = message.type === "insert" && delivered.has(key) ? "update" : message.type
      delivered.add(key)
      sink.write({ ...message, type })
    },
    truncate: () => {
      delivered.clear()
      sink.truncate()
    },
  }
}
