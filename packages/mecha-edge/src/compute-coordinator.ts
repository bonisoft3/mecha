import { DurableObject } from 'cloudflare:workers'
import type { Snapshot } from '../../compute-snapshot/src/index.ts'
import { serviceExecutor, computeFailureKey as failureKey } from './compute.ts'
import { strictJson, validateIdentity } from './snapshot-program.ts'
import { advancePaged, reclaimPaged, retainedPaged, type PagedDatabase } from './paged-coordinator.ts'

import type { ComputeCapture } from './compute.ts'
export type { ComputeCapture } from './compute.ts'

interface ComputeDatabase extends PagedDatabase {
  computeClaim(): Promise<ComputeCapture | null>
  computePrepare(capture: ComputeCapture): Promise<boolean>
  computeSnapshot(capture: ComputeCapture): Promise<Response>
  computePublish(capture: ComputeCapture, output: Response): Promise<void>
  computeReject(capture: ComputeCapture, error: string): Promise<void>
  computeWakeAt(): Promise<number | null>
}
interface ComputeEnv {
  CLUSTER: DurableObjectNamespace
  COMPUTE: Fetcher
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 16_384)

export function computeCoordinator(execute = (snapshot: Snapshot, env: ComputeEnv) => serviceExecutor(env.COMPUTE)(snapshot), paged: readonly string[] = [], owner?: string) {
  if (paged.length && !owner) throw new Error('paged computations require a compute owner')
  return class extends DurableObject<ComputeEnv> {
    async wake(): Promise<void> {
      await this.ctx.storage.transaction(async tx => {
        await tx.put('revision', (await tx.get<number>('revision') ?? 0) + 1)
        const alarm = await tx.getAlarm()
        if (alarm === null || alarm > Date.now()) await tx.setAlarm(Date.now())
      })
    }

    async #schedule(at: number | null, revision: number) {
      await this.ctx.storage.transaction(async tx => {
        // A source write during the remote call must survive its stale scheduling answer.
        if ((await tx.get<number>('revision') ?? 0) !== revision) at = Date.now()
        if (at === null) await tx.deleteAlarm()
        else await tx.setAlarm(at)
      })
    }

    async #activate(generation: string) {
      await this.ctx.storage.transaction(async tx => {
        if (await tx.get('generation') === generation) return
        const failures = await tx.list({ prefix: 'failure:' })
        if (failures.size) await tx.delete([...failures.keys()])
        await tx.put('generation', generation)
      })
    }

    async status() {
      return {
        alarm: await this.ctx.storage.getAlarm(),
        failure: await this.ctx.storage.get('failure') ?? null,
        failures: [...(await this.ctx.storage.list({ prefix: 'failure:' })).values()],
        retainedPaged: await retainedPaged(this.ctx.storage, owner),
      }
    }

    override async alarm(): Promise<void> {
      const revision = await this.ctx.storage.get<number>('revision') ?? 0
      // A lost RPC response or eviction leaves durable work and a future wake.
      await this.ctx.storage.setAlarm(Date.now() + 60_000)
      const cluster = this.env.CLUSTER.get(this.env.CLUSTER.idFromName('cluster')) as unknown as ComputeDatabase
      let rejected = false
      try {
        if (owner) await reclaimPaged(cluster, this.env.COMPUTE, this.ctx.storage, owner)
        const capture = await cluster.computeClaim()
        if (capture) {
          await this.#activate(capture.generation)
          try {
            let ready = false
            for (let step = 0; step < 16 && !ready; step++) ready = await cluster.computePrepare(capture)
            if (!ready) {
              await this.#schedule(Date.now(), revision)
              return
            }
            if (paged.includes(capture.identity.name)) {
              for (let step = 0; step < 16; step++) {
                if (await advancePaged(cluster, this.env.COMPUTE, this.ctx.storage, capture, owner!) !== 'transfer') break
              }
            } else {
              const response = await cluster.computeSnapshot(capture)
              if (!response.ok) throw new Error(`compute snapshot ${response.status}: ${await response.text()}`)
              const snapshot = await response.json() as Snapshot
              validateIdentity(snapshot, { ...capture.identity })
              const output = await execute(snapshot, this.env)
              await cluster.computePublish(capture, new Response(strictJson(output), { headers: { 'content-type': 'application/json' } }))
            }
            await this.ctx.storage.delete(failureKey(capture))
          } catch (error) {
            if (await cluster.computePublication(capture) === 'pending') {
              await this.ctx.storage.put(failureKey(capture), { ...capture, at: Date.now(), error: errorMessage(error) })
              await cluster.computeReject(capture, errorMessage(error))
              await this.#schedule(await cluster.computeWakeAt(), revision)
            } else {
              await this.ctx.storage.delete(failureKey(capture))
              // Publication can commit before its acknowledgement or remote cleanup fails.
              const cleanupAt = Date.now() + 60_000
              await this.#schedule(Math.min(await cluster.computeWakeAt() ?? cleanupAt, cleanupAt), revision)
            }
            rejected = true
            throw error
          }
        }
        await this.#schedule(await cluster.computeWakeAt(), revision)
        await this.ctx.storage.delete('failure')
      } catch (error) {
        if (!rejected) await this.ctx.storage.put('failure', { at: Date.now(), error: errorMessage(error) })
        throw error
      }
    }
  }
}

export class ComputeCoordinator extends computeCoordinator() {}
