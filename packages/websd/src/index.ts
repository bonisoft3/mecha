import type { ImageModel } from "@mecha/browser"

/**
 * Canvas-based image generator for browser mode.
 *
 * Instead of downloading a 2GB+ diffusion model, renders a visually
 * distinct placeholder image per card using <canvas>:
 *
 * - Gradient background (color-hashed from the prompt)
 * - Large emoji matching the subject
 * - Word label at the bottom
 *
 * Returns base64 PNG. Instant, zero download, deterministic.
 */

// Emoji lookup by common flashcard categories
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
  guitar: "🎸", piano: "🎹", drum: "🥁", ball: "⚽", bicycle: "🚲",
}
const DEFAULT_EMOJI = "✨"

// Pastel gradient pairs keyed by hash
const GRADIENTS: Array<[string, string]> = [
  ["#FFE0B2", "#FFCC80"], // warm orange
  ["#C8E6C9", "#A5D6A7"], // soft green
  ["#BBDEFB", "#90CAF9"], // sky blue
  ["#E1BEE7", "#CE93D8"], // lavender
  ["#FFF9C4", "#FFF176"], // sunny yellow
  ["#F8BBD0", "#F48FB1"], // pink
  ["#B2EBF2", "#80DEEA"], // teal
  ["#D7CCC8", "#BCAAA4"], // warm grey
]

function hashString(s: string): number {
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

function findEmoji(prompt: string): string {
  const lower = prompt.toLowerCase()
  for (const [key, emoji] of Object.entries(EMOJI_MAP)) {
    if (lower.includes(key)) return emoji
  }
  return DEFAULT_EMOJI
}

function extractSubject(prompt: string): string {
  // "A simple illustration of elephant on a white background" → "elephant"
  const match = prompt.match(/(?:illustration|photograph|picture|image|drawing)\s+of\s+(?:a\s+|an\s+)?(.+?)(?:\s+on\s+|\s+with\s+|$)/i)
  if (match) return match[1].trim()
  // Fallback: first few words
  return prompt.split(/\s+/).slice(0, 3).join(" ")
}

// Minimal 1×1 transparent PNG for environments without OffscreenCanvas
const FALLBACK_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

export class WebSDImageModel implements ImageModel {
  async generate(prompt: string): Promise<string> {
    const subject = extractSubject(prompt)
    const emoji = findEmoji(prompt)
    const hash = hashString(subject)
    const [color1, color2] = GRADIENTS[hash % GRADIENTS.length]

    // Use OffscreenCanvas if available (browser), fallback for tests
    if (typeof OffscreenCanvas === "undefined") {
      return FALLBACK_PNG
    }

    const size = 512
    const canvas = new OffscreenCanvas(size, size)
    const ctx = canvas.getContext("2d")!

    // Gradient background
    const grad = ctx.createLinearGradient(0, 0, size, size)
    grad.addColorStop(0, color1)
    grad.addColorStop(1, color2)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)

    // Large emoji
    ctx.font = "180px serif"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(emoji, size / 2, size / 2 - 30)

    // Label at bottom
    ctx.font = "bold 36px Inter, sans-serif"
    ctx.fillStyle = "#333"
    ctx.fillText(subject, size / 2, size - 60)

    // Convert to base64 PNG
    const blob = await canvas.convertToBlob({ type: "image/png" })
    const arrayBuffer = await blob.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    let binary = ""
    for (const byte of bytes) {
      binary += String.fromCharCode(byte)
    }
    return btoa(binary)
  }
}
