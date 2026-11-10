export function strictJson(value: unknown): string {
  const result = JSON.stringify(value, (_key, v) => {
    if (v === undefined || typeof v === 'bigint' || typeof v === 'function' || typeof v === 'symbol' ||
      (typeof v === 'number' && !Number.isFinite(v))) throw new TypeError('computation returned a non-JSON value')
    return v
  })
  if (result === undefined) throw new TypeError('computation returned no value')
  return result
}
