// What the Worker and the object both check of a request. Apart from object.ts,
// whose cloudflare:workers import would keep worker.ts from loading outside workerd.

/** A provider's signal, in bytes: the Worker refuses a larger one before it reaches the object. */
export const SIGNAL_MAX_BYTES = 1024 * 1024
/** A path segment's key, or null where its percent-encoding is malformed. */
export function blobKeyOf(segment: string): string | null {
  try { return decodeURIComponent(segment) } catch (e) {
    if (e instanceof URIError) return null
    throw e
  }
}
