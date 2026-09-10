import yaml from "js-yaml"
import type { PipelineConfig, ProcessorStep, PipelineOutputConfig } from "./types.js"

/**
 * Load a pipeline config from rpk-format YAML string.
 *
 * Reads the `pipeline.processors` and `output.http_client` sections.
 * The `input` section is ignored — @mecha/pipeline uses its own CDC input
 * (pg_notify in browser). rpk uses the input section directly.
 *
 * The `table` for CDC routing is inferred from the first jq processor's
 * select() filter, or can be overridden via the `table` parameter.
 */
export function loadPipelineYaml(yamlStr: string, table: string): PipelineConfig {
  const doc = yaml.load(yamlStr) as Record<string, unknown>

  const pipelineSection = doc.pipeline as { processors: ProcessorStep[] } | undefined
  if (!pipelineSection?.processors) {
    throw new Error("Pipeline YAML must have a pipeline.processors section")
  }

  // Extract output config
  const outputSection = doc.output as Record<string, unknown> | undefined
  let outputConfig: PipelineOutputConfig

  if (outputSection?.http_client) {
    // Direct http_client
    outputConfig = outputSection.http_client as PipelineOutputConfig
  } else if (outputSection?.retry) {
    // Wrapped in retry
    const retry = outputSection.retry as Record<string, unknown>
    const inner = retry.output as Record<string, unknown>
    if (inner?.http_client) {
      outputConfig = inner.http_client as PipelineOutputConfig
    } else {
      throw new Error("Pipeline YAML output must have an http_client (directly or inside retry)")
    }
  } else {
    throw new Error("Pipeline YAML must have an output.http_client section")
  }

  return {
    input: { cdc: { table } },
    pipeline: { processors: pipelineSection.processors },
    output: { http_client: outputConfig },
  }
}
