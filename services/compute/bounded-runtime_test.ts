import { assert, assertEquals, assertRejects } from "@std/assert";
import { type BoundedOptions, BoundedRuntime } from "./bounded-runtime.ts";
import { encodeWasmQueryInput } from "../../packages/compute-snapshot/src/bounded.ts";

const source =
	`export const reads=[]; export const queries={}; export const finish=()=>({});
export async function plan(host, seed, checkpoint) {
 const after=checkpoint??0;
 const rows=await host.query('SELECT sequence,value FROM duckstream_private.result_items WHERE sequence>'+after+' ORDER BY sequence LIMIT 100');
 return {checkpoint:rows.length?rows[rows.length-1].sequence:after,
 writes:{sink:rows.map(r=>JSON.parse(r.value))},done:rows.length<100};
}`;
function options(directory: string): BoundedOptions {
	return {
		directory,
		databaseUrl: "",
		source,
		version: "v1",
		spec: {
			name: "fixture",
			file: "fixture.js",
			steps: "fixture-steps.js",
			to: ["sink"],
			wasm: [],
		},
		reads: [],
		queries: {
			items:
				"SELECT i::VARCHAR AS id, i::INTEGER AS value FROM range(301) t(i)",
		},
		runner: {
			run: () => {
				throw new Error("unexpected WASM");
			},
		},
	};
}
Deno.test("bounded captures survive restart and retain frozen multi-query inputs", async () => {
	const directory = await Deno.makeTempDir();
	try {
		const config = options(directory);
		config.queries.other = "SELECT 42 AS answer";
		const first = await BoundedRuntime.create(config);
		const capture = await first.capture();
		assertEquals(Object.keys(capture).sort(), ["id", "name", "version"]);
		const restarted = await BoundedRuntime.create({
			...config,
			queries: {
				items: "SELECT 'changed' AS id,0 AS value",
				other: "SELECT 0 AS answer",
			},
		});
		const output = await restarted.calculate(
			JSON.parse(JSON.stringify(capture)),
		);
		const pages = [];
		for await (const page of restarted.pages(output, "sink")) pages.push(page);
		assertEquals(pages.map((p) => p.length), [128, 128, 45]);
		assertEquals(pages.flat().length, 301);
		assert(pages.flat().every((row) => row.id !== "changed"));
		const again = await restarted.calculate(capture);
		const replay = [];
		for await (const page of restarted.pages(again, "sink")) {
			replay.push(...page);
		}
		assertEquals(replay, pages.flat());
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});
Deno.test("bounded runtime executes single-pass calculate computations without steps", async () => {
	const directory = await Deno.makeTempDir();
	try {
		const config = options(directory);
		delete config.spec.steps;
		delete config.source;
		config.computation = {
			async calculate(inputs) {
				const rows =
					((inputs as { items?: { id: string; value: number }[] }).items) ?? [];
				return { sink: rows.filter((r) => r.value < 5) };
			},
		};
		const runtime = await BoundedRuntime.create(config);
		const capture = await runtime.capture();
		const output = await runtime.calculate(capture);
		const pages = [];
		for await (const page of runtime.pages(output, "sink")) pages.push(...page);
		assertEquals(pages, [
			{ id: "0", value: 0 },
			{ id: "1", value: 1 },
			{ id: "2", value: 2 },
			{ id: "3", value: 3 },
			{ id: "4", value: 4 },
		]);
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});
Deno.test("failed calculation removes scratch files while retaining replay inputs", async () => {
	const directory = await Deno.makeTempDir();
	try {
		const config = options(directory);
		const runtime = await BoundedRuntime.create({
			...config,
			source: `export const reads=[]; export const queries={};
export const finish=()=>({});
export function plan(){throw new Error('calculation failed');}`,
		});
		const capture = await runtime.capture();
		for (let attempt = 0; attempt < 2; attempt++) {
			await assertRejects(
				() => runtime.calculate(capture),
				Error,
				"calculation failed",
			);
			const files = [];
			for await (const file of Deno.readDir(directory)) files.push(file.name);
			assertEquals(files, [`capture-${capture.id}.duckdb`]);
		}
		const restarted = await BoundedRuntime.create(config);
		const output = await restarted.calculate(capture);
		let count = 0;
		for await (const page of restarted.pages(output, "sink")) {
			count += page.length;
		}
		assertEquals(count, 301);
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});
Deno.test("bounded workers cannot read host files through DuckDB table functions", async () => {
	const directory = await Deno.makeTempDir();
	try {
		const secret = `${directory}/secret.txt`;
		await Deno.writeTextFile(secret, "private-service-credential");
		const config = options(directory);
		const runtime = await BoundedRuntime.create({
			...config,
			source: `export const reads=[]; export const queries={};
export const finish=()=>({});
export async function plan(host){
 await host.query(${
				JSON.stringify(`SELECT content FROM read_text('${secret}')`)
			});
 return {checkpoint:null,writes:{},done:true};
}`,
		});
		const capture = await runtime.capture();
		await assertRejects(() => runtime.calculate(capture), Error, "disabled");
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});
Deno.test("bounded empty output yields no pages and missing captures fail", async () => {
	const directory = await Deno.makeTempDir();
	try {
		const config = options(directory);
		config.queries.items = "SELECT 'none' AS id,0 AS value WHERE false";
		const runtime = await BoundedRuntime.create(config);
		const capture = await runtime.capture();
		const output = await runtime.calculate(capture);
		const pages = [];
		for await (const page of runtime.pages(output, "sink")) pages.push(page);
		assertEquals(pages, []);
		await Deno.remove(`${directory}/capture-${capture.id}.duckdb`);
		await assertRejects(() => runtime.calculate(capture), Deno.errors.NotFound);
		await assertRejects(
			() => runtime.calculate({ ...capture, id: "../escape" }),
			Error,
			"invalid bounded manifest",
		);
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});
Deno.test("bounded query limits fail before returning an oversized relation", async () => {
	const directory = await Deno.makeTempDir();
	try {
		const config = options(directory);
		config.source =
			`export const reads=[];export const queries={};export const finish=()=>({});export async function plan(host){await host.query('SELECT * FROM range(4097)');return {checkpoint:null,writes:{},done:true}}`;
		const runtime = await BoundedRuntime.create(config);
		const capture = await runtime.capture();
		await assertRejects(
			() => runtime.calculate(capture),
			Error,
			"execution query exceeds page limit",
		);
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});
Deno.test("bounded query checks the same relation it returns", async () => {
	const directory = await Deno.makeTempDir();
	try {
		const config = options(directory);
		const sql =
			"SELECT i FROM range(CASE WHEN contains(current_query(), 'AS'||chr(32)||'size') THEN 1 ELSE 4097 END) t(i)";
		config.source =
			`export const reads=[];export const queries={};export const finish=()=>({});export async function plan(host){await host.query(${
				JSON.stringify(sql)
			});return {checkpoint:null,writes:{},done:true}}`;
		const runtime = await BoundedRuntime.create(config);
		const capture = await runtime.capture();
		await assertRejects(
			() => runtime.calculate(capture),
			Error,
			"execution query exceeds page limit",
		);
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});
Deno.test("bounded output pages respect bytes and scratch commits feed later steps", async () => {
	const directory = await Deno.makeTempDir();
	try {
		const config = options(directory);
		config.queries.items =
			"SELECT i::VARCHAR AS id, repeat('x',100000) AS value FROM range(5) t(i)";
		config.source =
			`export const reads=[];export const queries={};export const finish=()=>({});
      export async function plan(host, seed, checkpoint){
      if(checkpoint===null)return {checkpoint:1,writes:{},statements:['CREATE TABLE scratch AS SELECT 7 AS value'],done:false};
      const scratch=await host.query('SELECT * FROM scratch');
      if(scratch[0].value!==7)throw new Error('scratch lost');
      const rows=await host.query('SELECT value FROM duckstream_private.result_items');
      return {checkpoint:2,writes:{sink:rows.map(r=>JSON.parse(r.value))},done:true};}`;
		const runtime = await BoundedRuntime.create(config);
		const output = await runtime.calculate(await runtime.capture());
		const pages = [];
		for await (const page of runtime.pages(output, "sink")) {
			assert(
				new TextEncoder().encode(JSON.stringify(page)).length <= 256 * 1024,
			);
			pages.push(page);
		}
		assertEquals(pages.map((p) => p.length), [2, 2, 1]);
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});

Deno.test("query-backed WASM pages preserve order and columns across row and byte limits", async () => {
	const directory = await Deno.makeTempDir();
	try {
		for (const [count, width] of [[5000, 300], [2, 600000], [0, 0]]) {
			const config = options(directory);
			config.spec.wasm = ["test.wasm"];
			config.queries = {};
			const sql =
				`SELECT i::INTEGER AS ordinal,repeat('x',${width}) AS item,i::INTEGER AS total,(i+1)::INTEGER AS __bounded_position FROM range(${count}) t(i)`;
			let oldInput: string | undefined;
			if (count === 5000) {
				const db = await DuckDBInstance.create(":memory:");
				const con = await db.connect();
				try {
					const encoded = await encodeWasmQueryInput(
						{ request: { games: [] } },
						{ path: ["request", "games"], orderBy: "ordinal", sql },
						async (after) => {
							const result = await con.runAndReadAll(
								`SELECT * FROM (${sql}) r WHERE ordinal > ${after} ORDER BY ordinal LIMIT 128`,
							);
							const rows = result.getRowObjects();
							let next = after;
							const values = rows.map((row) => {
								next = Number(row.ordinal);
								const value = { ...row };
								delete value.ordinal;
								return value;
							});
							return { after, next, done: rows.length < 128, rows: values };
						},
					);
					oldInput = new TextDecoder().decode(encoded);
				} finally {
					con.closeSync();
					db.closeSync();
				}
			}
			let seen = false;
			config.runner = {
				run: (jobs) => {
					if (oldInput !== undefined) assertEquals(jobs[0].input, oldInput);
					const input = JSON.parse(jobs[0].input);
					assertEquals(input.request.games.length, count);
					for (let i = 0; i < count; i++) {
						assertEquals(input.request.games[i], {
							item: "x".repeat(width),
							total: i,
							__bounded_position: i + 1,
						});
					}
					seen = true;
					return Promise.resolve([true]);
				},
			};
			config.source =
				`export const reads=[];export const queries={};export const finish=()=>({});
export async function plan(host){
 await host.wasmFromQuery('test',{request:{games:[]}},{path:['request','games'],orderBy:'ordinal',sql:${
					JSON.stringify(sql)
				} });
 return {checkpoint:null,writes:{},done:true};
}`;
			const runtime = await BoundedRuntime.create(config);
			await runtime.calculate(await runtime.capture());
			assert(seen);
		}
		const alias = options(directory);
		alias.spec.wasm = ["test.wasm"];
		alias.queries = {};
		let aliasSeen = false;
		alias.runner = {
			run: (jobs) => {
				assertEquals(JSON.parse(jobs[0].input), { games: [{ r: 2 }] });
				aliasSeen = true;
				return Promise.resolve([true]);
			},
		};
		alias.source =
			`export const reads=[];export const queries={};export const finish=()=>({});
export async function plan(host){
 await host.wasmFromQuery('test',{games:[]},{path:['games'],orderBy:'ordinal',sql:'SELECT 1 AS ordinal,2 AS r'});
 return {checkpoint:null,writes:{},done:true};
}`;
		const aliasRuntime = await BoundedRuntime.create(alias);
		await aliasRuntime.calculate(await aliasRuntime.capture());
		assert(aliasSeen);
		const config = options(directory);
		config.spec.wasm = ["test.wasm"];
		config.queries = {};
		config.source =
			`export const reads=[];export const queries={};export const finish=()=>({});
export async function plan(host){
 await host.wasmFromQuery('test',{games:[]},{path:['games'],orderBy:'ordinal',sql:"SELECT 1 AS ordinal,repeat('x',1048576) AS value"});
 return {checkpoint:null,writes:{},done:true};
}`;
		const runtime = await BoundedRuntime.create(config);
		const capture = await runtime.capture();
		await assertRejects(
			() => runtime.calculate(capture),
			Error,
			"execution query row exceeds page limit",
		);
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});

Deno.test("bounded publication keeps sink order across row and byte limits", async () => {
	const directory = await Deno.makeTempDir();
	try {
		const config = options(directory);
		config.spec.to = ["sink", "other", "empty"];
		config.source =
			`export const reads=[];export const queries={};export const finish=()=>({});
export function plan(){
 const small=Array.from({length:130},(_,i)=>({id:String(129-i).padStart(3,'0'),value:i}));
 const prefix=JSON.stringify({id:'a',value:''}).length;
 return {checkpoint:null,writes:{sink:small,other:[{id:'b',value:'z'},{id:'a',value:'x'.repeat(262142-prefix)}]},done:true};
}`;
		const runtime = await BoundedRuntime.create(config);
		const output = await runtime.calculate(await runtime.capture());
		const small = [];
		for await (const page of runtime.pages(output, "sink")) small.push(page);
		assertEquals(small.map((page) => page.length), [128, 2]);
		assertEquals(
			small.flat().map((row) => row.id),
			Array.from({ length: 130 }, (_, i) => String(i).padStart(3, "0")),
		);
		const large = [];
		for await (const page of runtime.pages(output, "other")) large.push(page);
		assertEquals(large.map((page) => page.length), [1, 1]);
		assertEquals(large.flat().map((row) => row.id), ["a", "b"]);
		assertEquals(
			new TextEncoder().encode(JSON.stringify(large[0])).length,
			262144,
		);
		const empty = [];
		for await (const page of runtime.pages(output, "empty")) empty.push(page);
		assertEquals(empty, []);
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});

Deno.test("bounded captures preserve portable canonical fields and staged queries", async () => {
	const { fields, nativeSql, row, table } = await import(
		"./portable-fixture.ts"
	);
	const directory = await Deno.makeTempDir();
	try {
		const config = options(directory);
		config.spec.types = table;
		config.spec.queryTypes = {
			items: fields,
		};
		config.queries.items = nativeSql;
		config.queryStages = {
			items: {
				stages: [{ name: "__duckstream_fixture", sql: config.queries.items }],
				sql: "SELECT * FROM __duckstream_fixture",
			},
		};
		const runtime = await BoundedRuntime.create(config);
		const output = await runtime.calculate(await runtime.capture());
		const actual = [];
		for await (const page of runtime.pages(output, "sink")) {
			actual.push(...page);
		}
		assertEquals(actual, [row]);
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});

Deno.test("bounded collection retains active snapshots and release is idempotent", async () => {
	const { collectBoundedFiles } = await import("./bounded-runtime.ts");
	const directory = await Deno.makeTempDir();
	try {
		const runtime = await BoundedRuntime.create(options(directory));
		const retained = await runtime.capture();
		const orphan = await runtime.capture();
		const output = await runtime.calculate(orphan);
		const unrelated = `${directory}/notes.txt`;
		await Deno.writeTextFile(unrelated, "keep");
		await Deno.writeTextFile(
			`${directory}/capture-${orphan.id}.duckdb.wal`,
			"orphan",
		);
		await Deno.mkdir(`${directory}/output-${output.id}.duckdb.tmp`);
		await Deno.writeTextFile(
			`${directory}/output-${output.id}.duckdb.tmp/spill`,
			"orphan",
		);
		await collectBoundedFiles(directory, [retained]);
		assertEquals(await Deno.readTextFile(unrelated), "keep");
		await assertRejects(
			() => Deno.stat(`${directory}/capture-${orphan.id}.duckdb`),
			Deno.errors.NotFound,
		);
		await assertRejects(
			() => Deno.stat(`${directory}/output-${output.id}.duckdb`),
			Deno.errors.NotFound,
		);
		const discarded = await runtime.calculate(retained);
		await runtime.discard(discarded);
		await runtime.discard(discarded);
		await assertRejects(
			() => Deno.stat(`${directory}/output-${discarded.id}.duckdb`),
			Deno.errors.NotFound,
		);
		const result = await runtime.calculate(retained);
		await runtime.release(retained, result);
		await runtime.release(retained, result);
		await assertRejects(
			() => collectBoundedFiles(directory, [retained]),
			Deno.errors.NotFound,
		);
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});

import pg from "npm:pg@8.16.3";
import { DuckDBInstance } from "npm:@duckdb/node-api@1.5.6-r.1";
import { pgTest, postgres } from "./pg-test.ts";

pgTest(
	"bounded PostgreSQL capture freezes both tables before a concurrent commit and reopens without WAL",
	async () => {
		await using server = await postgres();
		const admin = new pg.Client({ connectionString: server.url });
		const barrier = new pg.Client({ connectionString: server.url });
		const directory = await Deno.makeTempDir();
		await admin.connect();
		await barrier.connect();
		try {
			await admin.query(
				`CREATE TABLE first_input(id text PRIMARY KEY,value integer,note text);
      CREATE TABLE second_input(id text PRIMARY KEY,value integer);
      INSERT INTO first_input VALUES('one',1,'before');
      INSERT INTO second_input VALUES('one',1);
      CREATE VIEW slow_input AS SELECT id,value,note,pg_advisory_xact_lock(7217)::text AS barrier FROM first_input`,
			);
			await barrier.query("BEGIN; SELECT pg_advisory_xact_lock(7217)");
			const config = options(directory);
			config.databaseUrl = server.url;
			config.reads = ["slow_input", "second_input"];
			config.queries = {
				items:
					"SELECT a.id,a.value AS first,b.value AS second,a.note FROM slow_input a JOIN second_input b USING(id)",
				other: "SELECT value FROM second_input",
			};
			config.source = config.source!.replace(
				"const after=checkpoint??0;",
				`const after=checkpoint??0;
      const other=await host.query('SELECT value FROM duckstream_private.result_other');
      if(JSON.parse(other[0].value).value!==1)throw new Error('second query changed');`,
			);
			const runtime = await BoundedRuntime.create(config);
			const pending = runtime.capture();
			const deadline = Date.now() + 10000;
			for (;;) {
				const { rows } = await admin.query(
					"SELECT count(*)::integer AS waiting FROM pg_stat_activity WHERE wait_event='advisory'",
				);
				if (rows[0].waiting) break;
				if (Date.now() > deadline) {
					throw new Error("capture did not reach snapshot barrier");
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			await admin.query(
				"BEGIN; UPDATE first_input SET value=2,note='after'; UPDATE second_input SET value=2; COMMIT",
			);
			await barrier.query("COMMIT");
			const capture = await pending;
			const file = `${directory}/capture-${capture.id}.duckdb`;
			assert((await Deno.stat(file)).size > 0);
			await assertRejects(() => Deno.stat(file + ".wal"), Deno.errors.NotFound);
			const database = await DuckDBInstance.create(file, {
				access_mode: "READ_ONLY",
			});
			const connection = await database.connect();
			try {
				const copied = await connection.runAndReadAll(
					"SELECT id,value,note FROM slow_input",
				);
				assertEquals(copied.getRowObjects(), [{
					id: "one",
					value: 1,
					note: "before",
				}]);
			} finally {
				connection.closeSync();
				database.closeSync();
			}
			await admin.query("TRUNCATE first_input,second_input");
			const restarted = await BoundedRuntime.create(config);
			const output = await restarted.calculate(
				JSON.parse(JSON.stringify(capture)),
			);
			const rows = [];
			for await (const page of restarted.pages(output, "sink")) {
				rows.push(...page);
			}
			assertEquals(rows, [{ id: "one", first: 1, second: 1, note: "before" }]);
			await restarted.release(capture, output);
		} finally {
			await barrier.end();
			await admin.end();
			await Deno.remove(directory, { recursive: true });
		}
	},
);

Deno.test("failed staged capture removes its unpublished database and temporary artifacts", async () => {
	const directory = await Deno.makeTempDir();
	try {
		const config = options(directory);
		config.queryStages = {
			items: {
				stages: [{ name: "__duckstream_first", sql: "SELECT 1 AS value" }],
				sql: "SELECT error('capture failed') AS value FROM __duckstream_first",
			},
		};
		const runtime = await BoundedRuntime.create(config);
		await assertRejects(() => runtime.capture(), Error, "capture failed");
		const files = [];
		for await (const file of Deno.readDir(directory)) files.push(file.name);
		assertEquals(files, []);
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});

Deno.test("bounded default conversion rejects unsafe integer carriers and preserves native floating and nested values", async () => {
	const { duckdb, readerOf } = await import("./main.ts");
	const directory = await Deno.makeTempDir();
	const database = await duckdb();
	const connection = await database.connect();
	try {
		for (
			const value of [
				"9007199254740993::BIGINT",
				"9007199254740993::HUGEINT",
				"[9007199254740993::BIGINT]",
				"{'nested':9007199254740993::BIGINT}",
			]
		) {
			const config = options(directory);
			config.queries.items = `SELECT 'one' AS id,${value} AS value`;
			await assertRejects(
				() => readerOf(connection).query(config.queries.items),
				RangeError,
				"exact integers",
			);
			const runtime = await BoundedRuntime.create(config);
			await assertRejects(
				() => runtime.capture(),
				RangeError,
				"exact integers",
			);
		}
		const config = options(directory);
		config.queries.items =
			`SELECT 'one' AS id, 1e30::DOUBLE AS wide, 1.25::FLOAT AS small,
      123.45::DECIMAL(9,2) AS amount, [1::BIGINT,2::BIGINT] AS numbers,
      {'amount':12.34::DECIMAL(9,2),'wide':1e30::DOUBLE} AS nested,
      99 AS __duckstream_position`;
		const expected = await readerOf(connection).query(config.queries.items);
		const runtime = await BoundedRuntime.create(config);
		const output = await runtime.calculate(await runtime.capture());
		const actual = [];
		for await (const page of runtime.pages(output, "sink")) {
			actual.push(...page);
		}
		assertEquals(actual, expected);
	} finally {
		connection.closeSync();
		database.closeSync();
		await Deno.remove(directory, { recursive: true });
	}
});

Deno.test("bounded capture preserves query order across native conversion pages", async () => {
	const directory = await Deno.makeTempDir();
	try {
		const config = options(directory);
		config.queries.items =
			"SELECT i::VARCHAR AS id,i::INTEGER AS value FROM range(8193) r(i) ORDER BY i DESC";
		config.source =
			`export const reads=[];export const queries={};export const finish=()=>({});
      export async function plan(host,seed,checkpoint){
        const after=checkpoint??0;
        const rows=await host.query('SELECT sequence,value FROM duckstream_private.result_items WHERE sequence>'+after+' ORDER BY sequence LIMIT 100');
        for(const row of rows)if(JSON.parse(row.value).value!==8193-row.sequence)throw new Error('capture order changed');
        return {checkpoint:rows.length?rows[rows.length-1].sequence:after,writes:{sink:rows.map(r=>JSON.parse(r.value))},done:rows.length<100};}`;
		const runtime = await BoundedRuntime.create(config);
		const output = await runtime.calculate(await runtime.capture());
		let count = 0;
		for await (const page of runtime.pages(output, "sink")) {
			count += page.length;
		}
		assertEquals(count, 8193);
		config.source =
			`export const reads=[];export const queries={};export const finish=()=>({});
      export function plan(){return {checkpoint:null,writes:{},statements:['CREATE TABLE first_scratch AS SELECT 1 AS value','CREATE TABLE second_scratch AS SELECT * FROM first_scratch'],done:true}}`;
		const invalid = await BoundedRuntime.create(config);
		await assertRejects(
			() => invalid.calculate(output.capture),
			Error,
			"does not exist",
		);
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});

Deno.test("bounded sink batches preserve JSON strings and replace keys only across steps", async () => {
	const directory = await Deno.makeTempDir();
	try {
		const config = options(directory);
		config.queries = {};
		const rows = [
			{
				id: "",
				value: {
					text: 'line\nquoted "value" \\ café',
					numbers: [1e30, 0.125, null],
				},
			},
			{ id: "key'\"\\雪", value: { text: "before", numbers: [1, 2, null] } },
		];
		const updated = {
			...rows[1],
			value: { text: "after\n\\雪", numbers: [3, 4, null] },
		};
		config.source =
			`export const reads=[];export const queries={};export const finish=()=>({});
      export function plan(host,seed,checkpoint){
        return checkpoint===null
          ? {checkpoint:1,writes:{sink:${JSON.stringify(rows)}},done:false}
          : {checkpoint:2,writes:{sink:${JSON.stringify([updated])}},done:true};
      }`;
		const runtime = await BoundedRuntime.create(config);
		const capture = await runtime.capture();
		const output = await runtime.calculate(capture);
		const actual = [];
		for await (const page of runtime.pages(output, "sink")) {
			actual.push(...page);
		}
		assertEquals(actual, [rows[0], updated]);
		await runtime.discard(output);
		for (
			const [writes, message] of [
				[[updated, updated], "invalid execution output row"],
				[
					[{ id: rows[1].id, changed: true }],
					"execution output columns differ",
				],
			] as const
		) {
			const invalid = await BoundedRuntime.create({
				...config,
				source: config.source.replace(
					JSON.stringify([updated]),
					JSON.stringify(writes),
				),
			});
			await assertRejects(() => invalid.calculate(capture), Error, message);
		}
		const replay = await runtime.calculate(capture);
		await runtime.release(capture, replay);
	} finally {
		await Deno.remove(directory, { recursive: true });
	}
});

pgTest(
	"bounded persistent replica seeds once and applies LSN-fenced WAL deltas and duckpipe tables",
	async () => {
		await using server = await postgres();
		const admin = new pg.Client({ connectionString: server.url });
		const directory = await Deno.makeTempDir();
		await admin.connect();
		try {
			const batchesSql = await Deno.readTextFile(
				new URL("./batches.sql", import.meta.url),
			);
			await admin.query(`
        CREATE SCHEMA hybrid_compute_batch;
        CREATE TABLE hybrid_compute_batch.instance (id uuid PRIMARY KEY, state jsonb NOT NULL DEFAULT '{}'::jsonb);
        CREATE SCHEMA compute;
        CREATE TABLE compute.machine_version (fingerprint text NOT NULL);
      `);
			await admin.query(batchesSql);
			await admin.query(`
        CREATE TABLE games (id text PRIMARY KEY, goals int NOT NULL);
        CREATE TABLE teams (id text PRIMARY KEY, name text NOT NULL);
        INSERT INTO games VALUES ('g1', 2), ('g2', 3);
        INSERT INTO teams VALUES ('t1', 'Alpha');
        INSERT INTO compute.source (name) VALUES ('games'), ('teams');
        CREATE TRIGGER compute_source_games_truncate AFTER TRUNCATE ON games
          FOR EACH STATEMENT EXECUTE FUNCTION compute.touch_source('games', 'true');
        CREATE TRIGGER compute_source_games_insert AFTER INSERT ON games
          REFERENCING NEW TABLE AS affected
          FOR EACH STATEMENT EXECUTE FUNCTION compute.touch_source_rows('games', 'true');
        CREATE TRIGGER compute_source_games_update AFTER UPDATE ON games
          REFERENCING OLD TABLE AS old_affected NEW TABLE AS affected
          FOR EACH STATEMENT EXECUTE FUNCTION compute.touch_source_rows('games', 'true');
        CREATE TRIGGER compute_source_games_delete AFTER DELETE ON games
          REFERENCING OLD TABLE AS affected
          FOR EACH STATEMENT EXECUTE FUNCTION compute.touch_source_rows('games', 'true');
      `);

			const config = options(directory);
			config.databaseUrl = server.url;
			config.reads = ["games", "teams"];
			config.queries = {
				items:
					"SELECT t.id AS id, (SELECT coalesce(sum(goals), 0)::INTEGER FROM games) AS value FROM teams t ORDER BY t.id",
			};
			const runtime = await BoundedRuntime.create(config);

			const readWatermarks = async () => {
				const db = await DuckDBInstance.create(`${directory}/replica.duckdb`, {
					access_mode: "READ_ONLY",
				});
				const conn = await db.connect();
				try {
					const rows = await conn.runAndReadAll(
						"SELECT table_name, seeded_count::INTEGER AS seeded, incremental_count::INTEGER AS incremental FROM duckstream_replica.watermarks ORDER BY table_name",
					);
					return rows.getRowObjects();
				} finally {
					conn.closeSync();
					db.closeSync();
				}
			};

			const runCapture = async () => {
				const cap = await runtime.capture();
				const out = await runtime.calculate(cap);
				const rows = [];
				for await (const page of runtime.pages(out, "sink")) rows.push(...page);
				await runtime.release(cap, out);
				return rows;
			};

			assertEquals(await runCapture(), [{ id: "t1", value: 5 }]);
			assertEquals(await readWatermarks(), [
				{ table_name: "games", seeded: 1, incremental: 0 },
				{ table_name: "teams", seeded: 1, incremental: 0 },
			]);

			await admin.query(`
        INSERT INTO games VALUES ('g3', 4);
        UPDATE games SET id = 'g2_renamed', goals = 10 WHERE id = 'g2';
        DELETE FROM games WHERE id = 'g1';
      `);
			assertEquals(await runCapture(), [{ id: "t1", value: 14 }]);
			assertEquals(await readWatermarks(), [
				{ table_name: "games", seeded: 1, incremental: 1 },
				{ table_name: "teams", seeded: 1, incremental: 0 },
			]);

			await admin.query("TRUNCATE games; INSERT INTO games VALUES ('g4', 7)");
			assertEquals(await runCapture(), [{ id: "t1", value: 7 }]);
			assertEquals(await readWatermarks(), [
				{ table_name: "games", seeded: 1, incremental: 2 },
				{ table_name: "teams", seeded: 1, incremental: 0 },
			]);

			// Clearing compute.wal forces a clean reseed on the next capture instead of reading a broken WAL chain.
			await admin.query(`
        DELETE FROM compute.wal WHERE table_name = 'games';
        UPDATE games SET goals = 11 WHERE id = 'g4';
      `);
			assertEquals(await runCapture(), [{ id: "t1", value: 11 }]);
			assertEquals(await readWatermarks(), [
				{ table_name: "games", seeded: 2, incremental: 2 },
				{ table_name: "teams", seeded: 1, incremental: 0 },
			]);

			await admin.query(`
        CREATE SCHEMA duckpipe;
        CREATE TABLE duckpipe.table_mappings (
          source_schema text NOT NULL,
          source_table text NOT NULL,
          target_table text NOT NULL,
          state text NOT NULL,
          applied_lsn pg_lsn NOT NULL
        );
        CREATE TABLE games_ducklake AS SELECT * FROM games;
        CREATE TABLE teams_ducklake AS SELECT * FROM teams;
        INSERT INTO games VALUES ('g5', 8);
        INSERT INTO games_ducklake VALUES ('g5', 8);
        INSERT INTO duckpipe.table_mappings
        SELECT 'public', name, name || '_ducklake', 'SNAPSHOT', '0/0'::pg_lsn FROM compute.source;
      `);
			await assertRejects(
				() =>
					BoundedRuntime.syncReplica(
						directory,
						server.url,
						["games", "teams"],
						2,
					),
				Error,
				"duckpipe replica did not reach target LSN fence",
			);
			const fenced = runCapture();
			await new Promise((r) => setTimeout(r, 80));
			await admin.query(`
        UPDATE duckpipe.table_mappings
        SET state = 'STREAMING', applied_lsn = pg_current_wal_insert_lsn()
      `);
			assertEquals(await fenced, [{ id: "t1", value: 19 }]);
		} finally {
			await admin.end();
			await Deno.remove(directory, { recursive: true });
		}
	},
);
