import pg from "npm:pg@8.16.3";
import { getWork, openWork, settleWork } from "../durex/work.ts";
import { strictJson } from "./workers.ts";

export type BatchSpec = {
	name: string;
	reads: string[];
	to: string[];
	version: string;
	initialize?(client: pg.PoolClient): Promise<void>;
	capture(client: pg.PoolClient): Promise<unknown>;
	captured?(inputs: unknown): Promise<void>;
	supersedeOnForeignKey?: boolean;
	calculate(inputs: unknown): Promise<unknown>;
	publish(client: pg.PoolClient, output: unknown): Promise<void>;
};
export type Batches = {
	invalidate(tables?: string[]): Promise<void>;
	invalidateNames(names: string[]): Promise<void>;
	close(): Promise<void>;
	promise: Promise<void>;
};
const TASK = "compute_batch";
const LOCK = "7267885012713041";
const TRANSACTION_ATTEMPTS = 25;
const READ_COMMITTED_MACHINE_HASH = "dd7b02748a65c9c6fe5e56e4220b85e317e2fe56347eac3c725a2ea775079b53";
const HYBRID_SERIALIZABLE_MACHINE_HASH = "57057ef2d61cf7f7615f134b81822ae725a9b688ccd3bb7c6978ce3b568844e3";
const MECHA_MACHINE_HASH = "a71706b579d917082c9384ff022500ee5b36994bffd336895834f414df2f7154";

export function computationGraph(
	specs: readonly Pick<BatchSpec, "name" | "reads" | "to">[],
) {
	if (new Set(specs.map((spec) => spec.name)).size !== specs.length) {
		throw new Error("duplicate computation name");
	}
	const parents = new Map(
		specs.map((s) => [
			s.name,
			specs.filter((p) => p.to.some((t) => s.reads.includes(t))).map((p) =>
				p.name
			),
		]),
	);
	const ordered = new Set<string>();
	function visit(name: string, path: string[]) {
		if (path.includes(name)) {
			throw new Error(`computation cycle: ${[...path, name].join(" -> ")}`);
		}
		if (ordered.has(name)) return;
		for (const parent of parents.get(name)!) visit(parent, [...path, name]);
		ordered.add(name);
	}
	for (const spec of specs) visit(spec.name, []);
	return { parents, ordered };
}

