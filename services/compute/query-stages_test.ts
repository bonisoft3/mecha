import { assertEquals, assertThrows } from "@std/assert";
import { validateQueryStages } from "./query-stages.ts";
import { admit } from "./workers.ts";

Deno.test("optional query stages are admitted without changing legacy SQL or numerical exports", async () => {
	const file = await Deno.makeTempFile({ suffix: ".js" });
	const queryStages = {
		q: {
			sql: "SELECT * FROM __duckstream_q_0",
			stages: [{ name: "__duckstream_q_0", sql: "SELECT 1 AS value" }],
		},
	};
	try {
		await Deno.writeTextFile(
			file,
			`export const reads=[]; export const queries={q:'SELECT 1 AS value'}; export const queryStages=${
				JSON.stringify(queryStages)
			}; export const plan=()=>[]; export const finish=()=>({});`,
		);
		const result = await admit(file, []);
		assertEquals(result.queries, { q: "SELECT 1 AS value" });
		assertEquals(result.queryStages, queryStages);
	} finally {
		await Deno.remove(file);
	}
});

Deno.test("physical query plans reject ambiguous or protected intermediate names and stateful SQL", () => {
	const queries = { q: "SELECT 1", r: "SELECT 2" };
	const stage = { name: "__duckstream_q_0", sql: "SELECT 1 AS value" };
	assertThrows(() =>
		validateQueryStages({ missing: { sql: "SELECT 1", stages: [] } }, queries)
	);
	assertThrows(() =>
		validateQueryStages(
			{ q: { sql: "SELECT 1", stages: [stage, stage] } },
			queries,
		)
	);
	assertThrows(() =>
		validateQueryStages({
			q: { sql: "SELECT 1", stages: [stage] },
			r: { sql: "SELECT 2", stages: [stage] },
		}, queries)
	);
	assertThrows(() =>
		validateQueryStages({
			q: {
				sql: "SELECT 1",
				stages: [{ ...stage, name: "duckdb_private.execution" }],
			},
		}, queries)
	);
	for (
		const sql of [
			"SELECT nextval/**/('duckdb_private.output_position')",
			`SELECT "nextval"('duckdb_private.output_position')`,
			`SELECT U&"n\\0065xtval"('duckdb_private.output_position')`,
			"COMMIT",
		]
	) {
		assertThrows(() =>
			validateQueryStages({
				q: { sql: "SELECT 1", stages: [{ ...stage, sql }] },
			}, queries)
		);
	}
	assertEquals(validateQueryStages(undefined, queries), undefined);
});
