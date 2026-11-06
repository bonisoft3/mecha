import { DurableObject } from 'cloudflare:workers'
import type { PGlite } from '@electric-sql/pglite'
import { DataDirectory, type Assets } from '../../pglite-workerd/src/data-directory.ts'
import type { PhysicalSnapshot, SnapshotNodes, SnapshotBlocks } from '../../pglite-workerd/src/physical-snapshot.ts'
import { createSnapshotCoordinator, type BatchMachine, type Computation, type SnapshotCoordinator } from '../../compute-snapshot/src/index.ts'
import type { ComputeCapture } from './compute.ts'

export type PhysicalPage = { kind: 'manifest'; value: PhysicalSnapshot } | { kind: 'nodes'; value: SnapshotNodes } | { kind: 'blocks'; value: SnapshotBlocks }

export const physicalSnapshotId = ({ identity }: ComputeCapture) => JSON.stringify({ id: identity.id, name: identity.name, version: identity.version, revision: identity.revision })
export const readerName = (capture: ComputeCapture) => JSON.stringify([capture.generation, capture.identity.id])

export function computeReader(assets: Assets, computations: Computation[], machine: BatchMachine) {
  return class extends DurableObject {
    readonly #dir = new DataDirectory(this.ctx.storage)
    #opened: Promise<{ db: PGlite; coordinator: SnapshotCoordinator }> | undefined
    #tail: Promise<unknown> = Promise.resolve()

    #serialize<T>(fn: () => T | Promise<T>): Promise<T> {
      const result = this.#tail.then(fn)
      this.#tail = result.then(() => undefined, () => undefined)
      return result
    }

    async #open() {
      const db = await this.#dir.open(assets)
      const coordinator = await createSnapshotCoordinator({ db, computations, machine, serialize: fn => fn() })
      return { db, coordinator }
    }

    #verify(capture: ComputeCapture) {
      if (this.ctx.storage.sql.exec("SELECT 1 FROM reader_released").toArray().length) throw new Error('compute reader was released')
      const status = this.#dir.snapshotImportStatus()
      if (status && (status.manifest.id !== physicalSnapshotId(capture) || status.manifest.sourceGeneration !== capture.generation)) {
        throw new Error('compute reader belongs to a different capture')
      }
    }

    async status(capture: ComputeCapture) {
      return await this.#serialize(() => {
        this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS reader_released (released INTEGER)')
        this.#verify(capture)
        return this.#dir.snapshotImportStatus()
      })
    }

    async advance(capture: ComputeCapture, page?: PhysicalPage): Promise<boolean> {
      return await this.#serialize(async () => {
        this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS reader_released (released INTEGER)')
        this.#verify(capture)
        if (page) {
          if (page.kind === 'manifest') {
            if (page.value.id !== physicalSnapshotId(capture) || page.value.sourceGeneration !== capture.generation) throw new Error('physical snapshot identity differs')
            this.#dir.beginSnapshotImport(page.value)
          } else if (page.kind === 'nodes') this.#dir.importSnapshotNodes(page.value)
          else if (page.kind === 'blocks') this.#dir.importSnapshotBlocks(page.value)
          else throw new Error('invalid physical snapshot page')
          return false
        }
        const status = this.#dir.snapshotImportStatus()
        if (!status || !status.nodesDone || status.nextFile) throw new Error('physical snapshot transfer is incomplete')
        if (!status.complete) this.#dir.finishSnapshotImport(status.manifest.id)
        const { coordinator } = await (this.#opened ??= this.#open())
        return await coordinator.materialize(capture.identity)
      })
    }

    async manifest(capture: ComputeCapture) {
      return await this.#serialize(async () => {
        this.#verify(capture)
        return await (await (this.#opened ??= this.#open())).coordinator.manifest(capture.identity)
      })
    }

    async chunk(capture: ComputeCapture, source: string, after: number) {
      return await this.#serialize(async () => {
        this.#verify(capture)
        return await (await (this.#opened ??= this.#open())).coordinator.chunk(capture.identity, source, after)
      })
    }

    async snapshot(capture: ComputeCapture) {
      return await this.#serialize(async () => {
        this.#verify(capture)
        return new Response(JSON.stringify(await (await (this.#opened ??= this.#open())).coordinator.snapshot(capture.identity)), {
          headers: { 'content-type': 'application/json' },
        })
      })
    }

    async release() {
      await this.#serialize(async () => {
        if (this.#opened) {
          const { coordinator, db } = await this.#opened
          await coordinator.stop()
          await db.close()
          this.#opened = undefined
        }
        await this.ctx.storage.deleteAll()
        this.ctx.storage.sql.exec('CREATE TABLE reader_released (released INTEGER)')
        this.ctx.storage.sql.exec('INSERT INTO reader_released VALUES (1)')
      })
    }
  }
}
