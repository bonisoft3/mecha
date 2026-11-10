import {
	FELDERA_IMAGE,
	FELDERA_PLATFORM_VERSION,
	type NativeArtifactManifest,
	type NativeArtifactProgram,
	sha256,
} from "./native-artifacts.ts";
import { type IncrementalProgram, nativeSql } from "./native-sources.ts";

type Spec = { name: string; feldera: string };
type Compilation = {
	id: string;
	program_version: number;
	platform_version: string;
	program_status: string;
	program_error: unknown;
};
const compilerDirectory = "/home/ubuntu/.feldera/compiler";
const decoder = new TextDecoder();
const delay = () => new Promise((resolve) => setTimeout(resolve, 100));

export function buildSpecs(value: unknown): Spec[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("native artifact build requires computations");
	}
	const names = new Set<string>();
	return value.map((entry) => {
		if (
			!entry || typeof entry.name !== "string" ||
			!/^[a-z][a-z0-9_-]{0,99}$/.test(entry.name) ||
			typeof entry.feldera !== "string" || !entry.feldera.startsWith("/") ||
			names.has(entry.name)
		) {
			throw new Error("invalid or duplicate native artifact build computation");
		}
		names.add(entry.name);
		return { name: entry.name, feldera: entry.feldera };
	});
}

export function runtimeLinkage(
	output: string,
): { loader: string; libraries: string[] } {
	if (output.includes("not found")) {
		throw new Error("native artifact has unresolved runtime libraries");
	}
	const libraries = [...new Set(output.match(/\/[^\s()]+/g))].sort();
	const loaders = libraries.filter((path) =>
		/\/ld-linux[^/]+\.so(?:\.\d+)*$/.test(path)
	);
	if (
		loaders.length !== 1 || libraries.length < 2 ||
		libraries.some((path) => path.split("/").includes(".."))
	) {
		throw new Error("unsupported native artifact runtime linkage");
	}
	return { loader: loaders[0], libraries };
}

export async function exportProgram(
	source: string,
	output: string,
	name: string,
	sql: string,
	state: Compilation,
): Promise<NativeArtifactProgram> {
	if (
		state.platform_version !== FELDERA_PLATFORM_VERSION ||
		state.program_status !== "Success" ||
		!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(state.id) ||
		!Number.isSafeInteger(state.program_version) || state.program_version < 1
	) {
		throw new Error("incompatible or unsuccessful native compilation");
	}
	const prefix = `${state.id}_v${state.program_version}_sc_`;
	const names: string[] = [];
	for await (const entry of Deno.readDir(source)) {
		if (entry.isFile) names.push(entry.name);
	}
	const find = (kind: string, suffix: string) => {
		const pattern = new RegExp(
			`^${kind}_${prefix}([0-9a-f]{64})_ic_([0-9a-f]{64})${suffix}$`,
		);
		const matches = names.map((name) => ({ name, match: name.match(pattern) }))
			.filter((entry) => entry.match);
		if (matches.length !== 1) {
			throw new Error(`missing or ambiguous ${kind} artifact for ${name}`);
		}
		return matches[0];
	};
	const binary = find("pipeline", "");
	const info = find("program_info", "\\.json");
	if (binary.match![1] !== info.match![1]) {
		throw new Error("native artifacts have different source checksums");
	}
	const target = `${output}/${name}`;
	await Deno.mkdir(target);
	const copy = async (artifact: typeof binary, filename: string) => {
		const path = `${name}/${filename}`;
		await Deno.copyFile(`${source}/${artifact.name}`, `${output}/${path}`);
		const digest = await sha256(await Deno.readFile(`${output}/${path}`));
		if (digest !== artifact.match![2]) {
			throw new Error(
				`native artifact integrity checksum mismatch: ${artifact.name}`,
			);
		}
		return { path, sha256: digest };
	};
	const entry = {
		sqlSha256: await sha256(sql),
		binary: await copy(binary, "pipeline"),
		programInfo: await copy(info, "program-info.json"),
	};
	await Deno.chmod(`${target}/pipeline`, 0o755);
	const programInfo = JSON.parse(
		await Deno.readTextFile(`${target}/program-info.json`),
	);
	if (
		!programInfo || typeof programInfo !== "object" || !programInfo.inputs ||
		!programInfo.outputs ||
		Object.keys(programInfo.inputs).length ||
		Object.keys(programInfo.outputs).length || !programInfo.program_ir
	) {
		throw new Error(
			"native compiled program must leave connectors to runtime configuration",
		);
	}
	return entry;
}

