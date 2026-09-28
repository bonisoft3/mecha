import type { PipelineMessage, ProcessorFn, PipelineContext } from "../types.js"

/** The metadata key a failed step's message carries its error under. */
export const ERROR_KEY = "_error"

/**
 * `try` processor, as rpk runs it: sub-processors in sequence, and a message
 * whose step throws is flagged with the error under `_error` and skips the
 * steps after it. The flag is the pipeline's to clear with `catch`; one that
 * reaches the output fails the run.
 */
export function createTryProcessor(subProcessors: ProcessorFn[]): ProcessorFn {
  return async (msg: PipelineMessage, ctx: PipelineContext): Promise<PipelineMessage[]> => {
    let msgs = [msg]
    for (const proc of subProcessors) {
      const nextMsgs: PipelineMessage[] = []
      for (const m of msgs) {
        if (m.metadata[ERROR_KEY] !== undefined) {
          nextMsgs.push(m)
          continue
        }
        try {
          nextMsgs.push(...await proc(m, ctx))
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          nextMsgs.push({ ...m, metadata: { ...m.metadata, [ERROR_KEY]: error } })
        }
      }
      msgs = nextMsgs
    }
    return msgs
  }
}

/**
 * `catch` processor: runs sub-processors only on messages a `try` flagged,
 * with the flag still readable, and clears it from what they return.
 * Unflagged messages pass through unchanged.
 */
export function createCatchProcessor(subProcessors: ProcessorFn[]): ProcessorFn {
  return async (msg: PipelineMessage, ctx: PipelineContext): Promise<PipelineMessage[]> => {
    if (msg.metadata[ERROR_KEY] === undefined) return [msg]
    let msgs = [msg]
    for (const proc of subProcessors) {
      const nextMsgs: PipelineMessage[] = []
      for (const m of msgs) {
        nextMsgs.push(...await proc(m, ctx))
      }
      msgs = nextMsgs
    }
    return msgs.map((m) => {
      const { [ERROR_KEY]: _cleared, ...metadata } = m.metadata
      return { ...m, metadata }
    })
  }
}
