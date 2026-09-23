import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import { createRestHandler } from '@mecha/postgrest-js'
import { BloblangRuntime } from '@mecha/bloblang-js'
import { PipelineRegistry, createCDCListener } from '@mecha/conduit-js'
import type { BrowserConfig } from './types.js'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'

/**
 * Minimal dev server entry point.
 *
 * Usage: `pnpm --dir packages/mecha-browser run dev`, which runs this under
 * deno: these packages are TypeScript sources whose relative imports carry a
 * `.js` suffix, and resolving that to the `.ts` beside it is what
 * --unstable-sloppy-imports does. node would need them built first.
 *
 * Initializes PGlite in-memory, wires the factory based on active profiles,
 * and starts an HTTP server on localhost:8080.
 */

/**
 * The head a Response becomes. Set-Cookie is the one header it may carry more
 * than once, and the entries iterator yields each separately, so collapsing
 * them into an object would keep only the last.
 */
export function responseHeaders(response: Response): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = Object.fromEntries(response.headers)
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) headers['set-cookie'] = cookies
  return headers
}

/**
 * One Web fetch handler over node's server: a Request in, a Response out. The
 * handler below is written to that shape and to no runtime's own server API,
 * so this adapter is the whole of what the runtime contributes.
 */
function serve(port: number, handler: (req: Request) => Promise<Response>): { stop: () => void } {
  const server = createServer((incoming, outgoing) => {
    const answer = async () => {
      const host = incoming.headers.host ?? `localhost:${port}`
      const url = new URL(incoming.url ?? '/', `http://${host}`)
      const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD'
      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers as HeadersInit,
        // node's web stream and the DOM's differ only in their declarations.
        ...(hasBody ? { body: Readable.toWeb(incoming) as unknown as BodyInit, duplex: 'half' } : {}),
      } as RequestInit)
      const response = await handler(request)
      outgoing.writeHead(response.status, responseHeaders(response))
      if (response.body && incoming.method !== 'HEAD') {
        Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream).pipe(outgoing)
      } else {
        outgoing.end()
      }
    }
    answer().catch((err) => {
      if (!outgoing.headersSent) outgoing.writeHead(500)
      outgoing.destroy(err)
      process.exit(1)
    })
  })
  server.listen(port)
  return { stop: () => server.close() }
}

function parseArgs(args: string[]): { profile: string } {
  let profile = 'crud'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile' && args[i + 1]) {
      profile = args[i + 1]
      i++
    }
  }
  return { profile }
}

const DEMO_SCHEMA = `
CREATE TABLE IF NOT EXISTS "hello" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "message" TEXT NOT NULL,
  "processed_at" TEXT,
  "source" TEXT,
  PRIMARY KEY ("id")
);

CREATE OR REPLACE FUNCTION mecha_notify_cdc() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('cdc', json_build_object(
    'table', TG_TABLE_NAME,
    'op', TG_OP,
    'row', row_to_json(NEW)
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hello_cdc ON "hello";
CREATE TRIGGER hello_cdc
AFTER INSERT ON "hello"
FOR EACH ROW EXECUTE FUNCTION mecha_notify_cdc();
`

const DEMO_MAPPING = `root = if this.processed_at == null {
  { "processed_at": now().ts_format("2006-01-02T15:04:05Z"), "source": "mecha-dev-server" }
} else {
  deleted()
}`

async function main() {
  const { profile } = parseArgs(process.argv.slice(2))
  console.log(`[mecha-dev] Starting with profile: ${profile}`)

  // 1. Initialize PGlite (in-memory for dev)
  const pglite = await PGlite.create({
    extensions: { live },
  })
  await pglite.exec(DEMO_SCHEMA)
  console.log('[mecha-dev] PGlite initialized with demo schema')

  // 2. Create REST handler
  const restHandler = createRestHandler(pglite)

  // 3. Optionally wire CDC (for events profile)
  let cdcCleanup: (() => Promise<void>) | undefined
  if (profile === 'events' || profile === 'full') {
    try {
      const registry = new PipelineRegistry()
      registry.register({
        name: 'hello_enrich',
        table: 'hello',
        mapping: DEMO_MAPPING,
      })

      // Create a stub runtime for dev (bloblang WASM may not be available)
      const runtime: { execute: (m: string, i: Record<string, unknown>) => Promise<Record<string, unknown>>; destroy: () => void } = {
        async execute(_mapping: string, input: Record<string, unknown>) {
          // Simplified enrichment for dev mode
          if (input.processed_at == null) {
            return {
              processed_at: new Date().toISOString(),
              source: 'mecha-dev-server',
            }
          }
          return {}
        },
        destroy() {},
      }

      cdcCleanup = await createCDCListener({ pglite, registry, runtime })
      console.log('[mecha-dev] CDC listener started')
    } catch (err) {
      console.warn('[mecha-dev] CDC setup failed (WASM may not be available):', err)
    }
  }

  // 4. Start HTTP server
  const port = 8080
  const server = serve(port, async (req: Request): Promise<Response> => {
      const url = new URL(req.url)

      // Health check
      if (url.pathname === '/health') {
        return new Response(JSON.stringify({ status: 'ok', profile }), {
          headers: { 'content-type': 'application/json' },
        })
      }

      // Route all /crud/* to PostgREST handler
      if (url.pathname.startsWith('/crud/')) {
        // Rewrite URL to strip /crud prefix for the rest handler
        const restUrl = new URL(req.url)
        restUrl.pathname = url.pathname.slice(5) // Remove '/crud'
        const restReq = new Request(restUrl.toString(), {
          method: req.method,
          headers: req.headers,
          body: req.body,
        })
        return restHandler(restReq)
      }

      return new Response('Not Found', { status: 404 })
  })

  console.log(`[mecha-dev] Server listening on http://localhost:${port}`)
  console.log(`[mecha-dev] Try: curl -X POST http://localhost:${port}/crud/hello -H "Content-Type: application/json" -d '{"message": "test"}'`)

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n[mecha-dev] Shutting down...')
    if (cdcCleanup) await cdcCleanup()
    server.stop()
    await pglite.close()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('[mecha-dev] Fatal error:', err)
  process.exit(1)
})
