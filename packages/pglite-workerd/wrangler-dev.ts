// A Worker under `wrangler dev` (mise.toml's wrangler) on a free port and its
// own state directory, for tests. restart() kills wrangler and its workerd and
// starts them again on the same state: a fresh isolate and object, and an
// eviction without a clean shutdown.
const here = new URL('.', import.meta.url).pathname
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function output(cmd: string, args: string[]): Promise<string> {
  const r = await new Deno.Command(cmd, { args, cwd: here, stderr: 'inherit' }).output()
  if (!r.success) throw new Error(`${cmd} ${args.join(' ')} exited ${r.code}`)
  return new TextDecoder().decode(r.stdout).trim()
}

// By path: mise puts the npm backend's bin/ on PATH, where a bare `wrangler`
// can resolve to another install.
const wrangler = `${await output('mise', ['where', 'npm:wrangler'])}/node_modules/.bin/wrangler`
// A Worker here bundles mecha's edge sources, whose clock reads cron through
// the ticker's node_modules (services/ticker/deno.json): wrangler's bundler
// resolves no npm: specifier, and the release's edge.ts installs it the same way.
await output(Deno.execPath(), ['install', '--frozen', '--config', `${here}../../services/ticker/deno.json`])
await output(Deno.execPath(), ['install', '--frozen', '--config', `${here}../../services/airlock/deno.json`])
await output(Deno.execPath(), ['install', '--frozen', '--config', `${here}../mecha-edge/deno.json`])

function freePort(): number {
  const l = Deno.listen({ port: 0, hostname: '127.0.0.1' })
  const { port } = l.addr as Deno.NetAddr
  l.close()
  return port
}

async function descendants(pid: number): Promise<number[]> {
  const r = await new Deno.Command('pgrep', { args: ['-P', String(pid)] }).output()
  const children = new TextDecoder().decode(r.stdout).split('\n').filter(Boolean).map(Number)
  return [...children, ...(await Promise.all(children.map(descendants))).flat()]
}

export interface Worker {
  origin: string
  restart(): Promise<void>
  stop(): Promise<void>
}

/** Starts `wrangler dev --config <config>`, keeping state in `state` and its
 * output in `<state>.log{,.err}`. */
export async function startWorker(config: URL, state: string): Promise<Worker> {
  const dir = new URL('.', config).pathname
  const port = freePort()
  const log = `${state}.log`
  let child: Deno.ChildProcess
  const terminate = async () => {
    const tree = [child.pid, ...(await descendants(child.pid))]
    for (const pid of tree.reverse()) {
      try { Deno.kill(pid, 'SIGKILL') } catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e }
    }
    await child.status
    return tree
  }
  const start = async () => {
    const out = await Deno.open(log, { write: true, create: true, truncate: true })
    const err = await Deno.open(`${log}.err`, { write: true, create: true, truncate: true })
    child = new Deno.Command(wrangler, {
      args: ['dev', '--test-scheduled', '--config', config.pathname, '--port', String(port), '--inspector-port', String(freePort()), '--persist-to', state],
      cwd: dir,
      stdout: 'piped',
      stderr: 'piped',
    }).spawn()
    const stderrLog = child.stderr.pipeTo(err.writable)
    const [watch, keep] = child.stdout.tee()
    const stdoutLog = keep.pipeTo(out.writable)
    const logs = async () => {
      await child.status
      await Promise.race([Promise.all([stdoutLog, stderrLog]), delay(1_000)])
      const [stdout, stderr] = await Promise.all([Deno.readTextFile(log), Deno.readTextFile(`${log}.err`)])
      const tail = (text: string) => text.length > 16_000 ? text.slice(-16_000) : text
      return `\nstdout (${log}):\n${tail(stdout)}\nstderr (${log}.err):\n${tail(stderr)}`
    }
    let seen = ''
    const timeout = AbortSignal.timeout(30_000)
    try {
      for await (const chunk of watch.pipeThrough(new TextDecoderStream(), { signal: timeout })) {
        seen += chunk
        if (seen.includes('Ready on')) break
        if (seen.includes('[ERROR]') || seen.includes('Build failed')) {
          throw new Error(`wrangler dev build failed:\n${seen}`)
        }
      }
    } catch (e) {
      await terminate()
      throw new Error(`wrangler dev failed to become ready: ${e}\n${seen}${await logs()}`)
    }
    if (!seen.includes('Ready on')) {
      await terminate()
      throw new Error(`wrangler dev exited before ready${await logs()}`)
    }
  }
  const stop = async () => {
    const tree = await terminate()
    for (let i = 0; i < 50; i++) {
      const alive = (await Promise.all(tree.map(async (pid) => (await new Deno.Command('kill', { args: ['-0', String(pid)], stderr: 'null' }).output()).success))).some(Boolean)
      if (!alive) break
      await delay(100)
    }
  }
  await start()
  return { origin: `http://127.0.0.1:${port}`, restart: async () => { await stop(); await start() }, stop }
}
