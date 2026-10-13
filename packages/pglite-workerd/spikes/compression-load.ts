import { gzipSync } from 'node:zlib'
import { load } from '../load.ts'

const [origin, pgdata, tokenFile] = Deno.args
if (!origin || !pgdata || !tokenFile) throw new Error('compression-load.ts <probe-origin> <pgdata-directory> <token-file>')
const token = (await Deno.readTextFile(tokenFile)).trim()
if (!token) throw new Error('empty probe token')
const result = await load(pgdata, async (route, init) => {
  const headers = new Headers(init?.headers)
  headers.set('authorization', `Bearer ${token}`)
  let body = init?.body
  if (route.startsWith('chunk?') && body instanceof Uint8Array) {
    body = new Uint8Array(gzipSync(body, { level: 1 }))
    headers.set('content-encoding', 'gzip')
  }
  return fetch(`${origin}/import/${route}`, { ...init, body, headers })
})
console.log(JSON.stringify(result))
