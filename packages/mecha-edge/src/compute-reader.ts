import { DurableObject } from 'cloudflare:workers'
import type { PGlite } from '@electric-sql/pglite'
import { DataDirectory, type Assets } from '../../pglite-workerd/src/data-directory.ts'
import type { PhysicalSnapshot, SnapshotNodes, SnapshotBlocks } from '../../pglite-workerd/src/physical-snapshot.ts'
import { createSnapshotCoordinator, type BatchMachine, type Computation, type SnapshotCoordinator } from '../../compute-snapshot/src/index.ts'
import type { ComputeCapture } from './compute.ts'

export type PhysicalPage = { kind: 'manifest'; value: PhysicalSnapshot } | { kind: 'nodes'; value: SnapshotNodes } | { kind: 'blocks'; value: SnapshotBlocks }

export const physicalSnapshotId = ({ identity }: ComputeCapture) => JSON.stringify({ id: identity.id, name: identity.name, version: identity.version, revision: identity.revision })
const sameCapture = (a: ComputeCapture, b: ComputeCapture) => a.generation === b.generation && physicalSnapshotId(a) === physicalSnapshotId(b)
export const readerName = (capture: ComputeCapture) => JSON.stringify([capture.generation, capture.identity.name, capture.identity.version])

export function computeReader(assets: Assets, computations: Computation[], machine: BatchMachine) {
  return class extends DurableObject {
    #dir = this.#directory()
    #directory() { return new DataDirectory(this.ctx.storage, undefined, error => { this.ctx.abort(error instanceof Error ? error.message : String(error)); throw error }) }
    #state() {
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS reader_state (slot INTEGER PRIMARY KEY, capture TEXT NOT NULL, retired INTEGER NOT NULL, base TEXT, restoring INTEGER NOT NULL)')
      return this.ctx.storage.sql.exec<{ capture: string; retired: number; base: string | null; restoring: number }>('SELECT capture,retired,base,restoring FROM reader_state WHERE slot=1').toArray()[0]
    }
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
      const state = this.#state()
      if (!state || !sameCapture(JSON.parse(state.capture), capture) || state.retired) throw new Error('compute reader belongs to a different capture')
    }

    async status(capture: ComputeCapture) {
      return await this.#serialize(() => {
        let state = this.#state()
        const value = JSON.stringify(capture)
        if (!state) {
          this.ctx.storage.sql.exec('INSERT INTO reader_state VALUES(1,?,0,NULL,0)', value)
        } else if (!sameCapture(JSON.parse(state.capture), capture)) {
          if (!state.retired || capture.identity.revision <= (JSON.parse(state.capture) as ComputeCapture).identity.revision) throw new Error('compute reader belongs to a different capture')
          this.ctx.storage.sql.exec('UPDATE reader_state SET capture=?,retired=0,restoring=? WHERE slot=1', value, state.base ? 1 : 0)
          state = this.#state()
          if (state.base) this.#dir.beginSnapshotRestore(state.base)
        } else if (state.retired) throw new Error('compute reader was released')
        state = this.#state()
        if (state.restoring) {
          this.#dir.beginSnapshotRestore(state.base!)
          if (!this.#dir.advanceSnapshotRestore(state.base!)) return { restoring: true, baseId: state.base, transfer: null }
          this.ctx.storage.sql.exec('UPDATE reader_state SET restoring=0 WHERE slot=1')
        }
        const transfer = this.#dir.snapshotImportStatus()
        if (transfer && transfer.manifest.id !== physicalSnapshotId(capture)) throw new Error('compute reader belongs to a different capture')
        if (transfer?.complete) {
          this.ctx.storage.sql.exec('UPDATE reader_state SET base=? WHERE slot=1', transfer.manifest.id)
          if (state.base && state.base !== transfer.manifest.id) this.#dir.releaseSnapshot(state.base)
          state = this.#state()
        }
        return { restoring: false, baseId: state.base, transfer }
      })
    }

    async advance(capture: ComputeCapture, page?: PhysicalPage): Promise<boolean> {
      return await this.#serialize(async () => {
        this.#verify(capture)
        if (page) {
          if (page.kind === 'manifest') {
            if (page.value.id !== physicalSnapshotId(capture) || page.value.sourceGeneration !== capture.generation) throw new Error('physical snapshot identity differs')
            this.#dir.beginSnapshotImport(page.value, this.#state().base ?? undefined)
          } else if (page.kind === 'nodes') this.#dir.importSnapshotNodes(page.value)
          else if (page.kind === 'blocks') this.#dir.importSnapshotBlocks(page.value)
          else throw new Error('invalid physical snapshot page')
          return false
        }
        const status = this.#dir.snapshotImportStatus()
        if (status?.preparing) { this.#dir.advanceSnapshotImport(status.manifest.id); return false }
        if (!status || !status.nodesDone || status.nextFile) throw new Error('physical snapshot transfer is incomplete')
        if (!status.complete) {
          this.#dir.finishSnapshotImport(status.manifest.id)
          return false
        }
        if (this.#state().base !== status.manifest.id) throw new Error('physical snapshot has not been acknowledged')
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

    async tableWal(capture: ComputeCapture, source: string, afterLsn: number) {
      return await this.#serialize(async () => {
        this.#verify(capture)
        const { coordinator } = await (this.#opened ??= this.#open())
        return coordinator.tableWal ? await coordinator.tableWal(capture.identity, source, afterLsn) : null
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

    async release(capture: ComputeCapture, destroy = false) {
      return await this.#serialize(async () => {
        const state = this.#state()
        if (!state || !destroy && !sameCapture(JSON.parse(state.capture), capture)) return null
        if (destroy && readerName(JSON.parse(state.capture)) !== readerName(capture)) throw new Error('compute reader belongs to a different computation')
        if (this.#opened) {
          const { coordinator, db } = await this.#opened
          await coordinator.stop()
          await db.close()
          this.#opened = undefined
          this.#dir = this.#directory()
        }
        const transfer = this.#dir.snapshotImportStatus()
        if (!destroy && transfer?.complete && transfer.manifest.id === physicalSnapshotId(capture) && state.base !== transfer.manifest.id) {
          this.ctx.storage.sql.exec('UPDATE reader_state SET base=? WHERE slot=1', transfer.manifest.id)
          if (state.base) this.#dir.releaseSnapshot(state.base)
        }
        const base = this.#state().base
        if (destroy || !base) {
          for (const snapshot of this.#dir.snapshots()) this.#dir.releaseSnapshot(snapshot.id)
          this.#dir.reset()
          this.ctx.storage.sql.exec('UPDATE reader_state SET base=NULL,retired=1,restoring=0 WHERE slot=1')
        } else this.ctx.storage.sql.exec('UPDATE reader_state SET retired=1 WHERE slot=1')
        return destroy ? null : base
      })
    }
  }
}
