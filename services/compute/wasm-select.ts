export function normalizeSelect(select: unknown): string[] | undefined {
  if (select === undefined) return undefined;
  if (
    !Array.isArray(select) || select.length === 0 ||
    !select.every((k) => typeof k === "string" && k.length > 0)
  ) {
    throw new TypeError("WASM output select must be a non-empty list of field names");
  }
  return [...new Set(select)];
}

export function projectOutput(raw: string, select?: readonly string[]): string {
  const parsed = JSON.parse(raw);
  if (!select) return raw;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("selected WASM output must be a JSON object");
  }
  const picked: Record<string, unknown> = {};
  for (const key of select) {
    if (Object.hasOwn(parsed, key)) {
      picked[key] = (parsed as Record<string, unknown>)[key];
    }
  }
  return JSON.stringify(picked);
}
