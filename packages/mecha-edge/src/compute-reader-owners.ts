import type { ComputeCapture } from './compute.ts'

export class ComputeReaderOwners {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS compute_reader_bases (owner TEXT NOT NULL, reader_key TEXT NOT NULL, capture TEXT NOT NULL, PRIMARY KEY(owner,reader_key))')
    sql.exec('CREATE TABLE IF NOT EXISTS compute_reader_owners (owner TEXT NOT NULL, capture_key TEXT NOT NULL, capture TEXT NOT NULL, PRIMARY KEY(owner,capture_key))')
  }

  retain(owner: string, capture: ComputeCapture) {
    const key = JSON.stringify([capture.generation, capture.identity.id])
    const value = JSON.stringify(capture)
    const [prior] = this.sql.exec<{ capture: string }>('SELECT capture FROM compute_reader_owners WHERE owner=? AND capture_key=?', owner, key).toArray()
    if (prior) {
      const saved = JSON.parse(prior.capture) as ComputeCapture
      if (saved.identity.name !== capture.identity.name || saved.identity.version !== capture.identity.version || saved.identity.revision !== capture.identity.revision) throw new Error('retained reader identity differs')
      return
    }
    this.sql.exec('INSERT INTO compute_reader_owners VALUES(?,?,?)', owner, key, value)
  }

  list(): { owner: string; capture: ComputeCapture }[] {
    return this.sql.exec<{ owner: string; capture: string }>('SELECT owner,capture FROM compute_reader_owners ORDER BY owner,capture_key').toArray()
      .map(row => ({ owner: row.owner, capture: JSON.parse(row.capture) }))
  }

  base(owner: string, capture: ComputeCapture): ComputeCapture | null {
    const key = JSON.stringify([capture.generation, capture.identity.name, capture.identity.version])
    const [row] = this.sql.exec<{ capture: string }>('SELECT capture FROM compute_reader_bases WHERE owner=? AND reader_key=?', owner, key).toArray()
    return row ? JSON.parse(row.capture) : null
  }

  promote(owner: string, capture: ComputeCapture) {
    const key = JSON.stringify([capture.generation, capture.identity.name, capture.identity.version])
    const prior = this.base(owner, capture)
    if (prior && prior.identity.revision > capture.identity.revision) return false
    if (prior && prior.identity.revision === capture.identity.revision && prior.identity.id !== capture.identity.id) throw new Error('reader base identity differs')
    this.sql.exec('INSERT OR REPLACE INTO compute_reader_bases VALUES(?,?,?)', owner, key, JSON.stringify(capture))
    return true
  }

  bases(): { owner: string; capture: ComputeCapture }[] {
    return this.sql.exec<{ owner: string; capture: string }>('SELECT owner,capture FROM compute_reader_bases').toArray().map(row => ({ owner: row.owner, capture: JSON.parse(row.capture) }))
  }

  pinned(capture: ComputeCapture): boolean {
    return this.bases().some(({ capture: saved }) => saved.generation === capture.generation && saved.identity.id === capture.identity.id && saved.identity.name === capture.identity.name && saved.identity.version === capture.identity.version && saved.identity.revision === capture.identity.revision)
  }

  clearBase(owner: string, capture: ComputeCapture) {
    const key = JSON.stringify([capture.generation, capture.identity.name, capture.identity.version])
    this.sql.exec('DELETE FROM compute_reader_bases WHERE owner=? AND reader_key=?', owner, key)
  }

  async release(owner: string, capture: ComputeCapture, release: () => Promise<void>) {
    const key = JSON.stringify([capture.generation, capture.identity.id])
    if (!this.sql.exec('SELECT 1 FROM compute_reader_owners WHERE owner=? AND capture_key=?', owner, key).toArray().length) return
    await release()
    this.sql.exec('DELETE FROM compute_reader_owners WHERE owner=? AND capture_key=?', owner, key)
  }
}
