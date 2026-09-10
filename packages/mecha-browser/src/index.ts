// Platform boot
export { bootPlatform } from './factory.js'
export type { BrowserConfig } from './types.js'

// Model handler
export { createModelHandler } from './model-handler.js'
export type { TextModel, ImageModel, ModelHandlerConfig } from './model-handler.js'

// Re-export shared types
export type { PlatformContext, CollectionAdapter, CollectionTableConfig } from '@mecha/collections'
export { createCollections } from '@mecha/collections'

// Re-export browser-safe APIs
export { makeS3Handler, createIdbBlobStorage, TraversalError } from '@mecha/rclone-js'
export type { BlobStorage } from '@mecha/rclone-js'
