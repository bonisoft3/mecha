/**
 * A pure WASI preview1 host for one-shot commands: stdin in, stdout out.
 *
 * Nothing of the host leaks in, so a run is a function of the module and its
 * stdin: the clocks read 0, random_get is a fixed stream, the environment is
 * empty, argv is the module's name alone, and there are no preopens, files
 * or sockets. An import outside this set traps naming itself.
 */

const ESUCCESS = 0;
const EBADF = 8;
const EINVAL = 28;
const CLOCKS = new Set([0, 1, 2, 3]); // realtime, monotonic, process and thread cputime

class Exit {
	constructor(readonly code: number) {}
}

/** Runs `module`'s `_start` in a fresh instance; throws with stderr on a nonzero exit or a trap. */
export function runWasm(
	module: WebAssembly.Module,
	stdin: Uint8Array,
	command: string,
): Uint8Array {
	const stdout = new Sink();
	const stderr = new Sink();
	const state: { memory?: WebAssembly.Memory } = {};
	// Re-read on every access: memory.grow detaches the previous buffer.
	const view = () => new DataView(state.memory!.buffer);
	const bytes = () => new Uint8Array(state.memory!.buffer);
	let read = 0;
	let random = 0x9e3779b97f4a7c15n;
	const encoded = [command].map((a) => new TextEncoder().encode(a + "\0"));

	const wasi: Record<string, (...args: never[]) => number> = {
		args_sizes_get(count: number, size: number) {
			view().setUint32(count, encoded.length, true);
			view().setUint32(size, encoded.reduce((n, a) => n + a.length, 0), true);
			return ESUCCESS;
		},
		args_get(argv: number, buffer: number) {
			for (const [i, a] of encoded.entries()) {
				view().setUint32(argv + 4 * i, buffer, true);
				bytes().set(a, buffer);
				buffer += a.length;
			}
			return ESUCCESS;
		},
		environ_sizes_get(count: number, size: number) {
			view().setUint32(count, 0, true);
			view().setUint32(size, 0, true);
			return ESUCCESS;
		},
		environ_get: () => ESUCCESS,
		clock_res_get(id: number, resolution: number) {
			if (!CLOCKS.has(id)) return EINVAL;
			view().setBigUint64(resolution, 1n, true);
			return ESUCCESS;
		},
		clock_time_get(id: number, _precision: bigint, time: number) {
			if (!CLOCKS.has(id)) return EINVAL;
			view().setBigUint64(time, 0n, true);
			return ESUCCESS;
		},
		random_get(buffer: number, length: number) {
			// splitmix64 from a fixed seed: hash seeds and the like are the same every run.
			const out = bytes();
			for (let i = 0; i < length; i += 8) {
				random = (random + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
				let z = random;
				z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
				z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
				z ^= z >> 31n;
				for (let j = 0; j < 8 && i + j < length; j++) {
					out[buffer + i + j] = Number((z >> BigInt(8 * j)) & 0xffn);
				}
			}
			return ESUCCESS;
		},
		fd_read(fd: number, iovs: number, count: number, nread: number) {
			if (fd !== 0) return EBADF;
			let total = 0;
			for (let i = 0; i < count; i++) {
				const base = view().getUint32(iovs + 8 * i, true);
				const length = view().getUint32(iovs + 8 * i + 4, true);
				const chunk = stdin.subarray(read, read + length);
				bytes().set(chunk, base);
				read += chunk.length;
				total += chunk.length;
				if (chunk.length < length) break;
			}
			view().setUint32(nread, total, true);
			return ESUCCESS;
		},
		fd_write(fd: number, iovs: number, count: number, nwritten: number) {
			const sink = fd === 1 ? stdout : fd === 2 ? stderr : undefined;
			if (!sink) return EBADF;
			let total = 0;
			for (let i = 0; i < count; i++) {
				const base = view().getUint32(iovs + 8 * i, true);
				const length = view().getUint32(iovs + 8 * i + 4, true);
				sink.push(bytes().slice(base, base + length));
				total += length;
			}
			view().setUint32(nwritten, total, true);
			return ESUCCESS;
		},
		sched_yield: () => ESUCCESS,
		proc_exit(code: number) {
			throw new Exit(code);
		},
	};

	const imports: WebAssembly.Imports = {};
	for (
		const { module: name, name: field, kind } of WebAssembly.Module.imports(
			module,
		)
	) {
		const provided = name === "wasi_snapshot_preview1"
			? wasi[field]
			: undefined;
		if (kind !== "function") {
			throw new Error(`wasm import ${name}.${field} (${kind}) is not provided`);
		}
		(imports[name] ??= {})[field] = provided ?? (() => {
			throw new Error(`wasm import ${name}.${field} is not provided`);
		});
	}
	const instance = new WebAssembly.Instance(module, imports);
	state.memory = instance.exports.memory as WebAssembly.Memory;
	let code = 0;
	try {
		(instance.exports._start as () => void)();
	} catch (e) {
		if (!(e instanceof Exit)) {
			throw new Error(
				`wasm trapped: ${e instanceof Error ? e.message : e}\n${stderr.text()}`,
				{ cause: e },
			);
		}
		code = e.code;
	}
	if (code !== 0) throw new Error(`wasm exited with ${code}: ${stderr.text()}`);
	return stdout.bytes();
}

class Sink {
	#chunks: Uint8Array[] = [];
	push(chunk: Uint8Array) {
		this.#chunks.push(chunk);
	}
	bytes(): Uint8Array {
		const out = new Uint8Array(this.#chunks.reduce((n, c) => n + c.length, 0));
		let at = 0;
		for (const c of this.#chunks) {
			out.set(c, at);
			at += c.length;
		}
		return out;
	}
	text(): string {
		return new TextDecoder().decode(this.bytes());
	}
}
