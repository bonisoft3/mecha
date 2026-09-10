import type { PGlite } from "@electric-sql/pglite"
import type { PipelineConfig, PipelineContext, PipelineMessage } from "./types.js"
import { createMessage, interpolate } from "./message.js"
import { executePipeline } from "./executor.js"

export async function createCDCPipelineListener(
  pglite: PGlite,
  pipelines: PipelineConfig[],
  ctx: PipelineContext,
): Promise<() => void> {
  const pipelineByTable = new Map<string, PipelineConfig>()
  for (const p of pipelines) {
    pipelineByTable.set(p.input.cdc.table, p)
  }

  const unsub = await pglite.listen("cdc", async (payload: string) => {
    try {
      const event = JSON.parse(payload) as {
        table: string
        op: string
        row: Record<string, unknown>
      }

      const pipeline = pipelineByTable.get(event.table)
      if (!pipeline) return

      // Wrap in the same CloudEvents envelope that rpk receives from Dapr,
      // so the pipeline processors (e.g. .data | fromjson) work identically.
      const msg = createMessage({ data: JSON.stringify(event.row) })

      await executePipeline(
        msg,
        pipeline.pipeline.processors,
        async (outputMsg: PipelineMessage) => {
          const outputConfig = pipeline.output.http_client
          const url = interpolate(outputConfig.url, outputMsg, ctx.env)
          const base = typeof globalThis.location !== 'undefined' ? globalThis.location.origin : 'http://localhost'
          const fullUrl = url.startsWith("http") ? url : `${base}${url}`

          const req = new Request(fullUrl, {
            method: outputConfig.verb.toUpperCase(),
            headers: {
              "Content-Type": "application/json",
              ...outputConfig.headers,
            },
            body: JSON.stringify(outputMsg.content),
          })

          const res = await ctx.httpHandler(req)
          if (!res.ok) {
            console.error(`[pipeline] Output HTTP ${res.status}: ${await res.text()}`)
          }
        },
        ctx,
      )
    } catch (err) {
      console.error("[pipeline] CDC dispatch error:", err)
    }
  })

  return unsub
}