export async function openBatches(
	connectionString: string,
	specs: BatchSpec[],
	options: {
		maxAttempts?: number;
		pollInterval?: number;
		coalesceMs?: number;
	} = {},
): Promise<Batches> {
	const attempts = options.maxAttempts ?? 25;
	const coalesce = options.coalesceMs ?? 1000;
	if (!Number.isSafeInteger(attempts) || attempts < 1) {
		throw new Error("maxAttempts must be a positive integer");
	}
	if (!Number.isSafeInteger(coalesce) || coalesce < 0) {
		throw new Error("coalesceMs must be a nonnegative integer");
	}
	if (specs.length > 1024) {
		throw new Error("too many computations for the bounded coordinator");
	}
	const byName = new Map(specs.map((s) => [s.name, s]));
	const { parents, ordered } = computationGraph(specs);
	async function transaction<T>(
		db: pg.Pool,
		body: (client: pg.PoolClient) => Promise<T>,
	): Promise<T> {
		const client = await db.connect();
		try {
			for (let attempt = 0;; attempt++) {
				await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
				try {
					await client.query("SELECT compute.lock_batches()");
					const value = await body(client);
					await client.query("COMMIT");
					return value;
				} catch (error) {
					await client.query("ROLLBACK");
					if (
						!(error instanceof pg.DatabaseError) ||
						!["40001", "40P01"].includes(error.code ?? "") ||
						attempt >= TRANSACTION_ATTEMPTS - 1
					) throw error;
				}
			}
		} finally {
			client.release();
		}
	}
	const worker = await openWork(connectionString, {
		name: "compute",
		lock: LOCK,
		taskName: TASK,
		pollInterval: options.pollInterval,
		async bootstrap(db) {
			const client = await db.connect();
			try {
				// The singleton owns bootstrap; source baselines need snapshots after their write fences.
				await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
				await client.query(
					"CREATE SCHEMA IF NOT EXISTS compute; REVOKE ALL ON SCHEMA compute FROM PUBLIC",
				);
				const { rows: [old] } = await client.query(
					"SELECT relkind FROM pg_class WHERE oid=to_regclass('compute.batch')",
				);
				if (old?.relkind === "r") {
					const { rows: [pending] } = await client.query(
						"SELECT EXISTS(SELECT FROM compute.batch WHERE requested<>completed) AS pending",
					);
					if (pending.pending) {
						throw new Error(
							"drain the previous compute coordinator before migrating its unfinished work",
						);
					}
					await client.query(
						"ALTER TABLE compute.batch RENAME TO previous_batch",
					);
				}
				const machineSql = await Deno.readTextFile(
					new URL("./batch-machine.sql", import.meta.url),
				);
				const machineHash = Array.from(
					new Uint8Array(
						await crypto.subtle.digest(
							"SHA-256",
							new TextEncoder().encode(machineSql),
						),
					),
				)
					.map((byte) => byte.toString(16).padStart(2, "0")).join("");
				await client.query(
					"CREATE TABLE IF NOT EXISTS compute.machine_version (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), fingerprint text NOT NULL)",
				);
				const { rows: [recorded] } = await client.query(
					"SELECT fingerprint FROM compute.machine_version",
				);
				if (recorded && recorded.fingerprint !== machineHash) {
					if (![READ_COMMITTED_MACHINE_HASH, HYBRID_SERIALIZABLE_MACHINE_HASH].includes(recorded.fingerprint) || machineHash !== MECHA_MACHINE_HASH) {
						throw new Error("compute Cortex machine requires an explicit schema upgrade");
					}
					await client.query(machineSql);
					await client.query("UPDATE compute.machine_version SET fingerprint = $1", [machineHash]);
				}
				const { rows: [installed] } = await client.query(
					"SELECT to_regnamespace('hybrid_compute_batch') AS schema",
				);
				if (!installed.schema) await client.query(machineSql);
				else if (!recorded) {
					throw new Error("compute Cortex schema has no compiler fingerprint");
				}
				await client.query(
					"INSERT INTO compute.machine_version(fingerprint) VALUES ($1) ON CONFLICT(singleton) DO NOTHING",
					[machineHash],
				);
				await client.query(
					await Deno.readTextFile(new URL("./batches.sql", import.meta.url)),
				);
				const { rows: previous } = await client.query(
					"SELECT * FROM compute.batch",
				);
				for (const state of previous) {
					if (
						state.requested !== state.completed &&
						byName.get(state.name)?.version !== state.version
					) {
						throw new Error(
							`unfinished computation ${state.name} has incompatible program version ${state.version}`,
						);
					}
				}
				await client.query("UPDATE compute.definition SET enabled=false");
				let ordinal = 0;
				for (const name of ordered) {
					const spec = byName.get(name)!;
					const { rows: [exists] } = await client.query(
						"SELECT instance_id FROM compute.definition WHERE name=$1",
						[name],
					);
					const id = exists?.instance_id ?? crypto.randomUUID();
					if (!exists) {
						let revision = 0;
						if (old?.relkind === "r") {
							const { rows: [prior] } = await client.query(
								"SELECT completed FROM compute.previous_batch WHERE name=$1",
								[name],
							);
							revision = Number(prior?.completed ?? 0);
						}
						const input = { name, coalesce, attempts, revision };
						await client.query(
							`INSERT INTO hybrid_compute_batch.instance(id,version,state)
              SELECT $1,1,hybrid_compute_batch.step($2::jsonb)->'state'`,
							[
								id,
								JSON.stringify({
									initialize: true,
									payload: input,
									context: { tier: "mecha", actor: null, now: 0 },
									viewers: [],
								}),
							],
						);
						await client.query(
							"INSERT INTO compute.capture(instance_id) VALUES ($1)",
							[id],
						);
					}
					await client.query(
						`INSERT INTO compute.definition(name,instance_id,version,reads,parents,ordinal) VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT(name) DO UPDATE SET version=EXCLUDED.version,reads=EXCLUDED.reads,parents=EXCLUDED.parents,ordinal=EXCLUDED.ordinal,enabled=true`,
						[name, id, spec.version, spec.reads, parents.get(name), ordinal++],
					);
					await spec.initialize?.(client);
				}
				if (old?.relkind === "r") {
					const { rows: pools } = await client.query(
						"SELECT id FROM compute.pool",
					);
					for (const pool of pools) {
						await client.query(
							"SELECT graphile_worker.force_unlock_workers(ARRAY[$1])",
							[pool.id],
						);
					}
					await client.query(
						`SELECT graphile_worker.complete_jobs(array_agg(j.id)) FROM graphile_worker._private_jobs j
            JOIN graphile_worker._private_tasks t ON t.id=j.task_id WHERE t.identifier='compute_batch'`,
					);
					await client.query("DROP TABLE compute.pool,compute.previous_batch");
				}
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			} finally {
				client.release();
			}
			await transaction(db, (client) => client.query("SELECT compute.schedule()"));
		},
		async task(payload, db) {
			const { key } = payload as { key: string };
			const claim = await transaction(db, async (client) => {
				const work = await getWork(client, key);
				if (work.outcome !== null) return;
				const { name } = work.input as { name: string };
				const spec = byName.get(name);
				if (!spec) throw new Error(`unknown computation ${name}`);
				const { rows: [state] } = await client.query(
					"SELECT * FROM compute.batch WHERE name=$1",
					[name],
				);
				if (state.version !== spec.version) {
					throw new Error(`incompatible computation ${name}`);
				}
				if (state.claimed === null) {
					const inputs = strictJson(await spec.capture(client));
					await client.query(
						'SELECT hybrid_compute_batch.deliver($1,\'{"kind":"claim","payload":{}}\'::jsonb)',
						[work.instance],
					);
					const { rows: [stored] } = await client.query(
						"UPDATE compute.capture SET inputs=$2::jsonb WHERE instance_id=$1 RETURNING inputs",
						[work.instance, inputs],
					);
					return { spec, work, inputs: stored.inputs };
				}
				return { spec, work, inputs: state.inputs };
			});
			if (!claim) return;
			await claim.spec.captured?.(claim.inputs);
			const output = await claim.spec.calculate(claim.inputs);
			try {
				await transaction(db, async (client) => {
					await claim.spec.publish(client, output);
					await settleWork(client, key, "done", {});
					await client.query(
						"UPDATE compute.capture SET inputs=NULL WHERE instance_id=$1",
						[claim.work.instance],
					);
					await client.query("SELECT compute.after_work($1,true)", [
						claim.spec.name,
					]);
				});
			} catch (error) {
				if (
					claim.spec.supersedeOnForeignKey === false ||
					!(error instanceof pg.DatabaseError) || error.code !== "23503"
				) {
					throw error;
				}
				const superseded = await transaction(db, async (client) => {
					const { rows: [state] } = await client.query(
						"SELECT * FROM compute.batch WHERE name=$1",
						[claim.spec.name],
					);
					if (BigInt(state.requested) <= BigInt(state.claimed)) return false;
					await client.query(
						`UPDATE compute.capture SET inputs=NULL,
            last_superseded=jsonb_build_object('revision',$2::text,'reason','foreign_key_violation','constraint',$3::text,'at',clock_timestamp())
            WHERE instance_id=$1`,
						[claim.work.instance, state.claimed, error.constraint],
					);
					await settleWork(client, key, "failed", {});
					await client.query("SELECT compute.after_work($1,false)", [
						claim.spec.name,
					]);
					return true;
				});
				if (!superseded) throw error;
			}
		},
	});
	return {
		promise: worker.promise,
		close: worker.close,
		async invalidateNames(names) {
			for (const name of names) {
				if (!byName.has(name)) throw new Error(`unknown computation ${name}`);
			}
			await transaction(worker.db, async (client) => {
				await client.query("SELECT compute.mark($1::text[])", [names]);
				await client.query("SELECT compute.schedule()");
			});
		},
		async invalidate(tables) {
			await transaction(worker.db, async (client) => {
				await client.query("SELECT compute.invalidate($1::text[])", [
					tables ?? null,
				]);
			});
		},
	};
}
