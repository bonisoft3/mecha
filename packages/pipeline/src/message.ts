import type { PipelineMessage } from "./types.js"

/** Create a new pipeline message from raw content. */
export function createMessage(content: unknown, metadata?: Record<string, string>): PipelineMessage {
  return {
    content,
    metadata: metadata ?? {},
  }
}

/**
 * Merge the message's metadata into its content under `._meta` for jq. Object
 * content becomes a new merged object; non-object content passes through as-is.
 */
export function injectMetadata(msg: PipelineMessage): string | object {
  if (typeof msg.content !== "object" || msg.content === null) {
    return msg.content as string | object
  }
  return { ...msg.content as Record<string, unknown>, _meta: { ...msg.metadata } }
}

/**
 * Extract ._meta from content back into metadata after jq processing.
 * Returns updated message with metadata extracted and ._meta removed from content.
 */
export function extractMetadata(msg: PipelineMessage): PipelineMessage {
  if (typeof msg.content !== "object" || msg.content === null) {
    return msg
  }
  const content = msg.content as Record<string, unknown>
  const meta = content._meta as Record<string, string> | undefined
  if (!meta) return msg

  const { _meta, ...rest } = content
  return {
    content: rest,
    metadata: { ...msg.metadata, ...meta },
  }
}

/**
 * Interpolate template variables in a string.
 * Supports both @mecha/pipeline and rpk syntax:
 * - ${_meta.key} → message metadata (pipeline style)
 * - ${! meta("key")} → message metadata (rpk style)
 * - ${VAR} → environment variable
 */
export function interpolate(
  template: string,
  msg: PipelineMessage,
  env: Record<string, string>,
): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
    // rpk style: ${! meta("key")} or ${! meta("key") }
    const rpkMeta = key.match(/^!\s*meta\(\s*"([^"]+)"\s*\)/)
    if (rpkMeta) {
      return msg.metadata[rpkMeta[1]] ?? ""
    }
    // pipeline style: ${_meta.key}
    if (key.startsWith("_meta.")) {
      return msg.metadata[key.slice(6)] ?? ""
    }
    return env[key] ?? ""
  })
}
