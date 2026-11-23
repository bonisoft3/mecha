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

/** Auth cookies span the host; unrelated upstreams must not receive them. */
export function withoutAuthCookies(req: Request): Request {
  if (new URL(req.url).pathname.startsWith('/auth/')) return req
  const cookie = req.headers.get('cookie')
  if (cookie === null) return req
  const filtered = cookie.replace(/(^|;)[ \t]*(__Host-)?mecha_(session(_held)?|oidc_state(_[A-Za-z0-9_-]+)?)=[^;]*/g, '')
  if (filtered === cookie) return req
  const headers = new Headers(req.headers)
  if (filtered) headers.set('cookie', filtered)
  else headers.delete('cookie')
  return new Request(req, { headers })
}
