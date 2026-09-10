export interface CaddyRoute {
  pathPattern: string
  stripPrefix?: string
  upstream?: string
  headerOverrides?: Record<string, Record<string, string>>
  staticResponse?: { body: string; status: number }
}

/**
 * Parse Caddy JSON config (output of `caddy adapt`) into simplified route descriptors.
 * These can be mapped to MSW handlers via a backend map.
 */
export function parseCaddyRoutes(caddyJson: Record<string, any>): CaddyRoute[] {
  const results: CaddyRoute[] = []
  const servers = caddyJson?.apps?.http?.servers ?? {}

  for (const server of Object.values(servers) as any[]) {
    for (const route of server.routes ?? []) {
      const pathPattern = route.match?.[0]?.path?.[0] ?? '*'
      const parsed = parseHandlers(route.handle ?? [], pathPattern)
      results.push(...parsed)
    }
  }

  return results
}

function parseHandlers(handlers: any[], pathPattern: string): CaddyRoute[] {
  let stripPrefix: string | undefined
  let upstream: string | undefined
  let staticResponse: { body: string; status: number } | undefined

  for (const h of handlers) {
    if (h.handler === 'subroute') {
      return parseSubroute(h.routes ?? [], pathPattern)
    }
    if (h.handler === 'rewrite' && h.strip_path_prefix) {
      stripPrefix = h.strip_path_prefix
    }
    if (h.handler === 'reverse_proxy' && h.upstreams?.[0]?.dial) {
      upstream = h.upstreams[0].dial
    }
    if (h.handler === 'static_response') {
      staticResponse = { body: h.body ?? '', status: h.status_code ?? 200 }
    }
  }

  return [{ pathPattern, stripPrefix, upstream, staticResponse }]
}

function parseSubroute(subroutes: any[], pathPattern: string): CaddyRoute[] {
  let stripPrefix: string | undefined
  let upstream: string | undefined
  const headerOverrides: Record<string, Record<string, string>> = {}

  for (const sub of subroutes) {
    for (const h of sub.handle ?? []) {
      if (h.handler === 'rewrite' && h.strip_path_prefix) {
        stripPrefix = h.strip_path_prefix
      }
      if (h.handler === 'reverse_proxy' && h.upstreams?.[0]?.dial) {
        upstream = h.upstreams[0].dial
      }
      if (h.handler === 'headers' && h.request?.set) {
        const methods = sub.match?.[0]?.method ?? ['*']
        for (const method of methods) {
          headerOverrides[method] = {}
          for (const [key, values] of Object.entries(h.request.set as Record<string, string[]>)) {
            headerOverrides[method][key] = values[0]
          }
        }
      }
    }
  }

  const result: CaddyRoute = { pathPattern, stripPrefix, upstream }
  if (Object.keys(headerOverrides).length > 0) {
    result.headerOverrides = headerOverrides
  }
  return [result]
}
