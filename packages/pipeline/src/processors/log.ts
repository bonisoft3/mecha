import type { PipelineMessage, ProcessorFn, PipelineContext } from "../types.js"
import { interpolate } from "../message.js"

export function createLogProcessor(config: { message: string; level?: string }): ProcessorFn {
  return async (msg: PipelineMessage, ctx: PipelineContext): Promise<PipelineMessage[]> => {
    const text = interpolate(config.message, msg, ctx.env)
    const level = config.level?.toLowerCase() ?? "info"
    if (level === "error") console.error(`[pipeline] ${text}`)
    else if (level === "warn") console.warn(`[pipeline] ${text}`)
    else console.log(`[pipeline] ${text}`)
    return [msg]
  }
}
