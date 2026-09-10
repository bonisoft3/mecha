import { describe, it, expect } from "vitest"
import { extractParams, templateResponse, generateCardSvg } from "./shim.js"

// This is the actual prompt shape the pipeline sends (from snapcards-text-gen.yaml)
const PIPELINE_PROMPT = `You are generating flashcards for a **visual dictionary** app used worldwide by kids learning new words.
Each flashcard has exactly two sides:
  SIDE A: a picture of a single subject (nothing else).
  SIDE B: the name of that subject, like a label under the picture.

Generate 3 such cards about: Jungle animals like lion, tiger, elephant
Audience: Toddler. Language: English. Category: animals

FIELD RULES:

front_text — the NAME of the subject, in English.
OUTPUT — JSON only, no markdown, no code fences:`

describe("extractParams", () => {
  it("extracts count from pipeline prompt", () => {
    const params = extractParams(PIPELINE_PROMPT)
    expect(params.count).toBe(3)
  })

  it("extracts topic from pipeline prompt", () => {
    const params = extractParams(PIPELINE_PROMPT)
    expect(params.topic).toBe("Jungle animals like lion, tiger, elephant")
  })

  it("extracts language from pipeline prompt", () => {
    const params = extractParams(PIPELINE_PROMPT)
    expect(params.language).toBe("English")
  })

  it("extracts category from pipeline prompt", () => {
    const params = extractParams(PIPELINE_PROMPT)
    expect(params.category).toBe("animals")
  })

  it("extracts difficulty/audience from pipeline prompt", () => {
    const params = extractParams(PIPELINE_PROMPT)
    expect(params.difficulty).toBe("Toddler")
  })

  it("returns defaults for a bare prompt", () => {
    const params = extractParams("Make some cards please")
    expect(params.count).toBe(5)
    expect(params.topic).toBe("things")
    expect(params.language).toBe("English")
  })
})

describe("templateResponse", () => {
  it("produces valid flashcard JSON from a word list", () => {
    const result = templateResponse(["lion", "tiger"], {
      topic: "jungle animals",
      count: 2,
      language: "English",
      category: "animals",
      difficulty: "easy",
    })

    expect(result.setMetadata.name).toBe("Jungle animals")
    expect(result.setMetadata.category).toBe("animals")
    expect(result.setMetadata.tags).toEqual(["animals", "english"])
    expect(result.flashcards).toHaveLength(2)
  })

  it("sets front_text to lowercase word", () => {
    const result = templateResponse(["Lion"], {
      topic: "animals",
      count: 1,
      language: "English",
      category: "animals",
      difficulty: "easy",
    })

    expect(result.flashcards[0].front_text).toBe("lion")
  })

  it("sets back_text and hint to empty string", () => {
    const result = templateResponse(["apple"], {
      topic: "fruits",
      count: 1,
      language: "English",
      category: "food",
      difficulty: "easy",
    })

    expect(result.flashcards[0].back_text).toBe("")
    expect(result.flashcards[0].hint).toBe("")
  })

  it("generates image_description from the word", () => {
    const result = templateResponse(["elephant"], {
      topic: "animals",
      count: 1,
      language: "English",
      category: "animals",
      difficulty: "easy",
    })

    expect(result.flashcards[0].image_description).toContain("elephant")
    expect(result.flashcards[0].image_description).toContain("white background")
  })

  it("includes image_url as a data URL SVG", () => {
    const result = templateResponse(["lion"], {
      topic: "animals",
      count: 1,
      language: "English",
      category: "animals",
      difficulty: "easy",
    })

    expect(result.flashcards[0].image_url).toMatch(/^data:image\/svg\+xml,/)
  })
})

describe("generateCardSvg", () => {
  it("returns a data URL SVG", () => {
    const url = generateCardSvg("lion")
    expect(url).toMatch(/^data:image\/svg\+xml,/)
  })

  it("includes the emoji for known words", () => {
    const url = generateCardSvg("lion")
    const svg = decodeURIComponent(url.replace("data:image/svg+xml,", ""))
    expect(svg).toContain("🦁")
  })

  it("includes the word label", () => {
    const url = generateCardSvg("elephant")
    const svg = decodeURIComponent(url.replace("data:image/svg+xml,", ""))
    expect(svg).toContain("elephant")
  })

  it("uses default emoji for unknown words", () => {
    const url = generateCardSvg("xylophone")
    const svg = decodeURIComponent(url.replace("data:image/svg+xml,", ""))
    expect(svg).toContain("✨")
  })
})
