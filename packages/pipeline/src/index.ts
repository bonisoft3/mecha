// Types
export type {
  PipelineMessage,
  ProcessorStep,
  PipelineConfig,
  PipelineContext,
  PipelineOutputConfig,
  HttpProcessorConfig,
  BranchProcessorConfig,
  ProcessorFn,
} from "./types.js"

// Message model
export { createMessage, injectMetadata, extractMetadata, interpolate } from "./message.js"

// Executor
export { executePipeline } from "./executor.js"

// CDC listener
export { createCDCPipelineListener } from "./cdc.js"

// YAML loader
export { loadPipelineYaml } from "./loader.js"

// Bloblang runtime injection
export { setBloblangRuntime } from "./processors/bloblang.js"

// Processors (for direct use)
export { createJqProcessor } from "./processors/jq.js"
export { createHttpProcessor } from "./processors/http.js"
export { createBranchProcessor } from "./processors/branch.js"
export { createUnarchiveProcessor } from "./processors/unarchive.js"
export { createTryProcessor, createCatchProcessor } from "./processors/try-catch.js"
export { createLogProcessor } from "./processors/log.js"
export { resolveProcessor } from "./processors/registry.js"
