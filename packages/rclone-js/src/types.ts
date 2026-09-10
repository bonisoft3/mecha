/**
 * Storage interface — swappable backend (fs for Node.js/tests, IndexedDB for browser).
 */
export interface BlobStorage {
  read(bucket: string, key: string): Promise<{ data: ArrayBuffer; contentType: string } | null>
  write(bucket: string, key: string, data: ArrayBuffer, contentType: string): Promise<void>
  delete(bucket: string, key: string): Promise<boolean>
  head(bucket: string, key: string): Promise<{ size: number; contentType: string } | null>
  list(bucket: string, prefix: string): Promise<Array<{ key: string; size: number }>>
}

export class TraversalError extends Error {
  constructor() {
    super('Bad Request: path traversal detected')
    this.name = 'TraversalError'
  }
}
