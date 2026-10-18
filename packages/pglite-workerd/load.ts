// Loads a PGlite data directory built on disk into an object's SqliteFS, through
// DataDirectory.importing() behind `send`, resumably: chunks only append and each
// lands in one transaction, so a file's stored size says where it resumes, and a
// re-run sends only what is missing; a request the object never answered
// resumes the run itself, from what the object holds. A node the object holds that the directory
// lacks, or holds longer, is another load's: the run stops unless `reset` starts
// over. It ends by hashing every stored chunk in the object against the local
// bytes, and only then marks the directory complete, which is what lets the
// object open it. A complete directory is live data: a load leaves it alone
// unless `reset`.

export const CHUNK = 4 * 1024 * 1024
// Chunks hashed per request: 64 MiB of reads, well inside a request's CPU.
const HASH_BATCH = 16

/** One import request: `route` is what follows /import/, query included. */
export type Send = (route: string, init?: RequestInit) => Promise<Response>

interface Node { path: string; dir: boolean; size: number }

async function walk(root: string, rel = ''): Promise<Node[]> {
  const out: Node[] = []
  for await (const e of Deno.readDir(`${root}${rel}`)) {
    const p = `${rel}/${e.name}`
    if (e.isDirectory) out.push({ path: p, dir: true, size: 0 }, ...(await walk(root, p)))
    else if (e.isFile) out.push({ path: p, dir: false, size: (await Deno.stat(`${root}${p}`)).size })
    else throw new Error(`${p} is neither file nor directory`)
  }
  return out
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

async function readAt(f: Deno.FsFile, offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const buf = new Uint8Array(length)
  await f.seek(offset, Deno.SeekMode.Start)
  let n = 0
  while (n < length) {
    const r = await f.read(buf.subarray(n))
    if (r === null) throw new Error(`short read at ${offset + n}`)
    n += r
  }
  return buf
}

export interface LoadOptions { reset?: boolean; concurrency?: number; log?: (line: string) => void }

/** A request that got no answer, or the platform's 5xx: the object restarted
 * under it (a deploy, an eviction), and what it stored is still its state. */
class Interrupted extends Error {}
// Passes resumed after an interruption before the load gives up.
const RESUMES = 5

export async function load(dir: string, send: Send, { reset = false, concurrency = 4, log = console.log }: LoadOptions = {}) {
  const call = async (route: string, init?: RequestInit) => {
    // A connection the object's restart cuts fails the request or its body,
    // whichever was in flight.
    let res: Response
    let text: string
    try {
      res = await send(route, init)
      text = await res.text()
    } catch (e) {
      if (e instanceof TypeError) throw new Interrupted(`/import/${route}: ${e.message}`)
      throw e
    }
    if (res.status >= 500 || res.status === 401) throw new Interrupted(`/import/${route}: ${res.status} ${text}`)
    if (!res.ok) throw new Error(`/import/${route}: ${res.status} ${text}`)
    return JSON.parse(text)
  }
  const post = (route: string, body?: BodyInit) => call(route, { method: 'POST', body })
  for (let resumed = 0; ; resumed++) {
    try {
      if (reset) {
        await post('reset')
        reset = false
      }
      return await pass(dir, call, post, concurrency, log)
    } catch (e) {
      if (!(e instanceof Interrupted) || resumed === RESUMES) throw e
      log(`${e.message}; resuming from what the object holds`)
      // An object restarting answers nothing for a moment.
      await new Promise((r) => setTimeout(r, 1000 * 2 ** resumed))
    }
  }
}

type Call = (route: string, init?: RequestInit) => Promise<any>

/** `n` workers over `items`; the first failure stops them taking more, and is
 * thrown once every request in flight has ended, so a resumed pass never runs
 * beside one still sending. */
async function drain<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let failed = false
  const results = await Promise.allSettled(Array.from({ length: n }, async () => {
    for (let item = items.shift(); item !== undefined && !failed; item = items.shift()) {
      try {
        await fn(item)
      } catch (e) {
        failed = true
        throw e
      }
    }
  }))
  const failure = results.find((r) => r.status === 'rejected')
  if (failure) throw (failure as PromiseRejectedResult).reason
}

