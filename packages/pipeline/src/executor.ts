import type { PipelineMessage, ProcessorStep, PipelineContext } from "./types.js"
import { resolveProcessor } from "./processors/registry.js"

export async function executePipeline(
  input: PipelineMessage,
  processors: ProcessorStep[],
  outputFn: (msg: PipelineMessage) => Promise<void> | void,
  ctx: PipelineContext,
): Promise<void> {
  const resolvedProcessors = processors.map(resolveProcessor)

  let messages = [input]

  for (const proc of resolvedProcessors) {
    const nextMessages: PipelineMessage[] = []
    for (const msg of messages) {
      try {
        const results = await proc(msg, ctx)
        nextMessages.push(...results)
      } catch (err) {
        console.error(`[pipeline] Processor error, dropping message:`, err instanceof Error ? err.message : err)
        // Message is dropped — not forwarded. Silent data corruption is worse than data loss.
      }
    }
    messages = nextMessages
    if (messages.length === 0) return
  }

  for (const msg of messages) {
    await outputFn(msg)
  }
}
