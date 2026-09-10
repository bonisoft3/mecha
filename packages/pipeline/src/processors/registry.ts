import type { ProcessorStep, ProcessorFn } from "../types.js"
import { createJqProcessor } from "./jq.js"
import { createHttpProcessor } from "./http.js"
import { createBranchProcessor } from "./branch.js"
import { createUnarchiveProcessor } from "./unarchive.js"
import { createTryProcessor, createCatchProcessor } from "./try-catch.js"
import { createLogProcessor } from "./log.js"
import { createBloblangProcessor } from "./bloblang.js"
import { createSwitchProcessor, type SwitchCase } from "./switch.js"

export function resolveProcessor(step: ProcessorStep): ProcessorFn {
  if ("jq" in step) {
    const query = typeof step.jq === "string" ? step.jq : step.jq.query
    return createJqProcessor(query)
  }
  if ("bloblang" in step) return createBloblangProcessor(step.bloblang)
  if ("http" in step) return createHttpProcessor(step.http)
  if ("unarchive" in step) return createUnarchiveProcessor(step.unarchive.format)
  if ("log" in step) return createLogProcessor(step.log)
  if ("try" in step) return createTryProcessor(step.try.map(resolveProcessor))
  if ("catch" in step) return createCatchProcessor(step.catch.map(resolveProcessor))
  if ("branch" in step) {
    const subProcessors = step.branch.processors.map(resolveProcessor)
    return createBranchProcessor(step.branch, subProcessors)
  }
  if ("switch" in step) {
    const cases = (step as unknown as { switch: SwitchCase[] }).switch
    const resolvedCases = cases.map((c) => c.processors.map(resolveProcessor))
    return createSwitchProcessor(cases, resolvedCases)
  }
  // retry: no-op in the browser — rpk's retry is a server-side concept.
  // We just run the inner processors in sequence; the executor's own
  // drop-on-error path handles failures. A shared YAML file can therefore
  // use retry: for the container pipeline without breaking browser loading.
  if ("retry" in step) {
    const subs = (step as unknown as { retry: { processors: ProcessorStep[] } })
      .retry.processors.map(resolveProcessor)
    return async (msg, ctx) => {
      let msgs = [msg]
      for (const proc of subs) {
        const next = []
        for (const m of msgs) next.push(...await proc(m, ctx))
        msgs = next
      }
      return msgs
    }
  }
  throw new Error(`Unknown processor: ${JSON.stringify(Object.keys(step))}`)
}