export async function compileArtifacts(
	specs: Spec[],
	output: string,
	options: {
		endpoint: string;
		compilerDirectory: string;
		signal: AbortSignal;
		timeoutMs: number;
	},
): Promise<NativeArtifactManifest> {
	specs = buildSpecs(specs);
	if (!output.startsWith("/")) {
		throw new Error("native artifact output directory must be absolute");
	}
	await Deno.mkdir(output, { recursive: true });
	for await (const _entry of Deno.readDir(output)) {
		throw new Error("native artifact output directory must be empty");
	}
	const manifest: NativeArtifactManifest = {
		format: 1,
		felderaImage: FELDERA_IMAGE,
		platformVersion: FELDERA_PLATFORM_VERSION,
		architecture: Deno.build.arch,
		programs: {},
		runtime: {
			supervisor: "runtime/supervisor",
			loader: "",
			libraryDirectories: [],
			files: [],
		},
	};
	const libraryPaths = new Set<string>();
	const libraryDirectories = new Set<string>();
	const request = async (path: string, body?: unknown) => {
		const response = await fetch(options.endpoint + path, {
			method: body === undefined ? "GET" : "PUT",
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.any([options.signal, AbortSignal.timeout(30000)]),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`native artifact compiler ${response.status}: ${text}`);
		}
		return JSON.parse(text);
	};
	for (const spec of specs) {
		options.signal.throwIfAborted();
		const program: IncrementalProgram = JSON.parse(
			await Deno.readTextFile(spec.feldera),
		);
		const sql = nativeSql(program);
		const path = `/v0/pipelines/${spec.name}`;
		await request(path, {
			name: spec.name,
			program_code: sql,
			udf_rust: "",
			udf_toml: "",
			program_config: { profile: "optimized" },
			runtime_config: { workers: 1, storage: null },
		});
		const deadline = Date.now() + options.timeoutMs;
		let state: Compilation;
		let previous = "";
		for (;;) {
			options.signal.throwIfAborted();
			state = await request(path);
			if (state.platform_version !== FELDERA_PLATFORM_VERSION) {
				throw new Error("native artifact compiler version mismatch");
			}
			if (state.program_status !== previous) {
				console.log(`native ${spec.name}: ${previous = state.program_status}`);
			}
			if (state.program_status === "Success") break;
			if (
				["SqlError", "RustError", "SystemError"].includes(state.program_status)
			) {
				throw new Error(
					`native ${spec.name} compilation failed: ${
						JSON.stringify(state.program_error)
					}`,
				);
			}
			if (Date.now() >= deadline) {
				throw new Error(`native ${spec.name} compilation timed out`);
			}
			await delay();
		}
		const entry = await exportProgram(
			`${options.compilerDirectory}/rust-compilation/pipeline-binaries`,
			output,
			spec.name,
			sql,
			state,
		);
		manifest.programs[spec.name] = entry;
		const linkage = await new Deno.Command("ldd", {
			args: [`${output}/${entry.binary.path}`],
			stdout: "piped",
			stderr: "piped",
		}).output();
		if (!linkage.success) {
			throw new Error(
				`native runtime linkage failed: ${decoder.decode(linkage.stderr)}`,
			);
		}
		const runtime = runtimeLinkage(decoder.decode(linkage.stdout));
		const loader = "runtime" + runtime.loader;
		if (manifest.runtime.loader && manifest.runtime.loader !== loader) {
			throw new Error("native artifacts require different loaders");
		}
		manifest.runtime.loader = loader;
		for (const path of runtime.libraries) {
			libraryPaths.add(path);
			libraryDirectories.add("runtime" + path.slice(0, path.lastIndexOf("/")));
		}
	}
	for (const path of [...libraryPaths].sort()) {
		const relative = "runtime" + path;
		const target = `${output}/${relative}`;
		await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
			recursive: true,
		});
		await Deno.copyFile(path, target);
		await Deno.chmod(target, 0o755);
		manifest.runtime.files.push({
			path: relative,
			sha256: await sha256(await Deno.readFile(target)),
		});
	}
	manifest.runtime.libraryDirectories = [...libraryDirectories].sort();
	const supervisor = `${output}/${manifest.runtime.supervisor}`;
	const compiled = await new Deno.Command("cc", {
		args: [
			"-static",
			"-O2",
			"-s",
			"-o",
			supervisor,
			decodeURIComponent(
				new URL("native-supervisor.c", import.meta.url).pathname,
			),
		],
		stdout: "piped",
		stderr: "piped",
	}).output();
	if (!compiled.success) {
		throw new Error(
			`native supervisor compilation failed: ${
				decoder.decode(compiled.stderr)
			}`,
		);
	}
	await Deno.chmod(supervisor, 0o755);
	manifest.runtime.files.push({
		path: manifest.runtime.supervisor,
		sha256: await sha256(await Deno.readFile(supervisor)),
	});
	options.signal.throwIfAborted();
	await Deno.writeTextFile(
		`${output}/manifest.json`,
		JSON.stringify(manifest, null, 2) + "\n",
		{ createNew: true },
	);
	return manifest;
}

