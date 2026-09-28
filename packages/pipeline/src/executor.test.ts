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

  // A throwing step used to be logged and its message dropped, so the run
  // resolved as if the message had been filtered out on purpose.
  it("fails the run when a processor throws", async () => {
    const processors: ProcessorStep[] = [{ jq: 'error("boom")' }]
    const output = vi.fn()
    await expect(executePipeline(createMessage({}), processors, output, ctx)).rejects.toThrow("boom")
    expect(output).not.toHaveBeenCalled()
  })

  it("lets a pipeline recover a failed step with try and catch", async () => {
    const processors: ProcessorStep[] = [
      { try: [{ jq: 'error("boom")' }, { jq: '{after: "skipped"}' }] },
      { catch: [{ jq: '{recovered: ._meta._error}' }] },
    ]
    const output = vi.fn()
    await executePipeline(createMessage({}), processors, output, ctx)
    expect(output).toHaveBeenCalledOnce()
    const msg = output.mock.calls[0][0]
    expect(msg.content.recovered).toContain("boom")
    expect(msg.metadata._error).toBeUndefined()
  })

  it("fails the run when a try's failure reaches the output uncaught", async () => {
    const processors: ProcessorStep[] = [{ try: [{ jq: 'error("boom")' }] }]
    const output = vi.fn()
    await expect(executePipeline(createMessage({}), processors, output, ctx)).rejects.toThrow(/nothing caught it: .*boom/)
    expect(output).not.toHaveBeenCalled()
  })
})
