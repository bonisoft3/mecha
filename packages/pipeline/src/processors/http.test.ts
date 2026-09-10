import { describe, it, expect, vi } from "vitest"
import { createHttpProcessor } from "./http"
import { createMessage } from "../message"
import type { PipelineContext } from "../types"

describe("http processor", () => {
  it("POSTs message content and replaces with response", async () => {
    const mockHandler = vi.fn(async (req: Request) => {
      const body = await req.json()
      return new Response(JSON.stringify({ result: body.input + "_processed" }), {
        headers: { "Content-Type": "application/json" },
      })
    })
    const ctx: PipelineContext = { httpHandler: mockHandler, env: {} }

    const proc = createHttpProcessor({
      url: "https://api.example.com/process",
      verb: "POST",
      headers: { "Content-Type": "application/json" },
    })
    const msgs = await proc(createMessage({ input: "test" }), ctx)

    expect(msgs).toHaveLength(1)
    expect((msgs[0].content as any).result).toBe("test_processed")
    expect(mockHandler).toHaveBeenCalledOnce()
    const req = mockHandler.mock.calls[0][0]
    expect(req.method).toBe("POST")
    expect(req.url).toBe("https://api.example.com/process")
  })

  it("interpolates ${_meta.key} in URL", async () => {
    const mockHandler = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    }))
    const ctx: PipelineContext = { httpHandler: mockHandler, env: {} }

    const proc = createHttpProcessor({ url: "/crud/table?id=eq.${_meta.id}", verb: "PATCH" })
    await proc(createMessage({ status: "done" }, { id: "abc" }), ctx)

    const req = mockHandler.mock.calls[0][0]
    expect(req.url).toContain("/crud/table?id=eq.abc")
  })

  it("interpolates ${ENV_VAR} in URL", async () => {
    const mockHandler = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    }))
    const ctx: PipelineContext = { httpHandler: mockHandler, env: { API_KEY: "secret" } }

    const proc = createHttpProcessor({ url: "https://api.com?key=${API_KEY}", verb: "POST" })
    await proc(createMessage({}), ctx)

    const req = mockHandler.mock.calls[0][0]
    expect(req.url).toContain("key=secret")
  })

  it("preserves metadata across http call", async () => {
    const mockHandler = vi.fn(async () => new Response(JSON.stringify({ new: "data" }), {
      headers: { "Content-Type": "application/json" },
    }))
    const ctx: PipelineContext = { httpHandler: mockHandler, env: {} }

    const proc = createHttpProcessor({ url: "/api", verb: "POST" })
    const msgs = await proc(createMessage({}, { kept: "yes" }), ctx)

    expect(msgs[0].metadata.kept).toBe("yes")
  })
})
