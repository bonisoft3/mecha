import { describe, it, expect } from "vitest"
import { createJqProcessor } from "./jq"
import { createMessage } from "../message"
import type { PipelineContext } from "../types"

const ctx: PipelineContext = {
  httpHandler: async () => new Response(),
  env: {},
}

describe("jq processor", () => {
  it("transforms content with jq expression", async () => {
    const proc = createJqProcessor(".name")
    const msgs = await proc(createMessage({ name: "test", extra: "drop" }), ctx)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe("test")
  })

  it("filters out messages when jq returns null (select)", async () => {
    const proc = createJqProcessor('select(.status == "submitted")')
    const msgs = await proc(createMessage({ status: "complete" }), ctx)
    expect(msgs).toHaveLength(0)
  })

  it("passes through matching select", async () => {
    const proc = createJqProcessor('select(.status == "submitted")')
    const msgs = await proc(createMessage({ status: "submitted", topic: "test" }), ctx)
    expect(msgs).toHaveLength(1)
    expect((msgs[0].content as any).topic).toBe("test")
  })

  it("preserves and updates metadata via ._meta", async () => {
    const proc = createJqProcessor('._meta.card_set_id = .card_set_id | {prompt: .topic}')
    const msg = createMessage({ topic: "Animals", card_set_id: "cs1" }, { existing: "val" })
    const msgs = await proc(msg, ctx)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].metadata.card_set_id).toBe("cs1")
    expect(msgs[0].metadata.existing).toBe("val")
    expect((msgs[0].content as any).prompt).toBe("Animals")
  })

  it("builds complex objects", async () => {
    const proc = createJqProcessor('{contents: [{parts: [{text: ("Generate " + (.count|tostring) + " cards about " + .topic)}]}]}')
    const msgs = await proc(createMessage({ topic: "Animals", count: 3 }), ctx)
    expect(msgs).toHaveLength(1)
    const c = msgs[0].content as any
    expect(c.contents[0].parts[0].text).toBe("Generate 3 cards about Animals")
  })
})
