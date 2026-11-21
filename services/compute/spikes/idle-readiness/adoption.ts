import pg from "npm:pg@8.16.3";
import { type Batches, openBatches } from "../../batches.ts";
import { NativeRisingWave } from "../../native-risingwave.ts";
import { NativeRuntime } from "../../native-runtime.ts";
import { openNativeReadiness } from "../../native-readiness.ts";
import {
	dropOwnedSlots,
	pipelineSchemaName,
	retirePipeline,
} from "../../native-cleanup.ts";
import { defaultRisingWaveConnect } from "../../risingwave.ts";
import type { IncrementalProgram } from "../../native-sources.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const endpoint = Deno.env.get("RISINGWAVE_URL");
if (!databaseUrl || !endpoint) {
	throw new Error("DATABASE_URL and RISINGWAVE_URL are required");
}
const database = `subscription_probe_${
	crypto.randomUUID().replaceAll("-", "")
}`;
const uri = new URL(databaseUrl);
uri.pathname = `/${database}`;
const admin = new pg.Pool({ connectionString: databaseUrl });
await admin.query(`CREATE DATABASE ${database}`);
const db = new pg.Pool({ connectionString: uri.href });
const control = await defaultRisingWaveConnect(endpoint);
const program: IncrementalProgram = JSON.parse(
	await Deno.readTextFile(
		new URL("../../fixtures/native-integration.json", import.meta.url),
	),
);
const name = "subscription-adoption-probe";
const version = crypto.randomUUID().replaceAll("-", "").repeat(2);
let runtime: NativeRuntime | undefined;
let empty: NativeRisingWave | undefined;
let batches: Batches | undefined;
let readiness: Awaited<ReturnType<typeof openNativeReadiness>> | undefined;
let calculations = 0;
const report: Record<string, unknown> = {};
function equal(actual: unknown, expected: unknown) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`expected ${JSON.stringify(expected)}, received ${
				JSON.stringify(actual)
			}`,
		);
	}
}
async function until(check: () => Promise<boolean>) {
	const deadline = Date.now() + 60000;
	while (!await check()) {
		if (Date.now() > deadline) {
			throw new Error("adoption canary did not settle");
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
async function value(amount: number) {
	await Promise.race([
		readiness!.promise,
		batches!.promise,
		until(async () =>
			(await db.query("SELECT amount FROM sink WHERE id='a'")).rows[0]
				?.amount === amount
		),
	]);
}
async function start() {
	runtime = new NativeRuntime(
		db,
		endpoint!,
		{
			name,
			to: ["sink"],
			calculate(input: unknown) {
				calculations++;
				return Promise.resolve({
					sink: (input as { totals: { group_id: string; amount: number }[] })
						.totals.map((row) => ({
							id: row.group_id,
							amount: row.amount * 2,
						})),
				});
			},
		},
		program,
		version,
		uri.href,
		{ role: "service" },
	);
	batches = await openBatches(uri.href, [runtime.spec], {
		invalidateOnStart: false,
		coalesceMs: 0,
		pollInterval: 20,
		afterBootstrap: () => runtime!.initialize(),
	});
	readiness = await openNativeReadiness(uri.href, db, [runtime], batches);
}
async function stop() {
	await readiness!.close();
	readiness = undefined;
	await batches!.close();
	batches = undefined;
	await runtime!.close();
}
try {
	await db.query(
		`CREATE FUNCTION public.app_pre_request() RETURNS void LANGUAGE plpgsql AS $$BEGIN END$$;
    CREATE TABLE items(id text PRIMARY KEY,group_id text NOT NULL,amount integer NOT NULL);
    INSERT INTO items VALUES ('one','a',2),('two','a',3);
    CREATE TABLE sink(id text PRIMARY KEY,amount integer NOT NULL);
    GRANT ALL ON sink TO service;`,
	);
	await start();
	await value(10);
	report.initialPublication = true;
	const slots =
		(await db.query("SELECT slots FROM compute.native_epoch WHERE name=$1", [
			name,
		])).rows[0].slots;
	await stop();
	await db.query("UPDATE items SET amount=11 WHERE id='one'");
	await start();
	await value(28);
	equal(
		(await db.query("SELECT slots FROM compute.native_epoch WHERE name=$1", [
			name,
		])).rows[0].slots,
		slots,
	);
	report.warmReconnectMissedUpdate = true;
	await db.query("UPDATE sink SET amount=999 WHERE id='a'");
	await value(28);
	report.postgresOnlyRepair = true;
	await until(async () =>
		(await db.query(
			"SELECT requested=completed AS done FROM compute.batch WHERE name=$1",
			[name],
		)).rows[0].done
	);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let hold = true;
	const acknowledge = runtime!.engine.acknowledge.bind(runtime!.engine);
	runtime!.engine.acknowledge = async (id, delta) => {
		if (hold) {
			hold = false;
			entered.resolve();
			await release.promise;
		}
		await acknowledge(id, delta);
	};
	try {
		await db.query("UPDATE items SET amount=20 WHERE id='one'");
		await Promise.race([
			entered.promise,
			readiness!.promise,
			until(() => Promise.resolve(!hold)),
		]);
		await db.query("UPDATE items SET amount=30 WHERE id='one'");
		await control.query(`SET search_path TO "${pipelineSchemaName(name)}"`);
		await until(async () =>
			(await control.query(
				`SELECT amount FROM "${
					pipelineSchemaName(name)
				}".stream_totals WHERE group_id='a'`,
			)).rows[0]?.amount === 33
		);
		equal(await runtime!.pending(), false);
	} finally {
		release.resolve();
	}
	await value(66);
	await until(async () =>
		(await db.query(
			"SELECT requested=completed AS done FROM compute.batch WHERE name=$1",
			[name],
		)).rows[0].done
	);
	equal(await runtime!.pending(), false);
	report.updateWhileCaptureBusy = true;
	await stop();
	await control.query(
		`DROP SUBSCRIPTION "${pipelineSchemaName(name)}".__readiness`,
	);
	const { rows: [state] } = await db.query(
		"SELECT last_capture_id FROM compute.stream_state WHERE name=$1",
		[name],
	);
	equal(await runtime!.engine.tryAttach(db, state.last_capture_id), false);
	await start();
	await value(66);
	await until(async () => !await runtime!.pending());
	report.missingSubscriptionReconstructed = true;
	report.calculations = calculations;
	await stop();
	empty = new NativeRisingWave(
		endpoint,
		`${name}-empty`,
		{
			sql: "",
			inputs: {},
			outputs: {},
			incremental: { inputs: {}, outputs: {} },
		},
		crypto.randomUUID().replaceAll("-", "").repeat(2),
		uri.href,
	);
	await empty.initialize(db, {}, []);
	await control.query(
		`DECLARE empty_probe SUBSCRIPTION CURSOR FOR "${
			pipelineSchemaName(`${name}-empty`)
		}".__readiness FULL`,
	);
	const { rows: emptySnapshot } = await control.query(
		"FETCH 1 FROM empty_probe WITH (timeout = '10s')",
	);
	equal(emptySnapshot.length, 1);
	equal(Number(emptySnapshot[0].n), 0);
	await control.query("CLOSE empty_probe");
	report.zeroOutputSubscription = true;
	console.log(JSON.stringify(report));
} finally {
	const closed = await Promise.allSettled([readiness?.close()]);
	closed.push(...await Promise.allSettled([batches?.close()]));
	closed.push(
		...await Promise.allSettled([
			runtime?.close(),
			empty?.close(),
			control.end(),
		]),
	);
	await retirePipeline(`${endpoint}/pipelines/${name}-empty`);
	await retirePipeline(`${endpoint}/pipelines/${name}`);
	const client = await db.connect();
	try {
		const { rows: [registry] } = await client.query(
			"SELECT to_regclass('compute.native_epoch') AS present",
		);
		if (registry.present) {
			for (
				const row of (await client.query(
					"SELECT slots FROM compute.native_epoch WHERE name=$1",
					[name],
				)).rows
			) await dropOwnedSlots(client, row.slots);
		}
	} finally {
		client.release();
	}
	await db.end();
	await admin.query(`DROP DATABASE ${database}`);
	await admin.end();
	const errors = closed.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : []
	);
	if (errors.length) {
		// deno-lint-ignore no-unsafe-finally
		throw new AggregateError(errors, "adoption canary cleanup failed");
	}
}
