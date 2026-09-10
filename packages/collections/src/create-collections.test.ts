import { describe, it, expect, vi } from "vitest"
import { createCollections } from "./create-collections"
import type { CollectionAdapter, CollectionTableConfig } from "./types"

function mockAdapter(): CollectionAdapter {
  return {
    collectionOptions: vi.fn((table: string, key: string) => ({
      getKey: (item: any) => item[key],
      sync: vi.fn(() => () => {}),
    })),
  }
}

const TABLES: CollectionTableConfig[] = [
  { name: "card_set", key: "id", id: "cardSets" },
  { name: "flashcard", key: "id", id: "flashcards" },
]

describe("createCollections", () => {
  it("creates a collection for each table", () => {
    const adapter = mockAdapter()
    const collections = createCollections(adapter, TABLES)
    expect(collections.cardSets).toBeDefined()
    expect(collections.flashcards).toBeDefined()
  })

  it("calls adapter.collectionOptions for each table", () => {
    const adapter = mockAdapter()
    createCollections(adapter, TABLES)
    expect(adapter.collectionOptions).toHaveBeenCalledWith("card_set", "id")
    expect(adapter.collectionOptions).toHaveBeenCalledWith("flashcard", "id")
  })

  it("returns collections keyed by table id", () => {
    const adapter = mockAdapter()
    const collections = createCollections(adapter, TABLES)
    expect(Object.keys(collections)).toEqual(["cardSets", "flashcards"])
  })
})
