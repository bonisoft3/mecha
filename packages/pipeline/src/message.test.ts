import { describe, it, expect } from "vitest"
import { createMessage, injectMetadata, extractMetadata, interpolate } from "./message"

describe("createMessage", () => {
  it("creates a message with content and empty metadata", () => {
    const msg = createMessage({ name: "test" })
    expect(msg.content).toEqual({ name: "test" })
    expect(msg.metadata).toEqual({})
  })

  it("creates a message with provided metadata", () => {
    const msg = createMessage({ name: "test" }, { id: "123" })
    expect(msg.metadata).toEqual({ id: "123" })
  })
})

describe("injectMetadata", () => {
  it("adds _meta to object content", () => {
    const msg = createMessage({ name: "test" }, { id: "123" })
    const injected = injectMetadata(msg)
    expect(injected).toEqual({ name: "test", _meta: { id: "123" } })
  })

  it("returns non-object content unchanged", () => {
    const msg = createMessage("string", { id: "123" })
    expect(injectMetadata(msg)).toBe("string")
  })
})

describe("extractMetadata", () => {
  it("extracts _meta from content into metadata", () => {
    const msg = createMessage({ name: "test", _meta: { id: "456" } }, { id: "123" })
    const extracted = extractMetadata(msg)
    expect(extracted.content).toEqual({ name: "test" })
    expect(extracted.metadata).toEqual({ id: "456" })
  })

  it("preserves message without _meta", () => {
    const msg = createMessage({ name: "test" }, { id: "123" })
    const extracted = extractMetadata(msg)
    expect(extracted.content).toEqual({ name: "test" })
    expect(extracted.metadata).toEqual({ id: "123" })
  })
})

describe("interpolate", () => {
  it("replaces ${VAR} with env values", () => {
    const msg = createMessage({})
    expect(interpolate("key=${API_KEY}", msg, { API_KEY: "abc" })).toBe("key=abc")
  })

  it("replaces ${_meta.key} with metadata values", () => {
    const msg = createMessage({}, { request_id: "r1" })
    expect(interpolate("/crud/table?id=eq.${_meta.request_id}", msg, {})).toBe("/crud/table?id=eq.r1")
  })

  it("replaces missing values with empty string", () => {
    const msg = createMessage({})
    expect(interpolate("${MISSING}", msg, {})).toBe("")
  })
})
