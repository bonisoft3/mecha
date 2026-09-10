import type { PipelineMessage, ProcessorFn, BranchProcessorConfig, PipelineContext } from "../types.js"
import { createBloblangProcessor } from "./bloblang.js"

export function createBranchProcessor(
  config: BranchProcessorConfig,
  subProcessors: ProcessorFn[],
): ProcessorFn {
  return async (msg: PipelineMessage, ctx: PipelineContext): Promise<PipelineMessage[]> => {
    let branchMsg = msg
    if (config.request_map) {
      // request_map is always bloblang in rpk
      const mapper = createBloblangProcessor(config.request_map)
      const mapped = await mapper(msg, ctx)
      if (mapped.length > 0) branchMsg = mapped[0]
    }

    let msgs = [branchMsg]
    for (const proc of subProcessors) {
      const nextMsgs: PipelineMessage[] = []
      for (const m of msgs) {
        nextMsgs.push(...await proc(m, ctx))
      }
      msgs = nextMsgs
    }

    if (config.result_map === "") {
      return [msg]
    }
    return msgs
  }
}
