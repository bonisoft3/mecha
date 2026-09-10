import type { PipelineMessage, ProcessorFn, PipelineContext } from "../types.js"

/**
 * `try` processor: run sub-processors sequentially. If any throws,
 * return the original message unchanged (suppress the error).
 */
export function createTryProcessor(subProcessors: ProcessorFn[]): ProcessorFn {
  return async (msg: PipelineMessage, ctx: PipelineContext): Promise<PipelineMessage[]> => {
    let msgs = [msg]
    for (const proc of subProcessors) {
      const nextMsgs: PipelineMessage[] = []
      for (const m of msgs) {
        try {
          nextMsgs.push(...await proc(m, ctx))
        } catch {
          // Suppress error, pass original message through
          nextMsgs.push(m)
        }
      }
      msgs = nextMsgs
    }
    return msgs
  }
}

/**
 * `catch` processor: only runs sub-processors on messages that have
 * an error flag. Non-errored messages pass through unchanged.
 * In practice, this runs after `try` or the executor's catch path
 * sets `metadata._error` on failed messages.
 */
export function createCatchProcessor(subProcessors: ProcessorFn[]): ProcessorFn {
  return async (msg: PipelineMessage, ctx: PipelineContext): Promise<PipelineMessage[]> => {
    if (!msg.metadata._error) return [msg]
    let msgs = [msg]
    for (const proc of subProcessors) {
      const nextMsgs: PipelineMessage[] = []
      for (const m of msgs) {
        nextMsgs.push(...await proc(m, ctx))
      }
      msgs = nextMsgs
    }
    return msgs
  }
}
