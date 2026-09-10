import { describe, it, expect } from 'vitest'
import { parseCaddyRoutes, type CaddyRoute } from './caddy-to-msw.js'

// Minimal caddy adapt output matching mecha's Caddyfile
const CADDY_JSON = {
  apps: {
    http: {
      servers: {
        srv0: {
          listen: [':8080'],
          routes: [
            {
              match: [{ path: ['/crud/*'] }],
              handle: [
                { handler: 'subroute', routes: [
                  { handle: [{ handler: 'rewrite', strip_path_prefix: '/crud' }] },
                  { match: [{ method: ['POST'] }], handle: [
                    { handler: 'headers', request: { set: { Prefer: ['return=representation,resolution=ignore-duplicates'] } } }
                  ]},
                  { handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: 'crud:3000' }] }] },
                ]},
              ],
            },
            {
              match: [{ path: ['/health'] }],
              handle: [{ handler: 'static_response', body: 'OK', status_code: 200 }],
            },
            {
              handle: [{ handler: 'static_response', body: 'Not Found', status_code: 404 }],
            },
          ],
        },
      },
    },
  },
}

describe('parseCaddyRoutes', () => {
  it('extracts routes with path matchers', () => {
    const routes = parseCaddyRoutes(CADDY_JSON)

    const crudRoute = routes.find(r => r.pathPattern === '/crud/*')
    expect(crudRoute).toBeDefined()
    expect(crudRoute!.stripPrefix).toBe('/crud')
    expect(crudRoute!.upstream).toBe('crud:3000')
    expect(crudRoute!.headerOverrides?.POST?.Prefer).toBe(
      'return=representation,resolution=ignore-duplicates'
    )
  })

  it('extracts static response routes', () => {
    const routes = parseCaddyRoutes(CADDY_JSON)

    const healthRoute = routes.find(r => r.pathPattern === '/health')
    expect(healthRoute).toBeDefined()
    expect(healthRoute!.staticResponse).toEqual({ body: 'OK', status: 200 })
  })

  it('extracts catch-all route', () => {
    const routes = parseCaddyRoutes(CADDY_JSON)

    const catchAll = routes.find(r => r.pathPattern === '*')
    expect(catchAll).toBeDefined()
    expect(catchAll!.staticResponse).toEqual({ body: 'Not Found', status: 404 })
  })
})