async function pass(dir: string, call: Call, post: (route: string, body?: BodyInit) => Promise<any>, concurrency: number, log: (line: string) => void) {
  const t0 = performance.now()
  if ((await call('status')).complete) return { skipped: 'complete' as const }
  const local = await walk(dir)
  const stored = new Map(((await call('state')) as Node[]).map((n) => [n.path, n]))
  const localPaths = new Set(local.map((n) => n.path))
  for (const s of stored.values()) {
    if (s.path === '/') continue
    if (!localPaths.has(s.path)) throw new Error(`the object holds ${s.path}, which ${dir} lacks; reset to start over`)
  }

  for (const d of local.filter((n) => n.dir && !stored.has(n.path))) await post(`dir?path=${encodeURIComponent(d.path)}`)
  const files = local.filter((n) => !n.dir)
  let total = 0, done = 0, sent = 0
  const work: { path: string; from: number; size: number }[] = []
  for (const f of files) {
    const have = stored.get(f.path)?.size ?? 0
    if (have > f.size) throw new Error(`the object holds ${have} bytes of ${f.path}, ${dir} ${f.size}; reset to start over`)
    total += f.size
    done += have
    if (have < f.size || !stored.has(f.path)) work.push({ path: f.path, from: have, size: f.size })
  }
  log(JSON.stringify({ files: files.length, MiB: +(total / 2 ** 20).toFixed(1), storedMiB: +(done / 2 ** 20).toFixed(1), filesToSend: work.length }))

  let last = performance.now()
  const progress = () => {
    const now = performance.now()
    if (now - last < 10_000) return
    last = now
    const rate = sent / ((now - t0) / 1000)
    log(`${(done / 2 ** 20).toFixed(0)}/${(total / 2 ** 20).toFixed(0)} MiB, ${(rate / 2 ** 20).toFixed(1)} MiB/s, ETA ${rate ? Math.round((total - done) / rate) : '?'}s`)
  }
  const queue = [...work]
  await drain(queue, concurrency, async (w) => {
    const f = await Deno.open(`${dir}${w.path}`)
    try {
      // An empty file is a single empty chunk, which creates its node.
      for (let offset = w.from; offset < w.size || offset === 0; offset += CHUNK) {
        const bytes = await readAt(f, offset, Math.min(CHUNK, w.size - offset))
        await post(`chunk?path=${encodeURIComponent(w.path)}&offset=${offset}`, bytes)
        done += bytes.length
        sent += bytes.length
        progress()
        if (w.size === 0) break
      }
    } finally {
      f.close()
    }
  })
  const loadSeconds = (performance.now() - t0) / 1000

  const ranges = files.flatMap((f) => Array.from({ length: Math.ceil(f.size / CHUNK) }, (_, i) => ({ path: f.path, offset: i * CHUNK, length: Math.min(CHUNK, f.size - i * CHUNK) })))
  const t1 = performance.now()
  let checked = 0
  const batches = Array.from({ length: Math.ceil(ranges.length / HASH_BATCH) }, (_, i) => ranges.slice(i * HASH_BATCH, (i + 1) * HASH_BATCH))
  await drain(batches, concurrency, async (batch) => {
    const remote = (await post('hash', JSON.stringify(batch))) as string[]
    for (const [i, r] of batch.entries()) {
      const f = await Deno.open(`${dir}${r.path}`)
      const localHash = hex(await crypto.subtle.digest('SHA-256', await readAt(f, r.offset, r.length)))
      f.close()
      if (remote[i] !== localHash) throw new Error(`${r.path} at ${r.offset}: stored ${remote[i]}, local ${localHash}`)
    }
    checked += batch.length
  })
  await post('complete')
  return {
    files: files.length,
    MiB: +(total / 2 ** 20).toFixed(1),
    sentMiB: +(sent / 2 ** 20).toFixed(1),
    loadSeconds: +loadSeconds.toFixed(1),
    MiBps: +(sent / 2 ** 20 / loadSeconds).toFixed(1),
    chunksVerified: checked,
    verifySeconds: +((performance.now() - t1) / 1000).toFixed(1),
  }
}
