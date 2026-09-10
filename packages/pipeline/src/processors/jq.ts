import { json as jqJson } from "jq-wasm"
import type { PipelineMessage, ProcessorFn, PipelineContext } from "../types.js"
import { createMessage, injectMetadata, extractMetadata } from "../message.js"

/**
 * Split a jq filter string on top-level ' | ' pipes only
 * (ignoring pipes inside parentheses, brackets, braces, or strings).
 */
function splitTopLevelPipes(filter: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let inStr = false
  for (let i = 0; i < filter.length; i++) {
    const c = filter[i]
    if (c === '"' && filter[i - 1] !== "\\") inStr = !inStr
    if (inStr) continue
    if (c === "(" || c === "[" || c === "{") depth++
    else if (c === ")" || c === "]" || c === "}") depth--
    else if (depth === 0 && filter.slice(i, i + 3) === " | ") {
      parts.push(filter.slice(start, i))
      start = i + 3
      i += 2
    }
  }
  parts.push(filter.slice(start))
  return parts
}

/**
 * Capture ._meta after any update-expression mutations in the filter,
 * even when the final stage is a projection that drops ._meta.
 *
 * Strategy: try progressively shorter prefixes of the filter (split on
 * top-level pipes) until one produces an object with ._meta. Falls back
 * to the original metadata when no prefix yields ._meta.
 */
async function extractMutatedMeta(
  input: string | object,
  filter: string,
  originalMeta: Record<string, string>,
): Promise<Record<string, string>> {
  const parts = splitTopLevelPipes(filter)
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join(" | ")
    try {
      const meta = await jqJson(input, `${prefix} | ._meta`)
      if (meta !== null && typeof meta === "object") {
        return { ...originalMeta, ...(meta as Record<string, string>) }
      }
    } catch {
      // prefix produced a scalar or errored — try shorter prefix
    }
  }
  return originalMeta
}

/**
 * Create a jq processor that transforms message content.
 *
 * Metadata is injected as ._meta before the jq expression runs,
 * and extracted back after. If jq returns null (e.g. from select()),
 * the message is deleted (filtered out).
 *
 * Mutations to ._meta within the filter are captured even when the
 * final stage is a projection that drops ._meta from its output.
 */
export function createJqProcessor(filter: string): ProcessorFn {
  return async (msg: PipelineMessage, _ctx: PipelineContext): Promise<PipelineMessage[]> => {
    const input = injectMetadata(msg)
    const result = await jqJson(input, filter)

    // null = deleted (filtered out by select())
    if (result === null || result === undefined) {
      return []
    }

    // Capture _meta mutations applied within the filter pipeline,
    // including cases where the final stage is a projection that drops _meta.
    const mergedMetadata = await extractMutatedMeta(input, filter, { ...msg.metadata })

    const outMsg = createMessage(result, mergedMetadata)
    return [extractMetadata(outMsg)]
  }
}
