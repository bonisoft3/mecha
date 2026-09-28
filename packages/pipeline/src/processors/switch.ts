import type { PipelineMessage, ProcessorFn, ProcessorStep, PipelineContext } from "../types.js"

export interface SwitchCase {
  check?: string
  processors: ProcessorStep[]
}

type Check = (msg: PipelineMessage, ctx: PipelineContext) => boolean
type Operand = (msg: PipelineMessage, ctx: PipelineContext) => string

const OPERAND = String.raw`(?:meta|env)\(\s*"\w+"\s*\)|"[^"]*"`
const CHECK = new RegExp(String.raw`^\s*(${OPERAND})\s*(==|!=)\s*(${OPERAND})\s*$`)

function operand(text: string): Operand {
  const call = text.match(/^(meta|env)\(\s*"(\w+)"\s*\)$/)
  if (call) {
    const key = call[2]
    return call[1] === "meta"
      ? (msg) => msg.metadata[key] ?? ""
      : (_msg, ctx) => ctx.env[key] ?? ""
  }
  // rpk substitutes `${VAR}` when it loads the config; here the environment
  // arrives with the context, so the literal is completed per evaluation.
  const literal = text.slice(1, -1)
  return (_msg, ctx) => literal.replace(/\$\{(\w+)\}/g, (_, name: string) => ctx.env[name] ?? "")
}

/**
 * The bloblang checks this runtime evaluates: two operands, each `meta("k")`,
 * `env("k")` or a double-quoted string, compared with `==` or `!=`. Anything
 * else is refused here, when the pipeline is built, rather than read as a
 * case that never matches.
 */
export function compileCheck(check: string): Check {
  const parts = check.match(CHECK)
  if (!parts) {
    throw new Error(
      `[pipeline] switch: unsupported check ${JSON.stringify(check)}; ` +
        `a check compares meta("k"), env("k") or a "string" with == or !=`,
    )
  }
  const left = operand(parts[1])
  const right = operand(parts[3])
  const equal = parts[2] === "=="
  return (msg, ctx) => (left(msg, ctx) === right(msg, ctx)) === equal
}

/**
 * Create a switch processor that evaluates cases in order: the first case
 * whose check matches, or that has none, runs its processors. A message no
 * case matches passes through.
 */
export function createSwitchProcessor(
  cases: SwitchCase[],
  resolvedCases: ProcessorFn[][],
): ProcessorFn {
  const checks = cases.map((c) => (c.check === undefined ? null : compileCheck(c.check)))
  return async (msg: PipelineMessage, ctx: PipelineContext): Promise<PipelineMessage[]> => {
    for (let i = 0; i < cases.length; i++) {
      const check = checks[i]
      if (check && !check(msg, ctx)) continue

      let msgs = [msg]
      for (const proc of resolvedCases[i]) {
        const next: PipelineMessage[] = []
        for (const m of msgs) next.push(...await proc(m, ctx))
        msgs = next
      }
      return msgs
    }
    return [msg]
  }
}
