// Browser-safe exports (no Node.js dependencies)
export { makeS3Handler } from './s3-handler.js'
export { createIdbBlobStorage } from './idb-storage.js'
export type { BlobStorage } from './types.js'
export { TraversalError } from './types.js'

// Node.js exports (fs-backed storage) — import from '@mecha/rclone-js/node'
// or use createFsBlobStorage / createS3Handler directly from './fs-storage.js'
