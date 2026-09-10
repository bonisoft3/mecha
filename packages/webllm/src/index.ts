import { pipeline, type TextGenerationPipeline } from "@huggingface/transformers"
import type { TextModel } from "@mecha/browser"
import { extractParams, templateResponse } from "./shim.js"

export { generateCardSvg } from "./shim.js"

/**
 * In-browser text model with a shim layer for structured output.
 *
 * The pipeline prompt asks for complex JSON (flashcard schema). A tiny model
 * can't reliably produce that. Instead:
 *
 * 1. extractParams() pulls topic/count/language from the complex prompt
 * 2. A simplified prompt ("list N things about X") goes to the tiny model
 * 3. The model returns a plain word list (its strength)
 * 4. templateResponse() wraps it into the exact JSON schema
 *
 * Model: HuggingFaceTB/SmolLM2-135M-Instruct (~80 MB q4, cached after first load).
 * Inference runs on WebGPU; falls back to WASM if unavailable.
 * Lazy: no download starts until generate() is first called.
 */
export class WebLLMTextModel implements TextModel {
  private pipe: TextGenerationPipeline | null = null
  private initPromise: Promise<void> | null = null
  private readonly modelId: string

  constructor(modelId = "HuggingFaceTB/SmolLM2-135M-Instruct") {
    this.modelId = modelId
  }

  private async init(): Promise<void> {
    if (this.pipe) return
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.pipe = (await pipeline("text-generation", this.modelId, {
          device: "webgpu",
          dtype: "q4",
        } as Record<string, unknown>)) as unknown as TextGenerationPipeline
      })()
    }
    await this.initPromise
  }

  async generate(
    messages: Array<{ role: string; content: string }>,
    _options?: { format?: unknown },
  ): Promise<string> {
    const prompt = messages.at(-1)?.content ?? ""
    const params = extractParams(prompt)

    await this.init()

    // Send a simple prompt the tiny model can handle
    const simplePrompt = [
      {
        role: "user" as const,
        content: `List exactly ${params.count} ${params.topic} in ${params.language}. Output one item per line, just the noun, nothing else.`,
      },
    ]

    const result = await this.pipe!(simplePrompt as Parameters<TextGenerationPipeline>[0], {
      max_new_tokens: 256,
      temperature: 0.7,
      return_full_text: false,
    })

    // Extract generated text — transformers.js returns different shapes:
    // text-generation: [{ generated_text: "..." }]
    // chat mode:       [{ generated_text: [{ role: "assistant", content: "..." }] }]
    const output = Array.isArray(result) ? result[0] : result
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const genText = (output as any)?.generated_text ?? output
    let raw: string
    if (typeof genText === "string") {
      raw = genText
    } else if (Array.isArray(genText)) {
      // Chat format: last message content
      const last = genText[genText.length - 1]
      raw = typeof last === "string" ? last : (last?.content ?? "")
    } else {
      raw = String(genText ?? "")
    }

    // Parse word list from model output
    const words = raw
      .split("\n")
      .map((line) => line.replace(/^\d+[.)]\s*/, "").trim()) // strip "1. " prefixes
      .filter((line) => line.length > 0 && line.length < 50) // skip empty/junk lines
      .slice(0, params.count)

    // Pad with topic words if model under-produced
    while (words.length < params.count) {
      words.push(`${params.topic} ${words.length + 1}`)
    }

    return JSON.stringify(templateResponse(words, params))
  }
}
