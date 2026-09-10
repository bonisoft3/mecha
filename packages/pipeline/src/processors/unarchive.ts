import type { PipelineMessage, ProcessorFn, PipelineContext } from "../types.js"
import { createMessage } from "../message.js"

export function createUnarchiveProcessor(format: string): ProcessorFn {
  return async (msg: PipelineMessage, _ctx: PipelineContext): Promise<PipelineMessage[]> => {
    if (format !== "json_array") {
      throw new Error(`Unsupported unarchive format: ${format}`)
    }
    if (!Array.isArray(msg.content)) {
      return []
    }
    return msg.content.map((item) => createMessage(item, { ...msg.metadata }))
  }
}
