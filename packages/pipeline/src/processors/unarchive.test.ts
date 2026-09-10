import { describe, it, expect } from "vitest"
import { createUnarchiveProcessor } from "./unarchive"
import { createMessage } from "../message"
import type { PipelineContext } from "../types"

const ctx: PipelineContext = { httpHandler: async () => new Response(), env: {} }

describe("unarchive processor", () => {
  it("splits JSON array into individual messages", async () => {
    const proc = createUnarchiveProcessor("json_array")
    const msgs = await proc(createMessage([{ id: 1 }, { id: 2 }, { id: 3 }]), ctx)
    expect(msgs).toHaveLength(3)
    expect((msgs[0].content as any).id).toBe(1)
    expect((msgs[2].content as any).id).toBe(3)
  })

  it("preserves metadata on each split message", async () => {
    const proc = createUnarchiveProcessor("json_array")
    const msgs = await proc(createMessage([{ a: 1 }, { b: 2 }], { key: "val" }), ctx)
    expect(msgs[0].metadata.key).toBe("val")
    expect(msgs[1].metadata.key).toBe("val")
  })

  it("returns empty for non-array content", async () => {
    const proc = createUnarchiveProcessor("json_array")
    const msgs = await proc(createMessage({ not: "array" }), ctx)
    expect(msgs).toHaveLength(0)
  })
})
