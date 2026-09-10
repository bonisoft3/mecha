import type { PipelineConfig as JqPipelineConfig } from '@mecha/pipeline'
import type { PipelineConfig as BloblangPipelineConfig } from '@mecha/conduit-js'
import type { PGlite } from '@electric-sql/pglite'
import type { TextModel, ImageModel } from './model-handler.js'

/** Configuration for browser platform boot. */
export interface BrowserConfig {
  /** Optional text model for in-browser inference (WebLLM, etc.). */
  textModel?: TextModel
  /** Optional image model for in-browser inference (ONNX SD, etc.). */
  imageModel?: ImageModel
  /** SQL string to initialize PGlite (migrations + triggers). */
  schema: string
  /** Table names for CDC listener. */
  tables: string[]
  /** @deprecated Use pipelineConfigs instead. CDC pipeline definitions (bloblang WASM). */
  pipelines?: BloblangPipelineConfig[]
  /** @deprecated Use pipelineConfigs instead. URL or path to the blobl.wasm binary. */
  wasmUrl?: string
  /** jq-based pipeline configs for CDC processing. */
  pipelineConfigs?: JqPipelineConfig[]
  /** Environment variables for pipeline interpolation (e.g. GEMINI_API_KEY). */
  env?: Record<string, string>
  /** Optional seed data loader (called after schema init). */
  seedData?: (pglite: PGlite) => Promise<void>
  /**
   * Resolves the signed-in subject's scopes, as `subject_scopes` does on a
   * server. Supplying it switches PGlite off the superuser it connects as --
   * superusers bypass RLS entirely, so without this every policy in `schema` is
   * inert while looking correct.
   *
   * Omit it only for a schema that has no policies. Re-apply on identity change
   * with `applyScopeSession` from `@mecha/postgrest-js`.
   */
  scopes?: (req?: Request) => string[] | Promise<string[]>
  /** The non-superuser role the schema's policies are written against. */
  role?: string
  /**
   * App-provided service substitutes, registered on the MSW worker beside
   * /crud. Path is an MSW pattern ("/img/*"); the resolver sees the raw
   * Request so apps never import msw themselves.
   */
  routes?: Array<{ path: string; resolver: (request: Request) => Response | Promise<Response> }>
}

export type { BloblangPipelineConfig as PipelineConfig, JqPipelineConfig }
