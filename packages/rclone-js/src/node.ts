// Node.js-only exports (filesystem storage)
export { createFsBlobStorage, createS3Handler } from './fs-storage.js'

// Re-export browser-safe APIs for convenience
export { makeS3Handler } from './s3-handler.js'
export { createIdbBlobStorage } from './idb-storage.js'
export type { BlobStorage } from './types.js'
export { TraversalError } from './types.js'
