import type { PipelineMessage, ProcessorStep, PipelineContext } from "./types.js"
import { resolveProcessor } from "./processors/registry.js"
import { ERROR_KEY } from "./processors/try-catch.js"

/**
 * Runs one message through the processors and hands each result to the
 * output. A processor that throws fails the run: the error reaches the
 * caller and nothing after it runs. A pipeline that recovers from a step says
 * so with `try` and `catch`, and a message still flagged by `try` when it
 * reaches the output fails the run the same way.
 */
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
      nextMessages.push(...await proc(msg, ctx))
    }
    messages = nextMessages
    if (messages.length === 0) return
  }

  for (const msg of messages) {
    const error = msg.metadata[ERROR_KEY]
    if (error !== undefined) throw new Error(`[pipeline] a step failed and nothing caught it: ${error}`)
    await outputFn(msg)
  }
}
