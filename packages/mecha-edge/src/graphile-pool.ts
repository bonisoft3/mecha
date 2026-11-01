// A pg.Pool's shape over the object's one PGlite connection, for Graphile
// Worker: it asks the pool for a client, queries it with text or
// {text, values}, and releases it. Every statement waits its turn on the
// object's serialize, and a transaction Graphile opens (its migrations do)
// holds the connection from begin to commit or rollback, so no other caller's
// statement lands inside it.
import type { PGlite, Transaction } from '@electric-sql/pglite'
import { EventEmitter } from 'node:events'

type Serialize = <T>(fn: () => Promise<T>, priority?: 'high' | 'low') => Promise<T>
type Query = string | { text: string; values?: unknown[] }

const statement = (q: Query, values?: unknown[]) =>
  typeof q === 'string' ? { text: q, values } : { text: q.text, values: q.values ?? values }

// pg answers rowCount; PGlite affectedRows, which it leaves unset for a read.
const answer = (r: { rows: unknown[]; affectedRows?: number; fields: unknown[] }) =>
  ({ rows: r.rows, fields: r.fields, rowCount: r.affectedRows ?? r.rows.length })

class Client extends EventEmitter {
  #tx: { tx: Transaction; end: (commit: boolean) => void; done: Promise<unknown> } | null = null

  constructor(private db: PGlite, private serialize: Serialize) {
    super()
  }

  async query(q: Query, values?: unknown[]) {
    const { text, values: args } = statement(q, values)
    const word = text.trim().toLowerCase()
    if (word === 'begin') return this.#begin()
    if (word === 'commit' || word === 'rollback') return this.#end(word === 'commit')
    if (this.#tx !== null) return answer(await this.#tx.tx.query(text, args))
    return answer(await this.serialize(() => this.db.query(text, args), 'low'))
  }

  release() {
    if (this.#tx !== null) throw new Error('a Graphile client was released inside its transaction')
  }

  async #begin() {
    if (this.#tx !== null) throw new Error('Graphile began a transaction inside another')
    let opened!: (tx: Transaction) => void
    let refused!: (e: unknown) => void
    const ready = new Promise<Transaction>((resolve, reject) => ((opened = resolve), (refused = reject)))
    let end!: (commit: boolean) => void
    const ended = new Promise<boolean>((resolve) => (end = resolve))
    const done = this.serialize(() =>
      this.db.transaction(async (tx) => {
        opened(tx)
        if (!(await ended)) await tx.rollback()
      }), 'low')
    // A BEGIN that failed never opens the callback: the caller hears it rather than waiting.
    done.catch(refused)
    this.#tx = { tx: await ready, end, done }
    return { rows: [], fields: [], rowCount: 0 }
  }

  async #end(commit: boolean) {
    const open = this.#tx ?? (() => { throw new Error(`Graphile ended a transaction it never began`) })()
    this.#tx = null
    open.end(commit)
    await open.done
    return { rows: [], fields: [], rowCount: 0 }
  }
}

export class GraphilePool extends EventEmitter {
  totalCount = 1
  idleCount = 1
  waitingCount = 0

  constructor(private db: PGlite, private serialize: Serialize) {
    super()
  }

  connect() {
    const client = new Client(this.db, this.serialize)
    this.emit('connect', client)
    return Promise.resolve(client)
  }

  query(q: Query, values?: unknown[]) {
    return new Client(this.db, this.serialize).query(q, values)
  }

  end() {
    return Promise.resolve()
  }
}
