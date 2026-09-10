/** A message flowing through the pipeline. */
export interface PipelineMessage {
  /** The message body — jq operates on this as "." */
  content: unknown
  /** Metadata carried across processors — injected as ._meta in jq */
  metadata: Record<string, string>
}

/** A single processor step in a pipeline. */
export type ProcessorStep =
  | { jq: string | { query: string } }
  | { bloblang: string }
  | { http: HttpProcessorConfig }
  | { branch: BranchProcessorConfig }
  | { unarchive: { format: "json_array" } }
  | { try: ProcessorStep[] }
  | { catch: ProcessorStep[] }
  | { log: { message: string; level?: string } }

export interface HttpProcessorConfig {
  url: string
  verb: string
  headers?: Record<string, string>
  timeout?: string
}

export interface BranchProcessorConfig {
  /** rpk format: bloblang string. Parsed by @mecha/pipeline's bloblang processor. */
  request_map?: string
  processors: ProcessorStep[]
  result_map: string
}

export interface PipelineOutputConfig {
  url: string
  verb: string
  headers?: Record<string, string>
}

export interface PipelineConfig {
  input: { cdc: { table: string } }
  pipeline: { processors: ProcessorStep[] }
  output: { http_client: PipelineOutputConfig }
}

/** Context provided to processors for HTTP and env access. */
export interface PipelineContext {
  /** HTTP handler — fetch in container, MSW-intercepted fetch in browser */
  httpHandler: (req: Request) => Promise<Response>
  /** Environment variables for ${VAR} interpolation */
  env: Record<string, string>
}

/** A processor function: takes message + context, returns messages (0 or more). */
export type ProcessorFn = (
  msg: PipelineMessage,
  ctx: PipelineContext,
) => Promise<PipelineMessage[]>
