/**
 * The two JSON rules a computation's values cross every host by, on the
 * server, on the edge and in the browser alike.
 *
 * `strictJson` is what a computation may hand over: JSON once each value's
 * `toJSON` has run, refusing what JSON cannot hold before and after it runs.
 * `losslessJson` is what the step loop and publication keep: plain data whose
 * numbers survive a round trip, which `parseLossless` reads back.
 */

const at = (key: string) => key === '' ? 'value' : key

export function strictJson(value: unknown, sortKeys = false): string {
  const result = JSON.stringify(value, function (this: Record<string, unknown>, key, v) {
    for (const x of [this[key], v]) {
      if (typeof x === 'number' && !Number.isFinite(x)) throw new TypeError(`${at(key)}: ${x} is no JSON number`)
      if (x === undefined || typeof x === 'bigint' || typeof x === 'function' || typeof x === 'symbol') {
        throw new TypeError(`${at(key)}: a ${typeof x} is no JSON value`)
      }
    }
    if (sortKeys && typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
    }
    return v
  })
  if (result === undefined) throw new TypeError('value: no JSON value')
  return result
}

const lossless = (v: unknown) =>
  typeof v !== 'number' || (Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)))

export function losslessJson(value: unknown): string {
  const visit = (v: unknown, path: string): void => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return
    if (typeof v === 'number' && lossless(v)) return
    if (Array.isArray(v)) return v.forEach((item, i) => visit(item, `${path}[${i}]`))
    if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      for (const [k, item] of Object.entries(v)) visit(item, `${path}.${k}`)
      return
    }
    throw new Error(`${path} is not finite lossless JSON`)
  }
  visit(value, 'value')
  return JSON.stringify(value)
}

export function parseLossless(text: string): unknown {
  return JSON.parse(text, (key, v) => {
    if (!lossless(v)) throw new Error(`${at(key)} is not finite lossless JSON`)
    return v
  })
}
