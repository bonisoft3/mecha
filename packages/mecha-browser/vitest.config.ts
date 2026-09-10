import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@mecha/bloblang-js': resolve(__dirname, '../bloblang-js/src/index.ts'),
      '@mecha/conduit-js': resolve(__dirname, '../conduit-js/src/index.ts'),
      '@mecha/postgrest-js': resolve(__dirname, '../postgrest-js/src/index.ts'),
      '@mecha/tanstackdb-pglite': resolve(__dirname, '../tanstackdb-pglite/src/index.ts'),
      '@mecha/caddy-js': resolve(__dirname, '../caddy-js/src/index.ts'),
      '@mecha/rclone-js': resolve(__dirname, '../rclone-js/src/index.ts'),
    },
  },
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 5000,
    forceExit: true,
  },
})
