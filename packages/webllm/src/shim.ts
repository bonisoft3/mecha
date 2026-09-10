/**
 * Pure functions for the ShimTextModel.
 *
 * extractParams() pulls topic/count/language/category from the pipeline's
 * complex prompt. templateResponse() wraps a word list into the exact
 * flashcard JSON schema the pipeline expects.
 */

export interface PromptParams {
  topic: string
  count: number
  language: string
  category: string
  difficulty: string
}

/**
 * Extract structured parameters from the pipeline's freeform prompt.
 *
 * The prompt contains lines like:
 *   "Generate 5 such cards about: Jungle animals"
 *   "Audience: Toddler. Language: English. Category: animals"
 */
export function extractParams(prompt: string): PromptParams {
  const countMatch = prompt.match(/Generate\s+(\d+)\s+such cards about:\s*(.+)/i)
  const count = countMatch ? parseInt(countMatch[1], 10) : 5
  const topic = countMatch ? countMatch[2].trim().split("\n")[0] : "things"

  const langMatch = prompt.match(/Language:\s*([^.\n]+)/i)
  const language = langMatch ? langMatch[1].trim() : "English"

  const catMatch = prompt.match(/Category:\s*([^.\n"]+)/i)
  const category = catMatch ? catMatch[1].trim() : "general"

  const diffMatch = prompt.match(/Audience:\s*([^.\n]+)/i)
  const difficulty = diffMatch ? diffMatch[1].trim() : "easy"

  return { topic, count, language, category, difficulty }
}

export interface FlashcardOutput {
  setMetadata: {
    name: string
    description: string
    category: string
    tags: string[]
  }
  flashcards: Array<{
    front_text: string
    back_text: string
    image_description: string
    hint: string
    difficulty: string
    category: string
    image_url: string
  }>
}

// Emoji lookup for common flashcard subjects
const EMOJI_MAP: Record<string, string> = {
  lion: "🦁", tiger: "🐯", elephant: "🐘", monkey: "🐒", giraffe: "🦒",
  dog: "🐕", cat: "🐱", bird: "🐦", fish: "🐟", rabbit: "🐇",
  bear: "🐻", horse: "🐴", cow: "🐄", pig: "🐷", sheep: "🐑",
  apple: "🍎", banana: "🍌", strawberry: "🍓", grape: "🍇", orange: "🍊",
  watermelon: "🍉", cherry: "🍒", pear: "🍐", peach: "🍑", lemon: "🍋",
  chair: "🪑", table: "🪵", lamp: "💡", clock: "🕐", spoon: "🥄",
  book: "📚", pencil: "✏️", star: "⭐", sun: "☀️", moon: "🌙",
  car: "🚗", bus: "🚌", train: "🚆", plane: "✈️", boat: "🚢",
  house: "🏠", tree: "🌳", flower: "🌸", mountain: "⛰️", ocean: "🌊",
}

// Pastel gradient pairs
const GRADIENTS: Array<[string, string]> = [
  ["#FFE0B2", "#FFCC80"], ["#C8E6C9", "#A5D6A7"], ["#BBDEFB", "#90CAF9"],
  ["#E1BEE7", "#CE93D8"], ["#FFF9C4", "#FFF176"], ["#F8BBD0", "#F48FB1"],
  ["#B2EBF2", "#80DEEA"], ["#D7CCC8", "#BCAAA4"],
]

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

function findEmoji(word: string): string {
  const lower = word.toLowerCase()
  for (const [key, emoji] of Object.entries(EMOJI_MAP)) {
    if (lower.includes(key)) return emoji
  }
  return "✨"
}

/**
 * Generate a data URL SVG image for a flashcard word.
 * Avoids the full image pipeline (S3 + imgproxy don't exist in browser mode).
 */
export function generateCardSvg(word: string): string {
  const emoji = findEmoji(word)
  const hash = hashStr(word)
  const [c1, c2] = GRADIENTS[hash % GRADIENTS.length]
  const label = word.trim().toLowerCase()

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
  </linearGradient></defs>
  <rect width="512" height="512" fill="url(#g)" rx="32"/>
  <text x="256" y="220" text-anchor="middle" font-size="180">${emoji}</text>
  <text x="256" y="420" text-anchor="middle" font-family="Inter,sans-serif" font-weight="bold" font-size="36" fill="#333">${label}</text>
</svg>`

  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * Wrap a list of words into the flashcard JSON schema the pipeline expects.
 *
 * Includes image_url as a data URL SVG — this prevents the image pipeline
 * from triggering (its CDC filter skips cards with non-empty image_url).
 * No S3/imgproxy needed in browser mode.
 */
export function templateResponse(
  words: string[],
  params: PromptParams,
): FlashcardOutput {
  return {
    setMetadata: {
      name: capitalize(params.topic),
      description: `${capitalize(params.topic)} flashcards`,
      category: params.category,
      tags: [params.category, params.language.toLowerCase()],
    },
    flashcards: words.map((w) => ({
      front_text: w.trim().toLowerCase(),
      back_text: "",
      image_description: `A simple illustration of ${w.trim()} on a white background`,
      hint: "",
      difficulty: params.difficulty.toLowerCase(),
      category: params.category,
      image_url: generateCardSvg(w),
    })),
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
