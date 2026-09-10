import type { PipelineMessage, ProcessorFn, ProcessorStep, PipelineContext } from "../types.js"

export interface SwitchCase {
  check?: string
  processors: ProcessorStep[]
}

/**
 * Create a switch processor that evaluates cases in order.
 *
 * Each case has an optional `check` (bloblang expression) and a `processors` array.
 * The first case whose check matches (or has no check — default) is executed.
 *
 * Checks are evaluated by simple string interpolation of meta() values
 * and equality comparison — covers the rpk switch patterns used in practice
 * (e.g. `meta("provider") == "gemini"`).
 */
export function createSwitchProcessor(
  cases: SwitchCase[],
  resolvedCases: ProcessorFn[][],
): ProcessorFn {
  return async (msg: PipelineMessage, ctx: PipelineContext): Promise<PipelineMessage[]> => {
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i]

      if (c.check) {
        if (!evaluateCheck(c.check, msg, ctx)) continue
      }

      // Matched — run this case's processors in sequence
      let msgs = [msg]
      for (const proc of resolvedCases[i]) {
        const next: PipelineMessage[] = []
        for (const m of msgs) next.push(...await proc(m, ctx))
        msgs = next
      }
      return msgs
    }

    // No case matched — pass through
    return [msg]
  }
}

/**
 * Evaluate a simple bloblang check expression against message metadata.
 *
 * Supports patterns like:
 *   meta("key") == "value"
 *   meta("key") != "value"
 */
function evaluateCheck(
  check: string,
  msg: PipelineMessage,
  ctx: PipelineContext,
): boolean {
  // meta("key") == "value"
  const eqMatch = check.match(/meta\(\s*"(\w+)"\s*\)\s*==\s*"([^"]*)"/)
  if (eqMatch) {
    const metaVal = resolveMetaValue(eqMatch[1], msg, ctx)
    return metaVal === eqMatch[2]
  }

  // meta("key") != "value"
  const neqMatch = check.match(/meta\(\s*"(\w+)"\s*\)\s*!=\s*"([^"]*)"/)
  if (neqMatch) {
    const metaVal = resolveMetaValue(neqMatch[1], msg, ctx)
    return metaVal !== neqMatch[2]
  }

  // Unknown check — treat as non-matching
  console.warn(`[pipeline] switch: unsupported check expression: ${check}`)
  return false
}

function resolveMetaValue(key: string, msg: PipelineMessage, ctx: PipelineContext): string {
  // Check message metadata first, then env vars
  return msg.metadata[key] ?? ctx.env[key] ?? ""
}
