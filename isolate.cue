package cluster

import (
	"encoding/base64"
	"encoding/json"
	"list"
	"path"
	"strings"

	bayt "github.com/bonisoft3/bayt/core:bayt"
	deno "github.com/bonisoft3/bayt/stacks/deno"
)

// How long an isolate's call may run, from when its module takes it up,
// before the host replaces the module's process: past the airlock's own call
// timeout (services/airlock/reentry.ts, CALL_TIMEOUT_MS, 45 s), so the
// airlock gives the call up first and its run errs as on a transport's
// failure, as with a stuck container.
#IsolateDeadlineMs: 50000

// What serves an isolate's build outside Cloudflare: a supervisor, whose
// module runs in a process of its own (#IsolateRunner). That process may read
// the build alone and reach the network but for this machine's own addresses,
// where the docker appliance's database, daprd and airlock listen, and holds
// the hatch's heap; terminating a worker would leave a loop it is in running,
// and ending a process ends it. A call that outlives the deadline from when
// the module took it up, a module that takes no call for as long, or a
// process that dies, past its heap or otherwise, has the process replaced:
// the calls in it break their connections, with no status sent, as a crashed
// container's would. Arguments: the entry, the port, the deadline in
// milliseconds, the heap in MiB.
#IsolateHost: """
	import http from 'node:http'
	import { Buffer } from 'node:buffer'
	const [entry, port, deadline, memory] = Deno.args
	const limit = Number(deadline)
	const here = new URL(entry, `file://${Deno.cwd()}/`)
	const dir = decodeURIComponent(new URL('.', here).pathname)
	// This machine's own addresses, a name for one among them.
	const own = Deno.networkInterfaces().map(({ family, address }) => family === 'IPv6' ? `[${address.split('%')[0]}]` : address)
	const denied = [...new Set(['127.0.0.1', 'localhost', '[::1]', '0.0.0.0', '[::]', ...own])]
	// A call in flight: how it is answered, and when the module took it up.
	const pending = new Map()
	let child
	let writer
	let next = 0
	let heard = Date.now()
	const fail = (why) => {
	  for (const [id, call] of pending) {
	    pending.delete(id)
	    call.resolve({ error: why })
	  }
	}
	const start = () => {
	  const spawned = new Deno.Command(Deno.execPath(), {
	    args: ['run', '--no-config', `--allow-read=${dir}`, '--allow-net', `--deny-net=${denied.join(',')}`, `--v8-flags=--max-old-space-size=${memory}`, `${dir}runner.js`, here.href],
	    stdin: 'piped',
	    stdout: 'piped',
	    stderr: 'inherit',
	  }).spawn()
	  child = spawned
	  writer = spawned.stdin.getWriter()
	  heard = Date.now()
	  ;(async () => {
	    let buffered = ''
	    for await (const text of spawned.stdout.pipeThrough(new TextDecoderStream())) {
	      buffered += text
	      for (let at = buffered.indexOf('\\n'); at >= 0; at = buffered.indexOf('\\n')) {
	        const message = JSON.parse(buffered.slice(0, at))
	        buffered = buffered.slice(at + 1)
	        heard = Date.now()
	        const call = pending.get(message.id)
	        if (call === undefined) continue
	        if (message.started) {
	          call.started = Date.now()
	          continue
	        }
	        pending.delete(message.id)
	        call.resolve(message)
	      }
	    }
	  })().catch(() => {})
	  spawned.status.then(({ code, signal }) => {
	    if (child !== spawned) return
	    fail(`the isolate ended (${signal ?? code})`)
	    start()
	  })
	}
	const replace = (why) => {
	  const old = child
	  child = undefined
	  fail(why)
	  try {
	    old.kill('SIGKILL')
	  } catch { /* it ended on its own */ }
	  start()
	}
	start()
	setInterval(() => {
	  const now = Date.now()
	  for (const call of pending.values()) {
	    if (call.started !== undefined && now - call.started > limit) return replace(`a call outlived the isolate's ${limit} ms`)
	  }
	  if (pending.size > 0 && now - heard > limit) replace(`the isolate took up no call for ${limit} ms`)
	}, Math.min(1000, limit / 4))
	http.createServer((request, response) => {
	  const chunks = []
	  request.on('data', (chunk) => chunks.push(chunk))
	  request.on('end', async () => {
	    const id = next++
	    // A request without a body stays one, as a service binding keeps it. Over
	    // HTTP a bodyless POST arrives with an empty body, so an empty body is none.
	    const body = Buffer.concat(chunks)
	    const headers = []
	    for (let i = 0; i < request.rawHeaders.length; i += 2) headers.push([request.rawHeaders[i], request.rawHeaders[i + 1]])
	    if (pending.size === 0) heard = Date.now()
	    const answer = await new Promise((resolve) => {
	      pending.set(id, { resolve })
	      const call = { id, method: request.method, url: `http://${request.headers.host ?? 'localhost'}${request.url}`, headers, body: body.length ? body.toString('base64') : null }
	      writer.write(new TextEncoder().encode(JSON.stringify(call) + '\\n')).catch(() => {})
	    })
	    // A call the module failed breaks the connection as a crashed container's
	    // would, before any status: the caller's transport fails, and no status
	    // of the module's is made up for it.
	    if (answer.error !== undefined) {
	      console.error(answer.error)
	      request.socket.destroy()
	      return
	    }
	    const out = {}
	    for (const [name, value] of answer.headers) out[name] = name in out ? [].concat(out[name], value) : value
	    response.writeHead(answer.status, out)
	    response.end(answer.body === null ? undefined : Buffer.from(answer.body, 'base64'))
	  })
	}).listen(Number(port))

	"""

// The module's own process, under #IsolateHost: calls arrive on stdin and
// their answers leave on stdout, a JSON line each, so what the module logs
// goes to stderr. It tells the host when it takes a call up, which starts the
// call's deadline. The handler reads calls before the module loads, so a call
// made while its top-level code still runs waits for it.
#IsolateRunner: """
	import { Buffer } from 'node:buffer'
	for (const level of ['log', 'info', 'debug']) console[level] = console.error
	const loaded = import(Deno.args[0])
	loaded.catch(() => {})
	const encoder = new TextEncoder()
	// Written at once, not queued for the event loop: the host hears a call
	// taken up while the module still holds the thread with it, which is
	// what tells a busy module from a stuck one.
	const send = (message) => {
	  for (let bytes = encoder.encode(JSON.stringify(message) + '\\n'); bytes.length > 0;) bytes = bytes.subarray(Deno.stdout.writeSync(bytes))
	}
	const answer = async ({ id, method, url, headers, body }) => {
	  try {
	    const { default: module } = await loaded
	    // Taken up only now: a call waits here while another holds the thread.
	    send({ id, started: true })
	    const response = await module.fetch(new Request(url, { method, headers, body: body === null ? undefined : Buffer.from(body, 'base64') }))
	    // A network error, Response.error(), is no status: the call fails as
	    // on a broken connection.
	    if (response.type === 'error') throw new Error('the module answered a network error')
	    const bytes = response.body === null ? null : Buffer.from(await response.arrayBuffer()).toString('base64')
	    send({ id, status: response.status, headers: [...response.headers], body: bytes })
	  } catch (error) {
	    send({ id, error: String(error?.stack ?? error) })
	  }
	}
	// A call is taken up on a turn of its own, once the one before has run as
	// far as it can at once and answered if it could: a call's time is its
	// own, never the time of calls ahead of it. A call that waits on the
	// network lets the next one in.
	const waiting = []
	let taking = false
	const take = () => {
	  const call = waiting.shift()
	  if (call === undefined) {
	    taking = false
	    return
	  }
	  answer(call)
	  setTimeout(take, 0)
	}
	let buffered = ''
	for await (const text of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
	  buffered += text
	  for (let at = buffered.indexOf('\\n'); at >= 0; at = buffered.indexOf('\\n')) {
	    waiting.push(JSON.parse(buffered.slice(0, at)))
	    buffered = buffered.slice(at + 1)
	  }
	  if (!taking && waiting.length > 0) {
	    taking = true
	    setTimeout(take, 0)
	  }
	}

	"""

// How every release builds an isolate, run by `deno eval` with its
// ISOLATE_* settings: the module bundled once, `deno bundle --platform=
// browser`, by its own deno.json beside its entrypoint, or none.
//
// A module imports WebAssembly through a shim, `<name>.wasm.js` holding
// `import source m from "./<name>.wasm"` beside its `.wasm`: a source import
// is a module under Deno and on a Cloudflare Worker alike, where bytes a
// bundle inlined would be compiled at load, which a Worker refuses. The
// bundler never sees a shim: it bundles a copy of the sources in which each
// shim takes its module from a registry, `shims.js`, which imports the real
// shims beside it; `entry.js` loads that registry, then the bundle, so the
// bundle holds no import to resolve, whichever module imported a shim, by a
// path or an alias. Everything lands in ISOLATE_OUT, one directory, where a
// shim and its `.wasm` are found by their names: the schema keeps them apart;
// with ISOLATE_HOST=1, #IsolateHost and #IsolateRunner too, as `host.js` and
// `runner.js`.
#IsolateBuild: #"""
	const setting = (name) => Deno.env.get(name) ?? (() => { throw new Error(`${name} is not set`) })()
	const root = setting("ISOLATE_ROOT")
	const out = setting("ISOLATE_OUT")
	const entrypoint = setting("ISOLATE_ENTRYPOINT")
	const files = JSON.parse(setting("ISOLATE_FILES"))
	const base = (file) => file.slice(file.lastIndexOf("/") + 1)
	const dir = (file) => file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "."
	const stage = await Deno.makeTempDir()
	try {
	  const shims = files.filter((file) => file.endsWith(".wasm.js"))
	  for (const file of files) {
	    await Deno.mkdir(`${stage}/${dir(file)}`, { recursive: true })
	    if (shims.includes(file)) await Deno.writeTextFile(`${stage}/${file}`, `export default globalThis.__isolateShims[${JSON.stringify(base(file))}]\n`)
	    else await Deno.copyFile(`${root}/${file}`, `${stage}/${file}`)
	  }
	  const config = ["deno.json", "deno.jsonc"].map((name) => dir(entrypoint) === "." ? name : `${dir(entrypoint)}/${name}`).find((file) => files.includes(file))
	  await Deno.mkdir(out, { recursive: true })
	  const bundled = await new Deno.Command(Deno.execPath(), {
	    args: ["bundle", "--platform=browser", "--packages=bundle", ...(config ? ["--config", `${stage}/${config}`] : ["--no-config"]), "-o", `${out}/bundle.js`, `${stage}/${entrypoint}`],
	    stdout: "inherit",
	    stderr: "inherit",
	  }).output()
	  if (!bundled.success) throw new Error(`deno bundle ${entrypoint} failed`)
	  for (const file of files.filter((file) => file.endsWith(".wasm") || file.endsWith(".wasm.js"))) await Deno.copyFile(`${root}/${file}`, `${out}/${base(file)}`)
	  await Deno.writeTextFile(`${out}/shims.js`, [
	    ...shims.map((file, i) => `import shim${i} from ${JSON.stringify(`./${base(file)}`)}`),
	    `globalThis.__isolateShims = { ${shims.map((file, i) => `${JSON.stringify(base(file))}: shim${i}`).join(", ")} }`,
	    "",
	  ].join("\n"))
	  await Deno.writeTextFile(`${out}/entry.js`, `import "./shims.js"\nexport { default } from "./bundle.js"\n`)
	  // Outside Cloudflare the host serving the entry lands beside it, with
	  // the runner its module's process runs.
	  if (Deno.env.get("ISOLATE_HOST") === "1") {
	    await Deno.writeTextFile(`${out}/host.js`, \#(json.Marshal(#IsolateHost)))
	    await Deno.writeTextFile(`${out}/runner.js`, \#(json.Marshal(#IsolateRunner)))
	  }
	} finally {
	  await Deno.remove(stage, { recursive: true })
	}

	"""#

// An isolate hatch's container: the shape a container takes when what it runs
// is a module in the Workers format (`export default { fetch }`, Web APIs
// only). Outside Cloudflare it is a bayt target whose one cmd builds the
// module (#IsolateBuild) and whose process serves it through #IsolateHost:
// bayt runs that cmd in the image and on the host alike, and the docker
// appliance copies its outs from the image. On Cloudflare the same build is
// a Worker of its own (plugins/pronto/docs/isolate-hatches.md).
#IsolateContainer: {
	// The hatch's name, which names its build.
	name: string
	// App-relative paths: the module's sources, its deno.json and lock among
	// them, and any WebAssembly with its shim.
	files:      [string, ...string]
	entrypoint: string
	// V8's old space, in MiB: the long-lived heap, which a module's data
	// fills; V8's young space and code come on top of it.
	memory: int & >=16 & <=128
	let module = entrypoint

	// The build, beside the sources: the host, the entry it loads, and
	// everything beside that.
	out:   ".isolate/\(name)"
	host:  "\(out)/host.js"
	entry: "\(out)/entry.js"
	built: list.Concat([[host, "\(out)/runner.js", entry, "\(out)/bundle.js", "\(out)/shims.js"], [for f in files if strings.HasSuffix(f, ".wasm") || strings.HasSuffix(f, ".wasm.js") {"\(out)/\(path.Base(f, path.Unix))"}]])
	// Where the image holds the sources and the build: a fixed directory, not
	// bayt's /monorepo/<dir>, which moves with the build's BAYT_DIR, so the
	// docker appliance copies the build from where it always is. The build
	// is therefore no bayt outs, whose view reads /monorepo/<dir>.
	workdir: "/isolate"
	// The host: it listens, finds this machine's addresses and runs the
	// module's process, whose own permissions it narrows (#IsolateHost).
	serve:   ["run", "--no-config", "--allow-net", "--allow-read", "--allow-run", "--allow-sys=networkInterfaces"]
	_quoted: {in: [...string], out: strings.Join([for a in in {"'\(a)'"}], " ")}
	_build:  base64.Encode(null, #IsolateBuild)

	target: bayt.healthcheck.tcp & {
		// Deno is the image's, copied in below, and mise's on the host.
		activate: ""
		"process-compose": activate: "mise x --"
		expose: http:                {port: #BridgePort, env: "PORT"}
		srcs: globs:                 files
		// The host builds as the image does, before its process starts.
		taskfile: {}
		cmd: builtin: (deno.#cmd & {
			shell: "sh"
			do:    "ISOLATE_ROOT=. ISOLATE_OUT='\(out)' ISOLATE_ENTRYPOINT='\(module)' ISOLATE_FILES='\(json.Marshal(files))' ISOLATE_HOST=1 deno eval --no-config \"$(echo '\(_build)' | base64 -d)\""
		}).out
		entrypoint: {
			shell: "sh"
			do:    "exec deno \((_quoted & {in: serve}).out) '\(host)' '\(entry)' \"$PORT\" '\(#IsolateDeadlineMs)' '\(memory)'"
		}
		healthcheck: {port: #BridgePort, interval: "5s", start_interval: "500ms", start_period: "30s"}
		// Debian for the C library Deno links against, and Deno itself from its
		// pinned binary image, which ships nothing else.
		dockerfile: {
			from: name: bayt.lock.images.debian
			defaultPreamble: deno: copy: {from: name: bayt.lock.images.deno_bin, srcs: ["/deno"], dst: "/usr/local/bin/deno"}
			"workdir": workdir
		}
		compose: restart: "on-failure"
	}
}
