import type { BlobStorage } from './types.js'
import { TraversalError } from './types.js'

// --- XML helpers ---

function buildListXml(bucket: string, prefix: string, items: Array<{ key: string; size: number }>): string {
  const contents = items
    .map(
      ({ key, size }) =>
        `  <Contents><Key>${escapeXml(key)}</Key><Size>${size}</Size></Contents>`,
    )
    .join('\n')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
    `  <Name>${escapeXml(bucket)}</Name>`,
    `  <Prefix>${escapeXml(prefix)}</Prefix>`,
    `  <KeyCount>${items.length}</KeyCount>`,
    `  <MaxKeys>1000</MaxKeys>`,
    `  <IsTruncated>false</IsTruncated>`,
    contents,
    `</ListBucketResult>`,
  ].join('\n')
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// --- Handler factory ---

/**
 * Creates an S3-compatible subset request handler from any BlobStorage backend.
 *
 * Supported operations:
 *   PUT    /{bucket}/{key}                — store object
 *   GET    /{bucket}/{key}                — retrieve object
 *   HEAD   /{bucket}/{key}                — object metadata
 *   DELETE /{bucket}/{key}                — remove object
 *   GET    /{bucket}?list-type=2[&prefix] — list objects (ListObjectsV2)
 *
 * Browser-safe — no Node.js dependencies.
 */
export function makeS3Handler(storage: BlobStorage): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url)
      const segments = url.pathname.split('/').filter(Boolean)
      const bucket = segments[0]

      if (!bucket) {
        return new Response('Bad Request: missing bucket', { status: 400 })
      }

      const key = segments.slice(1).join('/')
      const method = req.method.toUpperCase()

      // LIST — GET on bucket root with list-type=2
      if (method === 'GET' && !key && url.searchParams.has('list-type')) {
        const prefix = url.searchParams.get('prefix') ?? ''
        const items = await storage.list(bucket, prefix)
        const xml = buildListXml(bucket, prefix, items)
        return new Response(xml, {
          status: 200,
          headers: { 'Content-Type': 'application/xml' },
        })
      }

      if (!key) {
        return new Response('Bad Request: missing object key', { status: 400 })
      }

      switch (method) {
        case 'PUT': {
          const contentType = req.headers.get('Content-Type') ?? 'application/octet-stream'
          const data = await req.arrayBuffer()
          await storage.write(bucket, key, data, contentType)
          return new Response(null, { status: 200 })
        }

        case 'GET': {
          const obj = await storage.read(bucket, key)
          if (!obj) return new Response('Not Found', { status: 404 })
          return new Response(obj.data, {
            status: 200,
            headers: {
              'Content-Type': obj.contentType,
              'Content-Length': String(obj.data.byteLength),
            },
          })
        }

        case 'HEAD': {
          const meta = await storage.head(bucket, key)
          if (!meta) return new Response(null, { status: 404 })
          return new Response(null, {
            status: 200,
            headers: {
              'Content-Type': meta.contentType,
              'Content-Length': String(meta.size),
            },
          })
        }

        case 'DELETE': {
          await storage.delete(bucket, key)
          return new Response(null, { status: 204 })
        }

        default:
          return new Response(`Method ${req.method} not allowed`, { status: 405 })
      }
    } catch (err) {
      if (err instanceof TraversalError) {
        return new Response(err.message, { status: 400 })
      }
      const message = err instanceof Error ? err.message : String(err)
      return new Response(`Internal Server Error: ${message}`, { status: 500 })
    }
  }
}
