// The dev server answers with whatever the REST handler returns, and the head
// it builds from that Response used to collapse repeated headers: Set-Cookie
// is the one a Response may carry more than once, and an object keeps the last.
import { describe, expect, it } from 'vitest'
import { responseHeaders } from '../src/dev-server.js'

describe('the head a Response becomes', () => {
  it('keeps every Set-Cookie, not the last', () => {
    const response = new Response('ok')
    response.headers.append('set-cookie', 'a=1; Path=/')
    response.headers.append('set-cookie', 'b=2; Path=/')
    expect(responseHeaders(response)['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/'])
  })

  it('carries the other headers as single values', () => {
    const response = new Response('ok', { headers: { 'content-type': 'application/json' } })
    expect(responseHeaders(response)['content-type']).toBe('application/json')
    expect(responseHeaders(response)['set-cookie']).toBeUndefined()
  })
})
