const feldera =
	"images.feldera.com/feldera/pipeline-manager:0.367.0@sha256:42819714d16f7d5d37c17c87812ce98fb23efd2b1bfbf95b4889877f14693272";
const postgres =
	"postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3";
const decoder = new TextDecoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function docker(...args: string[]) {
	const result = await new Deno.Command("docker", {
		args,
		stdout: "piped",
		stderr: "piped",
	}).output();
	if (!result.success) {
		throw new Error(
			`docker ${args.join(" ")}: ${decoder.decode(result.stderr)}${
				decoder.decode(result.stdout)
			}`,
		);
	}
	return decoder.decode(result.stdout).trim();
}

async function save(path: string, value: unknown) {
	await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
}

async function request(
	base: string,
	path: string,
	body?: unknown,
	method?: string,
) {
	const response = await fetch(base + path, {
		method: method ?? (body === undefined ? "GET" : "POST"),
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30000),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
	return text;
}

async function ready(base: string, path: string) {
	const deadline = Date.now() + 60000;
	while (true) {
		try {
			const response = await fetch(base + path, {
				signal: AbortSignal.timeout(1000),
			});
			const text = await response.text();
			if (response.ok) {
				if (
					path !== "/status" || JSON.parse(text).runtime_status === "Running"
				) return;
			} else if (response.status !== 503) {
				throw new Error(`${response.status}: ${text}`);
			}
		} catch (error) {
			if (!(error instanceof TypeError) && !(error instanceof DOMException)) {
				throw error;
			}
		}
		if (Date.now() >= deadline) {
			throw new Error(`${base}${path} did not become ready`);
		}
		await sleep(200);
	}
}

async function endpoint(container: string, port: number) {
	const [state] = JSON.parse(await docker("inspect", container));
	if (!state.State.Running) {
		const logs = await new Deno.Command("docker", {
			args: ["logs", container],
			stdout: "piped",
			stderr: "piped",
		}).output();
		throw new Error(
			`${container} exited ${state.State.ExitCode}: ${
				decoder.decode(logs.stdout)
			}${decoder.decode(logs.stderr)}`,
		);
	}
	return "http://" + await docker("port", container, String(port));
}

const output = Deno.args[0];
if (!output || !output.startsWith("/")) {
	throw new Error(
		"Usage: deno run -A run.ts /absolute/new/evidence/directory [linux/amd64|linux/arm64]",
	);
}
const platform = Deno.args[1] ??
	await docker("version", "--format", "{{.Server.Os}}/{{.Server.Arch}}");
if (Deno.args.length > 2) throw new Error("Unexpected arguments");
await Deno.mkdir(output);
const prefix = "feldera-spike-" +
	crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const builder = prefix + "-builder";
const runtimeImage = prefix + ":runtime";
const root = output + "/rootfs";
const active = new Set<string>();
let network: string | undefined;
let imageCreated = false;
let failure: unknown;
const checks: unknown[] = [];
const report: Record<string, unknown> = {
	feldera_image: feldera,
	postgres_image: postgres,
	platform,
	compiler_limit: "3 GiB, 2 CPUs, one Cargo job",
	runtime_limit: "512 MiB, 1 CPU",
	checks,
};

async function retire(name: string) {
	await docker("stop", "--time", "10", name);
	const result = await new Deno.Command("docker", {
		args: ["logs", name],
		stdout: "piped",
		stderr: "piped",
	}).output();
	if (!result.success) throw new Error("Cannot read container logs: " + name);
	await Deno.writeTextFile(
		output + "/" + name + ".log",
		decoder.decode(result.stdout) + decoder.decode(result.stderr),
	);
	await save(
		output + "/" + name + "-inspect.json",
		JSON.parse(await docker("inspect", name)),
	);
	await docker("rm", name);
	active.delete(name);
}

try {
	{
		await docker(
			"run",
			"-d",
			"--platform",
			platform,
			"--name",
			builder,
			"--memory=3g",
			"--memory-swap=3g",
			"--cpus=2",
			"--pids-limit=512",
			"-e",
			"FELDERA_HTTP_WORKERS=1",
			"-e",
			"TOKIO_WORKER_THREADS=2",
			"-p",
			"127.0.0.1::8080",
			feldera,
		);
		active.add(builder);
		const base = await endpoint(builder, 8080);
		await ready(base, "/healthz");
		await docker(
			"exec",
			builder,
			"sh",
			"-c",
			"printf '[build]\\njobs = 1\\n' > /home/ubuntu/.cargo/config.toml",
		);
		await request(base, "/v0/pipelines/aggregate", {
			name: "aggregate",
			program_code: await Deno.readTextFile(
				new URL("program.sql", import.meta.url),
			),
			program_config: { profile: "optimized" },
			runtime_config: { workers: 1, storage: null },
		}, "PUT");
		const start = Date.now();
		let previous: string | undefined;
		let state;
		while (true) {
			state = JSON.parse(await request(base, "/v0/pipelines/aggregate"));
			if (state.program_status !== previous) {
				console.log("compiler:", previous = state.program_status);
			}
			await save(output + "/compilation.json", state);
			if (previous === "Success") break;
			if (["SqlError", "RustError", "SystemError"].includes(previous!)) {
				throw new Error(JSON.stringify(state.program_error));
			}
			if (Date.now() - start > 1200000) {
				throw new Error("Compilation exceeded 20 minutes");
			}
			await sleep(2000);
		}
		report.compilation_seconds = (Date.now() - start) / 1000;
		report.compiler_peak_bytes = Number(
			await docker("exec", builder, "cat", "/sys/fs/cgroup/memory.peak"),
		);
		const artifacts =
			"/home/ubuntu/.feldera/compiler/rust-compilation/pipeline-binaries";
		const files = (await docker("exec", builder, "ls", artifacts)).split("\n");
		const selector = `_${state.id}_v${state.program_version}_`;
		const binaries = files.filter((name) =>
			name.startsWith("pipeline" + selector)
		);
		const infos = files.filter((name) =>
			name.startsWith("program_info" + selector)
		);
		if (binaries.length !== 1 || infos.length !== 1) {
			throw new Error("Ambiguous compilation artifacts");
		}
		await Deno.mkdir(root + "/app", { recursive: true });
		await Deno.mkdir(root + "/tmp", { recursive: true });
		await Deno.chmod(root + "/app", 0o777);
		await Deno.chmod(root + "/tmp", 0o1777);
		await docker(
			"cp",
			"-L",
			`${builder}:${artifacts}/${binaries[0]}`,
			root + "/app/pipeline",
		);
		await docker(
			"cp",
			"-L",
			`${builder}:${artifacts}/${infos[0]}`,
			output + "/program-info.json",
		);
		const linkage = await docker(
			"exec",
			builder,
			"ldd",
			artifacts + "/" + binaries[0],
		);
		await Deno.writeTextFile(output + "/ldd.txt", linkage + "\n");
		for (const library of new Set(linkage.match(/\/[^\s()]+/g))) {
			const destination = root + library;
			await Deno.mkdir(destination.slice(0, destination.lastIndexOf("/")), {
				recursive: true,
			});
			await docker("cp", "-L", `${builder}:${library}`, destination);
		}
		await Deno.mkdir(root + "/etc/ssl/certs", { recursive: true });
		await docker(
			"cp",
			`${builder}:/etc/ssl/certs/ca-certificates.crt`,
			root + "/etc/ssl/certs/ca-certificates.crt",
		);
		await retire(builder);
		console.log("compiler stopped; packaging runtime");
	}
	const binary = await Deno.readFile(root + "/app/pipeline");
	report.binary_sha256 = Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", binary)),
	).map((v) => v.toString(16).padStart(2, "0")).join("");
	report.binary_bytes = binary.length;
	const runtimeFiles: string[] = [];
	const inventory = async (path: string) => {
		for await (const entry of Deno.readDir(path)) {
			const child = path + "/" + entry.name;
			if (entry.isDirectory) await inventory(child);
			else runtimeFiles.push(child.slice(root.length + 1));
		}
	};
	await inventory(root);
	report.runtime_files = runtimeFiles.sort();
	if (
		runtimeFiles.some((path) =>
			/(^|\/)(java|rustc|cargo|pipeline-manager|sh|bash)$/.test(path)
		)
	) throw new Error("Runtime contains build tools");
	await Deno.copyFile(
		new URL("Dockerfile", import.meta.url),
		output + "/Dockerfile",
	);
	const build = await new Deno.Command("docker", {
		args: [
			"buildx",
			"build",
			"--builder",
			await docker("context", "show"),
			"--load",
			"--platform",
			platform,
			"-t",
			runtimeImage,
			output,
		],
		stdout: "piped",
		stderr: "piped",
	}).output();
	imageCreated = build.success;
	const buildLog = decoder.decode(build.stdout) + decoder.decode(build.stderr);
	await Deno.writeTextFile(output + "/runtime-build.log", buildLog);
	if (!build.success) throw new Error(buildLog);
	const image = JSON.parse(await docker("image", "inspect", runtimeImage))[0];
	report.runtime_image = {
		id: image.Id,
		bytes: image.Size,
		architecture: image.Architecture,
	};
	const programInfo = JSON.parse(
		await Deno.readTextFile(output + "/program-info.json"),
	);

	const launch = async (label: string, inputs: unknown) => {
		const config = {
			...programInfo,
			workers: 1,
			storage: null,
			http_workers: 1,
			io_workers: 1,
			max_parallel_connector_init: 1,
			max_rss: "384MiB",
			inputs,
		};
		const path = output + "/" + label + "-config.json";
		await save(path, config);
		const name = prefix + "-" + label;
		await docker(
			"run",
			"-d",
			"--name",
			name,
			"--memory=512m",
			"--memory-swap=512m",
			"--cpus=1",
			"--pids-limit=128",
			"-p",
			"127.0.0.1::9999",
			...network ? ["--network", network] : [],
			"--mount",
			`type=bind,src=${path},dst=/app/config.json,readonly`,
			runtimeImage,
			"--config-file",
			"/app/config.json",
			"--bind-address",
			"0.0.0.0",
			"--default-port",
			"9999",
			"--initial",
			"running",
			"--deployment-id",
			crypto.randomUUID(),
		);
		active.add(name);
		const url = await endpoint(name, 9999);
		await ready(url, "/status");
		return { name, url };
	};

	type Row = { category: string; items: number; total: number };
	const expect = async (label: string, url: string, rows: Row[]) => {
		const query = new URLSearchParams({
			sql: "SELECT category,items,total FROM totals ORDER BY category",
			format: "json",
		});
		const normalize = (rows: Row[]) =>
			JSON.stringify(rows.map((r) => [r.category, r.items, r.total]));
		const deadline = Date.now() + 90000;
		while (true) {
			const actual = (await request(url, "/query?" + query)).split("\n").filter(
				Boolean,
			).map((line) => JSON.parse(line));
			if (normalize(actual) === normalize(rows)) {
				const stats = JSON.parse(await request(url, "/stats"));
				for (const input of stats.inputs) {
					if (
						input.fatal_error || input.metrics.num_parse_errors ||
						input.metrics.num_transport_errors
					) throw new Error(JSON.stringify(input));
				}
				checks.push({
					name: label,
					rows: actual,
					rss_bytes: stats.global_metrics.rss_bytes,
				});
				await save(output + "/" + label + "-stats.json", stats);
				console.log(label, actual);
				return;
			}
			if (Date.now() > deadline) {
				throw new Error(
					`${label}: expected ${JSON.stringify(rows)}, got ${
						JSON.stringify(actual)
					}`,
				);
			}
			await sleep(200);
		}
	};

	const ingress = async (url: string, changes: unknown[]) => {
		const result = JSON.parse(
			await request(url, "/ingress/orders?format=json&array=true", changes),
		);
		const token = new URLSearchParams({ token: result.token });
		const deadline = Date.now() + 30000;
		while (
			JSON.parse(await request(url, "/completion_status?" + token)).status !==
				"complete"
		) {
			if (Date.now() > deadline) {
				throw new Error("HTTP ingress did not complete");
			}
			await sleep(100);
		}
	};

	const a = { id: 1, category: "a", amount: 10 };
	const b = { id: 2, category: "a", amount: 20 };
	const c = { id: 3, category: "b", amount: 5 };
	const initial = [{ category: "a", items: 2, total: 30 }, {
		category: "b",
		items: 1,
		total: 5,
	}];
	const updated = [{ category: "a", items: 2, total: 60 }, {
		category: "b",
		items: 1,
		total: 5,
	}];
	const deleted = [{ category: "a", items: 1, total: 40 }, {
		category: "b",
		items: 1,
		total: 5,
	}];
	const http = await launch("http", {});
	await ingress(http.url, [a, b, c].map((insert) => ({ insert })));
	await expect("http-insert", http.url, initial);
	await ingress(http.url, [{ delete: a }, { insert: { ...a, amount: 40 } }]);
	await expect("http-update", http.url, updated);
	await ingress(http.url, [{ delete: b }]);
	await expect("http-delete", http.url, deleted);
	await Deno.writeTextFile(
		output + "/runtime-processes.txt",
		await docker("top", http.name, "-eo", "pid,args") + "\n",
	);
	await retire(http.name);

	network = prefix;
	await docker("network", "create", network);
	const pg = prefix + "-postgres";
	await docker(
		"run",
		"-d",
		"--name",
		pg,
		"--network",
		network,
		"--network-alias",
		"source",
		"--memory=256m",
		"--memory-swap=256m",
		"--cpus=1",
		"-e",
		"POSTGRES_PASSWORD=spike",
		postgres,
		"-c",
		"wal_level=logical",
		"-c",
		"max_replication_slots=20",
		"-c",
		"max_wal_senders=20",
	);
	active.add(pg);
	const deadline = Date.now() + 60000;
	while (true) {
		const probe = await new Deno.Command("docker", {
			args: ["exec", pg, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
			stdout: "null",
			stderr: "null",
		}).output();
		if (probe.success) break;
		if (Date.now() > deadline) throw new Error("PostgreSQL did not start");
		await sleep(200);
	}
	const sql = (statement: string) =>
		docker(
			"exec",
			pg,
			"psql",
			"-h",
			"127.0.0.1",
			"-U",
			"postgres",
			"-v",
			"ON_ERROR_STOP=1",
			"-c",
			statement,
		);
	for (const epoch of ["one", "two"]) {
		const schema = "epoch_" + epoch;
		const publication = "publication_" + epoch;
		await sql(
			`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.orders (id bigint PRIMARY KEY, category text NOT NULL, amount bigint NOT NULL); ALTER TABLE ${schema}.orders REPLICA IDENTITY FULL; CREATE PUBLICATION ${publication} FOR TABLE ${schema}.orders; INSERT INTO ${schema}.orders VALUES (1,'a',10),(2,'a',20)`,
		);
		const runtime = await launch("cdc-" + epoch, {
			cdc_orders: {
				stream: "orders",
				transport: {
					name: "postgres_cdc_input",
					config: {
						uri: "postgresql://postgres:spike@source:5432/postgres",
						publication,
						source_table: schema + ".orders",
					},
				},
			},
		});
		await expect(`cdc-${epoch}-baseline`, runtime.url, initial.slice(0, 1));
		await sql(`INSERT INTO ${schema}.orders VALUES (3,'b',5)`);
		await expect(`cdc-${epoch}-insert`, runtime.url, initial);
		await sql(`UPDATE ${schema}.orders SET amount=40 WHERE id=1`);
		await expect(`cdc-${epoch}-update`, runtime.url, updated);
		await sql(`DELETE FROM ${schema}.orders WHERE id=2`);
		await expect(`cdc-${epoch}-delete`, runtime.url, deleted);
		await retire(runtime.name);
	}
	await retire(pg);
	await docker("network", "rm", network);
	network = undefined;
	report.result = "passed";
} catch (error) {
	failure = error;
}
{
	const errors: unknown[] = failure === undefined ? [] : [failure];
	for (const name of [...active]) {
		try {
			await retire(name);
		} catch (error) {
			errors.push(error);
		}
	}
	if (network) {
		try {
			await docker("network", "rm", network);
		} catch (error) {
			errors.push(error);
		}
	}
	if (imageCreated) {
		try {
			await docker("image", "rm", runtimeImage);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length) {
		throw new AggregateError(errors, "Standalone spike failed");
	}
}
await save(output + "/result.json", report);
console.log("PASS:", output + "/result.json");