function positiveInteger(value: string, name: string) {
	if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
		throw new Error(`invalid ${name}`);
	}
	return Number(value);
}

async function build(specs: Spec[], output: string) {
	const jobs = positiveInteger(
		Deno.env.get("FELDERA_BUILD_JOBS") ?? "1",
		"FELDERA_BUILD_JOBS",
	);
	const timeoutMs = positiveInteger(
		Deno.env.get("FELDERA_BUILD_TIMEOUT_MS") ?? "1800000",
		"FELDERA_BUILD_TIMEOUT_MS",
	);
	await Deno.writeTextFile(
		"/home/ubuntu/.cargo/config.toml",
		`[build]\njobs = ${jobs}\n`,
		{ createNew: true },
	);
	const signal = new AbortController();
	const manager = new Deno.Command(
		"/home/ubuntu/feldera/build/pipeline-manager",
		{
			cwd: "/home/ubuntu",
			args: [
				"--bind-address=127.0.0.1",
				"--auth-provider=none",
				"--sql-compiler-path=/home/ubuntu/feldera/build/sql2dbsp-jar-with-dependencies.jar",
				"--compilation-cargo-lock-path=/home/ubuntu/feldera/Cargo.lock",
				"--dbsp-override-path=/home/ubuntu/feldera",
			],
			env: { FELDERA_HTTP_WORKERS: "1", TOKIO_WORKER_THREADS: "2" },
			stdout: "inherit",
			stderr: "inherit",
		},
	).spawn();
	let exited = false;
	const status = manager.status.then((status) => {
		exited = true;
		signal.abort(new Error(`native compiler manager exited: ${status.code}`));
		return status;
	});
	let failure: unknown;
	try {
		const deadline = Date.now() + 120000;
		for (;;) {
			signal.signal.throwIfAborted();
			try {
				const response = await fetch("http://127.0.0.1:8080/healthz", {
					signal: AbortSignal.any([signal.signal, AbortSignal.timeout(1000)]),
				});
				await response.text();
				if (response.ok) break;
				if (response.status !== 503) {
					throw new Error(`native compiler health: ${response.status}`);
				}
			} catch (error) {
				if (!(error instanceof TypeError) && !(error instanceof DOMException)) {
					throw error;
				}
			}
			if (Date.now() >= deadline) {
				throw new Error("native compiler manager startup timed out");
			}
			await delay();
		}
		await compileArtifacts(specs, output, {
			endpoint: "http://127.0.0.1:8080",
			compilerDirectory,
			signal: signal.signal,
			timeoutMs,
		});
	} catch (error) {
		failure = error;
	}
	if (!exited) {
		try {
			manager.kill("SIGTERM");
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) throw error;
		}
	}
	await status;
	if (failure !== undefined) throw failure;
}

if (import.meta.main) {
	const [specFile, output, ...extra] = Deno.args;
	if (!specFile || !output || extra.length) {
		throw new Error(
			"usage: native-artifacts-build.ts <specs.json> <output-directory>",
		);
	}
	await build(
		buildSpecs(JSON.parse(await Deno.readTextFile(specFile))),
		output,
	);
}
