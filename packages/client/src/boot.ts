import { electricCollectionOptions } from "./electric-collection.js"
import type { PlatformContext, CollectionAdapter } from "@mecha/collections"

export interface ClientConfig {
  /** ElectricSQL endpoint. Defaults to "/electric". */
  electricUrl?: string
  /** PostgREST CRUD endpoint. Defaults to "/crud". */
  crudUrl?: string
  /** Extra fields from browser config are silently ignored. */
  [key: string]: unknown
}

/**
 * Boot the client platform — synchronous, zero latency.
 *
 * Returns a PlatformContext with:
 * - adapter: wraps electricCollectionOptions (lazy ShapeStream connection)
 * - restHandler: proxies to CRUD URL via fetch
 *
 * No HTTP calls, no validation. ElectricSQL connects lazily on first
 * collection subscription.
 */
function resolveUrl(url: string): string {
  if (url.startsWith("http")) return url
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost"
  return `${origin}${url}`
}

export function bootPlatform(config?: ClientConfig): PlatformContext {
  const electricUrl = resolveUrl(config?.electricUrl ?? "/electric")
  const crudUrl = config?.crudUrl ?? "/crud"  // keep relative — browser fetch handles it

  const adapter: CollectionAdapter = {
    collectionOptions(table: string, key: string) {
      return electricCollectionOptions({ electricUrl, table, key })
    },
  }

  const restHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const downstream = url.pathname + url.search
    // Read body as text to avoid ReadableStream + duplex issues in browsers
    const body = req.method !== "GET" && req.method !== "HEAD"
      ? await req.text()
      : undefined
    // Build clean headers — don't forward Host from the synthetic Request
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => {
      if (k.toLowerCase() !== "host") headers[k] = v
    })
    return fetch(`${crudUrl}${downstream}`, {
      method: req.method,
      headers,
      body,
    })
  }

  return { adapter, restHandler }
}
