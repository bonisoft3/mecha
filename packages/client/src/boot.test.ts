import { describe, it, expect } from "vitest"
import { bootPlatform } from "./boot"

describe("bootPlatform", () => {
  it("returns a PlatformContext synchronously", () => {
    const ctx = bootPlatform()
    expect(ctx.adapter).toBeDefined()
    expect(ctx.restHandler).toBeDefined()
    expect(typeof ctx.adapter.collectionOptions).toBe("function")
    expect(typeof ctx.restHandler).toBe("function")
  })

  it("uses default URLs when none provided", () => {
    const ctx = bootPlatform()
    const opts = ctx.adapter.collectionOptions("card_set", "id")
    expect(opts.getKey({ id: "abc" })).toBe("abc")
    expect(typeof opts.sync).toBe("function")
  })

  it("accepts custom URLs", () => {
    const ctx = bootPlatform({
      electricUrl: "http://localhost:9000/electric",
      crudUrl: "http://localhost:9000/crud",
    })
    expect(ctx.adapter).toBeDefined()
    expect(ctx.restHandler).toBeDefined()
  })

  it("silently ignores extra config fields", () => {
    const ctx = bootPlatform({
      schema: "CREATE TABLE test (id TEXT)",
      tables: ["test"],
      seedData: async () => {},
    } as any)
    expect(ctx.adapter).toBeDefined()
  })
})
