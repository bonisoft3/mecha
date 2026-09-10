import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createS3Handler } from './fs-storage.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('createS3Handler', () => {
  let handler: (req: Request) => Promise<Response>
  let tempDir: string

  beforeAll(async () => {
    // Use a temp directory as the storage root (simulates OPFS in Node.js)
    tempDir = await mkdtemp(join(tmpdir(), 'mecha-s3-'))
    handler = createS3Handler({ rootDir: tempDir })
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('handles PUT (store object)', async () => {
    const req = new Request('http://localhost/my-bucket/test.txt', {
      method: 'PUT',
      body: 'hello world',
      headers: { 'Content-Type': 'text/plain' },
    })
    const res = await handler(req)
    expect(res.status).toBe(200)
  })

  it('handles GET (retrieve object)', async () => {
    const req = new Request('http://localhost/my-bucket/test.txt', {
      method: 'GET',
    })
    const res = await handler(req)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toBe('hello world')
  })

  it('handles HEAD (metadata)', async () => {
    const req = new Request('http://localhost/my-bucket/test.txt', {
      method: 'HEAD',
    })
    const res = await handler(req)
    expect(res.status).toBe(200)
    expect(Number(res.headers.get('Content-Length'))).toBeGreaterThan(0)
  })

  it('handles GET on missing object (404)', async () => {
    const req = new Request('http://localhost/my-bucket/nonexistent.txt', {
      method: 'GET',
    })
    const res = await handler(req)
    expect(res.status).toBe(404)
  })

  it('handles PUT with binary data', async () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG header bytes
    const req = new Request('http://localhost/my-bucket/image.png', {
      method: 'PUT',
      body: data,
      headers: { 'Content-Type': 'image/png' },
    })
    const res = await handler(req)
    expect(res.status).toBe(200)

    // Verify round-trip
    const getReq = new Request('http://localhost/my-bucket/image.png', { method: 'GET' })
    const getRes = await handler(getReq)
    const retrieved = new Uint8Array(await getRes.arrayBuffer())
    expect(retrieved).toEqual(data)
  })

  it('handles nested keys (subdirectories)', async () => {
    const req = new Request('http://localhost/my-bucket/photos/2026/vacation.jpg', {
      method: 'PUT',
      body: 'fake-image-data',
      headers: { 'Content-Type': 'image/jpeg' },
    })
    const res = await handler(req)
    expect(res.status).toBe(200)

    const getReq = new Request('http://localhost/my-bucket/photos/2026/vacation.jpg', { method: 'GET' })
    const getRes = await handler(getReq)
    expect(getRes.status).toBe(200)
    expect(await getRes.text()).toBe('fake-image-data')
  })

  it('handles LIST (list objects with prefix)', async () => {
    const req = new Request('http://localhost/my-bucket?list-type=2&prefix=photos/', {
      method: 'GET',
    })
    const res = await handler(req)
    expect(res.status).toBe(200)

    const body = await res.text()
    // S3 ListObjectsV2 returns XML
    expect(body).toContain('<ListBucketResult')
    expect(body).toContain('photos/2026/vacation.jpg')
  })

  it('handles LIST on empty prefix', async () => {
    const req = new Request('http://localhost/my-bucket?list-type=2', {
      method: 'GET',
    })
    const res = await handler(req)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('test.txt')
    expect(body).toContain('image.png')
  })

  it('handles DELETE', async () => {
    const req = new Request('http://localhost/my-bucket/test.txt', {
      method: 'DELETE',
    })
    const res = await handler(req)
    expect(res.status).toBe(204)

    // Verify deleted
    const getReq = new Request('http://localhost/my-bucket/test.txt', { method: 'GET' })
    const getRes = await handler(getReq)
    expect(getRes.status).toBe(404)
  })

  it('rejects path traversal attempts', async () => {
    // Use percent-encoded slashes so the '..' survives URL normalization and reaches the handler.
    // Depending on the runtime (Node.js vs Bun), URL normalisation may resolve the segments
    // before they reach the handler — resulting in either 400 (traversal caught) or 404 (not found).
    // Both are safe outcomes.
    const req = new Request('http://localhost/my-bucket/..%2F..%2F..%2Fetc%2Fpasswd', {
      method: 'GET',
    })
    const res = await handler(req)
    expect([400, 404]).toContain(res.status)
  })
})
