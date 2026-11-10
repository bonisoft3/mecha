import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
	buildSpecs,
	compileArtifacts,
	exportProgram,
	runtimeLinkage,
} from "./native-artifacts-build.ts";
import { FELDERA_PLATFORM_VERSION, sha256 } from "./native-artifacts.ts";

Deno.test("artifact build rejects duplicate names and paths outside its declared input contract", () => {
	assertEquals(
		buildSpecs([{ name: "cards", feldera: "/app/cards.json", ignored: true }]),
		[{ name: "cards", feldera: "/app/cards.json" }],
	);
	for (
		const specs of [[], [{ name: "../cards", feldera: "/app/cards.json" }], [{
			name: "cards",
			feldera: "cards.json",
		}], [{ name: "cards", feldera: "/a.json" }, {
			name: "cards",
			feldera: "/b.json",
		}]]
	) {
		assertThrows(() => buildSpecs(specs));
	}
});

Deno.test("runtime linkage preserves the Ubuntu loader for isolation from the host libc", () => {
	for (
		const loader of [
			"/lib/ld-linux-aarch64.so.1",
			"/lib64/ld-linux-x86-64.so.2",
		]
	) {
		assertEquals(
			runtimeLinkage(
				`linux-vdso.so.1 (0x1)\n librdkafka.so.1 => /usr/local/lib/librdkafka.so.1 (0x2)\n ${loader} (0x3)`,
			),
			{
				loader,
				libraries: [loader, "/usr/local/lib/librdkafka.so.1"].sort(),
			},
		);
	}
	assertThrows(
		() => runtimeLinkage("libmissing.so => not found"),
		Error,
		"unresolved",
	);
	assertThrows(() => runtimeLinkage("statically linked"), Error, "unsupported");
});

async function fixture() {
	const dir = await Deno.makeTempDir();
	const source = `${dir}/source`;
	const output = `${dir}/output`;
	await Deno.mkdir(source);
	await Deno.mkdir(output);
	const state = {
		id: "00000000-0000-0000-0000-000000000001",
		program_version: 2,
		platform_version: FELDERA_PLATFORM_VERSION,
		program_status: "Success",
		program_error: null,
	};
	const prefix = `${state.id}_v2_sc_${"a".repeat(64)}`;
	const binary = "executable bytes";
	const info = JSON.stringify({ inputs: {}, outputs: {}, program_ir: {} });
	const binaryFile = `${source}/pipeline_${prefix}_ic_${await sha256(binary)}`;
	const infoFile = `${source}/program_info_${prefix}_ic_${await sha256(
		info,
	)}.json`;
	await Deno.writeTextFile(binaryFile, binary);
	await Deno.writeTextFile(infoFile, info);
	return {
		dir,
		source,
		output,
		state,
		binary,
		info,
		binaryFile,
		infoFile,
		async [Symbol.asyncDispose]() {
			await Deno.remove(dir, { recursive: true });
		},
	};
}

Deno.test("artifact export verifies compiler digests and records the exact generated SQL", async () => {
	await using f = await fixture();
	await Deno.writeTextFile(
		`${f.source}/pipeline_unrelated_old_version`,
		"stale",
	);
	const entry = await exportProgram(
		f.source,
		f.output,
		"cards",
		"native sql",
		f.state,
	);
	assertEquals(entry, {
		sqlSha256: await sha256("native sql"),
		binary: { path: "cards/pipeline", sha256: await sha256(f.binary) },
		programInfo: {
			path: "cards/program-info.json",
			sha256: await sha256(f.info),
		},
	});
	assertEquals(await Deno.readTextFile(`${f.output}/cards/pipeline`), f.binary);
	assertEquals(
		(await Deno.stat(`${f.output}/cards/pipeline`)).mode! & 0o777,
		0o755,
	);
	await assertRejects(
		() => Deno.stat(`${f.output}/manifest.json`),
		Deno.errors.NotFound,
	);
});

Deno.test("artifact export refuses bytes which disagree with the compiler filename checksum", async () => {
	await using f = await fixture();
	await Deno.writeTextFile(f.binaryFile, "corrupted");
	await assertRejects(
		() => exportProgram(f.source, f.output, "cards", "sql", f.state),
		Error,
		"integrity checksum mismatch",
	);
});

Deno.test("artifact export cannot combine program info from a different source or platform", async () => {
	await using f = await fixture();
	await assertRejects(
		() =>
			exportProgram(f.source, f.output, "cards", "sql", {
				...f.state,
				platform_version: "0.368.0",
			}),
		Error,
		"incompatible",
	);
	await Deno.rename(
		f.infoFile,
		f.infoFile.replace("a".repeat(64), "b".repeat(64)),
	);
	await assertRejects(
		() => exportProgram(f.source, f.output, "cards", "sql", f.state),
		Error,
		"different source checksums",
	);
});

Deno.test("artifact compilation fails on SQL errors without publishing a runnable manifest", async () => {
	const dir = await Deno.makeTempDir();
	const server = Deno.serve(
		{ hostname: "127.0.0.1", port: 0, onListen() {} },
		async (request) => {
			if (request.method === "PUT") {
				const body = await request.json();
				assertEquals(body.program_config, { profile: "optimized" });
				return Response.json({});
			}
			return Response.json({
				platform_version: FELDERA_PLATFORM_VERSION,
				program_status: "SqlError",
				program_error: { message: "bad aggregation" },
			});
		},
	);
	try {
		const file = `${dir}/program.json`;
		await Deno.writeTextFile(
			file,
			JSON.stringify({
				sql: "INVALID SQL",
				inputs: {},
				outputs: {},
				incremental: { inputs: {}, outputs: {} },
			}),
		);
		await assertRejects(
			() =>
				compileArtifacts([{ name: "cards", feldera: file }], `${dir}/output`, {
					endpoint: `http://127.0.0.1:${server.addr.port}`,
					compilerDirectory: dir,
					timeoutMs: 1000,
					signal: new AbortController().signal,
				}),
			Error,
			"bad aggregation",
		);
		await assertRejects(
			() => Deno.stat(`${dir}/output/manifest.json`),
			Deno.errors.NotFound,
		);
	} finally {
		await server.shutdown();
		await Deno.remove(dir, { recursive: true });
	}
});
