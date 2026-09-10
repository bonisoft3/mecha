import { mkdir, readFile, writeFile, unlink, stat, readdir } from 'node:fs/promises'
import { join, dirname, relative, resolve } from 'node:path'
import type { BlobStorage } from './types.js'
import { TraversalError } from './types.js'
import { makeS3Handler } from './s3-handler.js'

// --- Security helpers ---

function escapesRoot(allowedRoot: string, resolvedPath: string): boolean {
  const rel = relative(allowedRoot, resolvedPath)
  return rel.startsWith('..')
}

function objectPath(rootDir: string, bucket: string, key: string): string {
  const allowed = resolve(rootDir)
  const target = resolve(rootDir, bucket, key)
  if (escapesRoot(allowed, target)) throw new TraversalError()
  return target
}

function bucketPath(rootDir: string, bucket: string): string {
  const allowed = resolve(rootDir)
  const target = resolve(rootDir, bucket)
  if (escapesRoot(allowed, target)) throw new TraversalError()
  return target
}

function metaPath(dataPath: string): string {
  return dataPath + '.meta'
}

async function collectFiles(dir: string, baseDir: string): Promise<Array<{ absPath: string; relKey: string }>> {
  const results: Array<{ absPath: string; relKey: string }> = []
  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(dir, { withFileTypes: true }) as any
  } catch {
    return results
  }
  for (const entry of entries) {
    const name = entry.name as unknown as string
    const absPath = join(dir, name)
    if (entry.isDirectory()) {
      const nested = await collectFiles(absPath, baseDir)
      results.push(...nested)
    } else if (!name.endsWith('.meta')) {
      const relKey = relative(baseDir, absPath)
      results.push({ absPath, relKey })
    }
  }
  return results
}

/**
 * Filesystem-backed BlobStorage for Node.js testing.
 * Each object is stored as two files:
 *   <rootDir>/<bucket>/<key>       — raw data
 *   <rootDir>/<bucket>/<key>.meta  — content-type string
 */
export function createFsBlobStorage(rootDir: string): BlobStorage {
  return {
    async read(bucket, key) {
      const dataFile = objectPath(rootDir, bucket, key)
      try {
        const [data, contentType] = await Promise.all([
          readFile(dataFile),
          readFile(metaPath(dataFile), 'utf8'),
        ])
        return { data: data.buffer as ArrayBuffer, contentType: contentType.trim() }
      } catch (err) {
        if (err instanceof TraversalError) throw err
        return null
      }
    },

    async write(bucket, key, data, contentType) {
      const dataFile = objectPath(rootDir, bucket, key)
      await mkdir(dirname(dataFile), { recursive: true })
      await Promise.all([
        writeFile(dataFile, Buffer.from(data)),
        writeFile(metaPath(dataFile), contentType),
      ])
    },

    async delete(bucket, key) {
      const dataFile = objectPath(rootDir, bucket, key)
      try {
        await Promise.all([
          unlink(dataFile),
          unlink(metaPath(dataFile)).catch(() => undefined),
        ])
        return true
      } catch (err) {
        if (err instanceof TraversalError) throw err
        return false
      }
    },

    async head(bucket, key) {
      const dataFile = objectPath(rootDir, bucket, key)
      try {
        const [info, contentType] = await Promise.all([
          stat(dataFile),
          readFile(metaPath(dataFile), 'utf8'),
        ])
        return { size: info.size, contentType: contentType.trim() }
      } catch (err) {
        if (err instanceof TraversalError) throw err
        return null
      }
    },

    async list(bucket, prefix) {
      const bucketDir = bucketPath(rootDir, bucket)
      const files = await collectFiles(bucketDir, bucketDir)
      return files
        .filter(({ relKey }) => relKey.startsWith(prefix))
        .map(async ({ absPath, relKey }) => {
          try {
            const info = await stat(absPath)
            return { key: relKey, size: info.size }
          } catch {
            return { key: relKey, size: 0 }
          }
        })
        .reduce<Promise<Array<{ key: string; size: number }>>>(
          async (accP, itemP) => {
            const acc = await accP
            acc.push(await itemP)
            return acc
          },
          Promise.resolve([]),
        )
    },
  }
}

/**
 * Convenience: creates an S3 handler with filesystem storage.
 * Node.js only — use makeS3Handler() with a browser BlobStorage for browser.
 */
export function createS3Handler(options: { rootDir: string }): (req: Request) => Promise<Response> {
  const storage = createFsBlobStorage(options.rootDir)
  return makeS3Handler(storage)
}
