import { describe, it, expect } from "vitest"
import { compileCheck, createSwitchProcessor } from "./switch"
import { resolveProcessor } from "./registry"
import { loadPipelineYaml } from "../loader"
import { createMessage } from "../message"
import type { PipelineContext } from "../types"

const ctx: PipelineContext = {
  httpHandler: async () => new Response(null),
  env: { PROVIDER: "gemini", REMBG: "" },
}

describe("switch checks", () => {
  it("compares metadata, the environment and literals", () => {
    const msg = createMessage({}, { provider: "gemini" })
    expect(compileCheck('meta("provider") == "gemini"')(msg, ctx)).toBe(true)
    expect(compileCheck('meta("provider") != "gemini"')(msg, ctx)).toBe(false)
    expect(compileCheck('env("PROVIDER") == meta("provider")')(msg, ctx)).toBe(true)
    expect(compileCheck('"${REMBG}" != ""')(msg, ctx)).toBe(false)
    expect(compileCheck('"${PROVIDER}" != ""')(msg, ctx)).toBe(true)
  })

  it("reads meta() from the message alone", () => {
    expect(compileCheck('meta("PROVIDER") == "gemini"')(createMessage({}), ctx)).toBe(false)
  })

  // An unsupported check used to warn on every message and read as a case
  // that never matched, so the pipeline silently took another branch.
  it("refuses a check it cannot evaluate when the switch is built", () => {
    expect(() => compileCheck('this.kind == "a"')).toThrow("unsupported check")
    expect(() => compileCheck('meta("a") == "b" && meta("c") == "d"')).toThrow("unsupported check")
    expect(() => resolveProcessor({ switch: [{ check: "errored()", processors: [] }] } as never)).toThrow("unsupported check")
  })

  it("refuses it when the pipeline loads", () => {
    const yaml = [
      "pipeline:",
      "  processors:",
      "    - switch:",
      "        - check: 'this.kind == \"a\"'",
      "          processors: []",
      "output:",
      "  http_client:",
      "    url: /crud/x",
      "    verb: POST",
    ].join("\n")
    expect(() => loadPipelineYaml(yaml, "x")).toThrow("unsupported check")
  })

  it("runs the first matching case, or passes the message through", async () => {
    const tag = (value: string) => [{ jq: `{tag: "${value}"}` }]
    const cases = [
      { check: 'meta("provider") == "gemini"', processors: tag("gemini") },
      { processors: tag("default") },
    ]
    const proc = createSwitchProcessor(cases, cases.map((c) => c.processors.map(resolveProcessor)))
    const [gemini] = await proc(createMessage({}, { provider: "gemini" }), ctx)
    const [other] = await proc(createMessage({}, { provider: "local" }), ctx)
    expect(gemini.content).toEqual({ tag: "gemini" })
    expect(other.content).toEqual({ tag: "default" })

    const onlyChecked = [{ check: 'meta("provider") == "gemini"', processors: tag("gemini") }]
    const passthrough = createSwitchProcessor(onlyChecked, onlyChecked.map((c) => c.processors.map(resolveProcessor)))
    const [unchanged] = await passthrough(createMessage({ keep: true }, { provider: "local" }), ctx)
    expect(unchanged.content).toEqual({ keep: true })
  })
})
