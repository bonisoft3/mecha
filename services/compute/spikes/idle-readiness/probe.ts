import pg from "npm:pg@8.16.3";
import { NativeRisingWave } from "../../native-risingwave.ts";
import {
	type IncrementalProgram,
	installSources,
	sourceSchema,
} from "../../native-sources.ts";
import { defaultRisingWaveConnect } from "../../risingwave.ts";
import { dropOwnedSlots, retirePipeline } from "../../native-cleanup.ts";

const uri = Deno.env.get("DATABASE_URL");
if (!uri) throw new Error("DATABASE_URL is required");
const endpoint = Deno.env.get("RISINGWAVE_URL");
if (!endpoint) throw new Error("RISINGWAVE_URL is required");
const name = "idle-readiness-probe";
const table = "rw_idle_probe_items";
const version = crypto.randomUUID().replaceAll("-", "").repeat(2);
const program: IncrementalProgram = {
	sql:
		"CREATE TABLE source_rows (group_id VARCHAR, amount INTEGER); CREATE VIEW totals AS SELECT group_id,SUM(amount) AS amount FROM source_rows GROUP BY group_id;",
	inputs: {
		source_rows: {
			query: "SELECT group_id,amount FROM source_rows",
			fields: [{ name: "group_id", type: "VARCHAR" }, {
				name: "amount",
				type: "INTEGER",
			}],
		},
	},
	outputs: {
		totals: {
			view: "totals",
			fields: [{ name: "group_id", type: "VARCHAR" }, {
				name: "amount",
				type: "BIGINT",
			}],
		},
	},
	incremental: {
		inputs: { source_rows: { table, projection: "group_id,amount" } },
		outputs: {
			totals: {
				partitionQuery:
					"SELECT group_id AS __partition,group_id,amount FROM totals",
			},
		},
	},
};
const db = new pg.Pool({ connectionString: uri });
let flushes = 0;
const connect: typeof defaultRisingWaveConnect = async (url) => {
	const session = await defaultRisingWaveConnect(url);
	return {
		query(sql, values) {
			if (sql === "FLUSH") flushes++;
			return session.query(sql, values);
		},
		end: () => session.end(),
	};
};
const engine = new NativeRisingWave(
	endpoint,
	name,
	program,
	version,
	uri,
	connect,
);
function equal(actual: unknown, expected: unknown) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`unexpected delta: ${JSON.stringify(actual)}`);
	}
}
let created = false;
try {
	await db.query(
		`CREATE TABLE public.${table}(id text PRIMARY KEY,group_id text NOT NULL,amount integer NOT NULL)`,
	);
	created = true;
	await db.query(
		`INSERT INTO public.${table} VALUES('one','a',2),('two','a',3)`,
	);
	const client = await db.connect();
	try {
		await client.query("BEGIN");
		await installSources(client, program, version, name);
		await client.query("COMMIT");
	} finally {
		client.release();
	}
	await engine.initialize(db, { totals: [] }, []);
	const initial = await engine.capture();
	equal(initial.totals, [{
		row: { __partition: "a", group_id: "a", amount: 5 },
		weight: 1,
	}]);
	const beforeInitialAck = flushes;
	await engine.acknowledge("initial", initial);
	equal(flushes, beforeInitialAck + 1);
	const beforeIdle = flushes;
	for (let i = 0; i < 5; i++) equal(await engine.pending(), false);
	equal(flushes, beforeIdle);
	await db.query(`UPDATE public.${table} SET amount=11 WHERE id='one'`);
	const start = performance.now();
	let polls = 0;
	while (!await engine.pending()) {
		polls++;
		if (performance.now() - start > 30000) {
			throw new Error("CDC readiness did not advance");
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	equal(flushes, beforeIdle);
	const readinessMs = Math.round(performance.now() - start);
	const changed = await engine.capture();
	equal(changed.totals.toSorted((a, b) => a.weight - b.weight), [{
		row: { __partition: "a", group_id: "a", amount: 5 },
		weight: -1,
	}, { row: { __partition: "a", group_id: "a", amount: 14 }, weight: 1 }]);
	equal(flushes, beforeIdle + 1);
	await engine.acknowledge("updated", changed);
	equal(flushes, beforeIdle + 2);
	equal(await engine.pending(), false);
	await engine.acknowledge("updated", changed);
	equal(flushes, beforeIdle + 2);
	equal(await engine.pending(), false);
	await retirePipeline(`${endpoint}/pipelines/${name}`);
	let refused = false;
	try {
		await engine.pending();
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!error.message.includes("table or source not found: __pending")
		) throw error;
		refused = true;
	}
	equal(refused, true);
	console.log(JSON.stringify({
		idlePolls: 5,
		idleFlushes: 0,
		cdcReadinessMs: readinessMs,
		polls,
		updateRetracted: 5,
		updateInserted: 14,
		captureFlushes: 1,
		acknowledgmentFlushes: 2,
		duplicateAcknowledgment: "no duplicate delta",
		missingPipeline: "rejected",
	}));
} finally {
	await engine.close();
	if (created) {
		await retirePipeline(`${endpoint}/pipelines/${name}`);
		const client = await db.connect();
		try {
			const { rows } = await client.query(
				"SELECT slots,publications FROM compute.native_epoch WHERE name=$1",
				[name],
			);
			for (const row of rows) {
				await dropOwnedSlots(client, row.slots);
				for (const pub of row.publications) {
					if (!/^duckstream_[a-f0-9]+_pub$/.test(pub)) {
						throw new Error("unexpected probe publication");
					}
					await client.query(`DROP PUBLICATION IF EXISTS "${pub}"`);
				}
			}
			await client.query(
				`DROP SCHEMA IF EXISTS "${sourceSchema(version)}" CASCADE`,
			);
			await client.query("DELETE FROM compute.native_epoch WHERE name=$1", [
				name,
			]);
			await client.query("DELETE FROM compute.native_sources WHERE name=$1", [
				name,
			]);
			await client.query(`DROP TABLE public.${table}`);
		} finally {
			client.release();
		}
	}
	await db.end();
}
