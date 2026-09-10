import { describe, it, expect, vi } from "vitest"
import { executePipeline } from "./executor"
import { createMessage } from "./message"
import type { PipelineContext, ProcessorStep } from "./types"

describe("executePipeline", () => {
  const ctx: PipelineContext = {
    httpHandler: vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    })),
    env: {},
  }

  it("runs processors in sequence", async () => {
    const processors: ProcessorStep[] = [
      { jq: '{name: .name, upper: (.name | ascii_upcase)}' },
    ]
    const output = vi.fn()
    await executePipeline(createMessage({ name: "test" }), processors, output, ctx)
    expect(output).toHaveBeenCalledOnce()
    const msg = output.mock.calls[0][0]
    expect(msg.content).toEqual({ name: "test", upper: "TEST" })
  })

  it("filters messages with select()", async () => {
    const processors: ProcessorStep[] = [
      { jq: 'select(.status == "submitted")' },
    ]
    const output = vi.fn()
    await executePipeline(createMessage({ status: "complete" }), processors, output, ctx)
    expect(output).not.toHaveBeenCalled()
  })

  it("fans out with unarchive", async () => {
    const processors: ProcessorStep[] = [
      { jq: '[{id:1},{id:2}]' },
      { unarchive: { format: "json_array" } },
    ]
    const output = vi.fn()
    await executePipeline(createMessage({}), processors, output, ctx)
    expect(output).toHaveBeenCalledTimes(2)
  })
})
