import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import { createRestHandler, applyScopeSession } from '@mecha/postgrest-js'
import { pgliteCollectionOptions } from '@mecha/tanstackdb-pglite'
import type { PlatformContext, CollectionAdapter } from '@mecha/collections'
import type { BrowserConfig } from './types.js'
import { createModelHandler } from './model-handler.js'

/**
 * Boot the browser platform — async, heavy.
 *
 * Creates PGlite, loads schema, optionally wires CDC + MSW + seed data.
 * Returns PlatformContext with adapter backed by pgliteCollectionOptions.
 */
export async function bootPlatform(config: BrowserConfig): Promise<PlatformContext> {
  // 1. Create PGlite with live extension
  const pglite = await PGlite.create('idb://mecha', {
    extensions: { live },
  })
  await pglite.exec(config.schema)

  // 2. Create rest handler
  const restHandler = createRestHandler(
    pglite,
    config.scopes ? { scopes: (req) => config.scopes!(req), role: config.role } : undefined,
  )

  // 3. Create adapter
  const adapter: CollectionAdapter = {
    collectionOptions(table: string, key: string) {
      return pgliteCollectionOptions({ pglite, table, key })
    },
  }

  // 4. Wire CDC pipelines if configured
  let cdcCleanup: (() => void) | undefined
  if (config.pipelineConfigs && config.pipelineConfigs.length > 0) {
    const { createCDCPipelineListener, setBloblangRuntime } = await import('@mecha/pipeline')

    // Load bloblang WASM for pipelines that use bloblang processors
    if (config.wasmUrl) {
      const { BloblangRuntime } = await import('@mecha/bloblang-js')
      const runtime = await BloblangRuntime.fromUrls(
        config.wasmUrl,
        config.wasmUrl.replace('blobl.wasm', 'wasm_exec.js')
      )
      setBloblangRuntime(runtime)
    }

    const pipelineCtx = {
      httpHandler: createModelHandler(
        {
          textModel: config.textModel,
          imageModel: config.imageModel,
          textModelUrl: config.env?.TEXT_MODEL_URL,
          imageModelUrl: config.env?.IMAGE_MODEL_URL,
        },
        async (req: Request) => fetch(req)
      ),
      env: config.env ?? {},
    }

    cdcCleanup = await createCDCPipelineListener(pglite, config.pipelineConfigs, pipelineCtx)
  } else if (config.pipelines && config.pipelines.length > 0 && config.wasmUrl) {
    // Legacy bloblang pipeline engine (deprecated)
    const { BloblangRuntime } = await import('@mecha/bloblang-js')
    const { PipelineRegistry, createCDCListener } = await import('@mecha/conduit-js')

    const runtime = await BloblangRuntime.fromUrls(
      config.wasmUrl,
      config.wasmUrl.replace('blobl.wasm', 'wasm_exec.js')
    )

    const registry = new PipelineRegistry()
    for (const p of config.pipelines) {
      registry.register(p)
    }

    const cleanup = await createCDCListener({ pglite, registry, runtime })
    const legacyCleanup = async () => {
      await cleanup()
      runtime.destroy()
    }
    cdcCleanup = () => { legacyCleanup() }
  }

  // 5. Start MSW worker
  const { setupWorker } = await import('msw/browser')
  const { http, HttpResponse } = await import('msw')

  const crudHandler = http.all('/crud/*', async ({ request }) => {
    const url = new URL(request.url)
    const downstream = url.pathname.replace(/^\/crud/, '') + url.search
    const mechaUrl = `http://mecha${downstream}`
    const forwarded = new Request(mechaUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // @ts-expect-error -- duplex
      duplex: 'half',
    })
    const res = await restHandler(forwarded)
    return new HttpResponse(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
    })
  })

  const extraHandlers = (config.routes ?? []).map((r) =>
    http.all(r.path, ({ request }) => r.resolver(request)),
  )
  const worker = setupWorker(crudHandler, ...extraHandlers)
  await worker.start({ onUnhandledRequest: 'bypass' })

  // 6. Load seed data if configured
  if (config.seedData) {
    await config.seedData(pglite)
  }

  // 7. Last because seeding spans scopes and runs as the owner, which the floor
  // would refuse under a role.
  //
  // A CDC pipeline sink writes on this session, so it writes confined to the
  // reader's scopes, where the cluster's `service` holds BYPASSRLS and writes
  // across them.
  if (config.scopes) {
    await applyScopeSession(pglite, await config.scopes(), config.role)
  }

  return {
    adapter,
    restHandler,
    destroy: async () => {
      worker.stop()
      if (cdcCleanup) await cdcCleanup()
      await pglite.close()
    },
  }
}
