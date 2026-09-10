import type { PipelineMessage, ProcessorFn, HttpProcessorConfig, PipelineContext } from "../types.js"
import { createMessage, interpolate } from "../message.js"

/**
 * Create an HTTP processor that sends the message content as a JSON POST/PATCH/PUT
 * and replaces the message with the response body.
 */
export function createHttpProcessor(config: HttpProcessorConfig): ProcessorFn {
  return async (msg: PipelineMessage, ctx: PipelineContext): Promise<PipelineMessage[]> => {
    const url = interpolate(config.url, msg, ctx.env)

    // Make URL absolute if relative — use page origin in browser so MSW can intercept
    const base = typeof globalThis.location !== 'undefined' ? globalThis.location.origin : 'http://localhost'
    const fullUrl = url.startsWith("http") ? url : `${base}${url}`

    const req = new Request(fullUrl, {
      method: config.verb.toUpperCase(),
      headers: {
        "Content-Type": "application/json",
        ...config.headers,
      },
      body: JSON.stringify(msg.content),
    })

    const res = await ctx.httpHandler(req)

    let responseContent: unknown
    const contentType = res.headers.get("Content-Type") ?? ""
    if (contentType.includes("json")) {
      responseContent = await res.json()
    } else {
      responseContent = await res.text()
    }

    return [createMessage(responseContent, { ...msg.metadata })]
  }
}
