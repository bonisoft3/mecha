import { describe, it, expect, vi, beforeAll } from "vitest"
import { createBranchProcessor } from "./branch"
import { setBloblangRuntime } from "./bloblang"
import { createMessage } from "../message"
import type { PipelineContext, ProcessorFn } from "../types"

const ctx: PipelineContext = { httpHandler: async () => new Response(), env: {} }

// Minimal in-JS bloblang stub for tests that don't exercise real bloblang.
// Supports: `root = {"key": "val"}` literals.
beforeAll(() => {
  setBloblangRuntime({
    async execute(mapping: string) {
      const match = mapping.match(/^\s*root\s*=\s*(\{.*\})\s*$/s)
      if (match) return JSON.parse(match[1])
      return {}
    },
  })
})

describe("branch processor", () => {
  it("runs sub-processors as side effect, preserves original with result_map empty", async () => {
    const sideEffect = vi.fn(async (msg) => [msg])
    const proc = createBranchProcessor({ processors: [], result_map: "" }, [sideEffect])
    const msgs = await proc(createMessage({ original: true }), ctx)
    expect(msgs).toHaveLength(1)
    expect((msgs[0].content as any).original).toBe(true)
    expect(sideEffect).toHaveBeenCalled()
  })

  it("applies request_map bloblang to transform input for sub-processors", async () => {
    const captured: any[] = []
    const sideEffect: ProcessorFn = async (msg) => { captured.push(msg.content); return [msg] }
    const proc = createBranchProcessor({
      request_map: 'root = {"status": "generating"}',
      processors: [],
      result_map: "",
    }, [sideEffect])
    await proc(createMessage({ original: true, status: "submitted" }), ctx)
    expect(captured[0]).toEqual({ status: "generating" })
  })
})
