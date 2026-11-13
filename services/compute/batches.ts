import pg from "npm:pg@8.16.3";
import { getWork, openWork, settleWork, type WorkDelivery } from "../durex/work.ts";
import { strictJson } from "./workers.ts";

export type BatchSpec = {
	name: string;
	reads: string[];
	to: string[];
	version: string;
	initialize?(client: pg.PoolClient): Promise<void>;
	hasCapture?(inputs: unknown): Promise<boolean>;
	capture(client: pg.PoolClient): Promise<unknown>;
	captured?(inputs: unknown): Promise<void>;
	supersedeOnForeignKey?: boolean;
	calculate(inputs: unknown): Promise<unknown>;
	stage?(
		client: pg.PoolClient,
		output: unknown,
	): Promise<{
		publish(client: pg.PoolClient): Promise<(() => void) | void>;
		close(): Promise<void>;
	}>;
	publish(client: pg.PoolClient, output: unknown): Promise<void>;
	release?(inputs: unknown, output: unknown): Promise<void>;
	discard?(output: unknown): Promise<void>;
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
// The machine whose rules took positional arguments, before a rule was
// XState's one argument.
const POSITIONAL_RULES_MACHINE_HASH = "a71706b579d917082c9384ff022500ee5b36994bffd336895834f414df2f7154";
const MECHA_MACHINE_HASH = "4561094321ad5f888b33b5ad92b495dd6e84a6857249f3a20e52f3cd549cd985";

function captureDigest(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const digest = (value as { digest?: unknown }).digest;
	return typeof digest === "string" && digest.length > 0 ? digest : null;
}

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
		invalidateOnStart?: boolean;
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
					if (![READ_COMMITTED_MACHINE_HASH, HYBRID_SERIALIZABLE_MACHINE_HASH, POSITIONAL_RULES_MACHINE_HASH].includes(recorded.fingerprint) || machineHash !== MECHA_MACHINE_HASH) {
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
					const next = byName.get(state.name);
					if (!next || next.version === state.version) continue;
					if (state.requested !== state.completed) {
						throw new Error(
							`unfinished computation ${state.name} has incompatible program version ${state.version}`,
						);
					}
					if (BigInt(state.completed) > 0n) {
						await client.query(
							`UPDATE compute.capture c
              SET completed_coverage=coalesce(c.completed_coverage,jsonb_build_object('version',$2::text))
              FROM compute.definition d WHERE d.name=$1 AND c.instance_id=d.instance_id`,
							[state.name, state.version],
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
						`INSERT INTO compute.definition(name,instance_id,version,reads,to_tables,parents,ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT(name) DO UPDATE SET version=EXCLUDED.version,reads=EXCLUDED.reads,to_tables=EXCLUDED.to_tables,parents=EXCLUDED.parents,ordinal=EXCLUDED.ordinal,enabled=true`,
						[name, id, spec.version, spec.reads, spec.to, parents.get(name), ordinal++],
					);
					await spec.initialize?.(client);
				}
				const readSet = new Set(specs.flatMap((s) => s.reads));
				const trackedNames = [
					...new Set(specs.flatMap((s) => [...s.reads, ...s.to])),
				].filter((t) => /^[a-z_][a-z0-9_]{0,62}$/.test(t)).sort();
				if (trackedNames.length) {
					const { rows: physical } = await client.query<{ name: string }>(
						`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
						[trackedNames],
					);
					if (physical.length) {
						const { rows: [{ duckpipe }] } = await client.query<{ duckpipe: boolean }>(
							"SELECT to_regnamespace('duckpipe') IS NOT NULL AS duckpipe",
						);
						await client.query(
							`LOCK TABLE ${
								physical.map(({ name }) => `public."${name}"`).join(",")
							} IN SHARE ROW EXCLUSIVE MODE`,
						);
						for (const { name } of physical) {
							const isRead = readSet.has(name);
							const args = isRead && !duckpipe ? `'${name}', 'true'` : `'${name}'`;
							await client.query(
								"INSERT INTO compute.source(name) VALUES ($1) ON CONFLICT(name) DO NOTHING",
								[name],
							);
							if (isRead && duckpipe) {
								await client.query(
									`SELECT duckpipe.add_table($1) WHERE NOT EXISTS (
                    SELECT FROM duckpipe.table_mappings WHERE source_schema='public' AND source_table=$2
                  )`,
									[`public.${name}`, name],
								);
							}
							await client.query(
								`DROP TRIGGER IF EXISTS compute_source_touch ON public."${name}";
                CREATE OR REPLACE TRIGGER compute_source_touch_insert
                AFTER INSERT ON public."${name}" REFERENCING NEW TABLE AS affected
                FOR EACH STATEMENT EXECUTE FUNCTION compute.touch_source_rows(${args});
                ALTER TABLE public."${name}" ENABLE ALWAYS TRIGGER compute_source_touch_insert;
                CREATE OR REPLACE TRIGGER compute_source_touch_delete
                AFTER DELETE ON public."${name}" REFERENCING OLD TABLE AS affected
                FOR EACH STATEMENT EXECUTE FUNCTION compute.touch_source_rows(${args});
                ALTER TABLE public."${name}" ENABLE ALWAYS TRIGGER compute_source_touch_delete;
                CREATE OR REPLACE TRIGGER compute_source_touch_truncate
                AFTER TRUNCATE ON public."${name}"
                FOR EACH STATEMENT EXECUTE FUNCTION compute.touch_source(${args});
                ALTER TABLE public."${name}" ENABLE ALWAYS TRIGGER compute_source_touch_truncate;
                ${
									isRead
										? `CREATE OR REPLACE TRIGGER compute_source_touch_update
                AFTER UPDATE ON public."${name}" REFERENCING OLD TABLE AS old_affected NEW TABLE AS affected
                FOR EACH STATEMENT EXECUTE FUNCTION compute.touch_source_rows(${args});
                ALTER TABLE public."${name}" ENABLE ALWAYS TRIGGER compute_source_touch_update;`
										: `DROP TRIGGER IF EXISTS compute_source_touch_update ON public."${name}";`
								}`,
							);
						}
					}
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
			await transaction(db, (client) => client.query(
				"SELECT compute.reconcile($1::boolean)",
				[Boolean(options.invalidateOnStart)],
			));
		},
		async task(payload, db) {
			const { key } = payload as { key: string };
			const finishClaim = async (
				client: pg.PoolClient,
				spec: BatchSpec,
				work: Awaited<ReturnType<typeof getWork>>,
				alreadyClaimed: boolean,
				beforeRequested: string,
				beforeCompleted: string,
				beforeCoverage: {
					input: Record<string, unknown> | null;
					sink: Record<string, unknown> | null;
					completed: Record<string, unknown> | null;
				} | undefined,
				afterRequested: string,
				afterCoverage: {
					input: Record<string, unknown> | null;
					sink: Record<string, unknown> | null;
					completed: Record<string, unknown> | null;
				} | undefined,
				inputs: string,
				digest: string | null,
			) => {
				if (!alreadyClaimed) {
					await client.query(
						'SELECT hybrid_compute_batch.deliver($1,\'{"kind":"claim","payload":{}}\'::jsonb)',
						[work.instance],
					);
				}
				if (
					BigInt(afterRequested) > BigInt(beforeRequested) ||
					strictJson(afterCoverage?.input ?? null, true) !==
						strictJson(beforeCoverage?.input ?? null, true)
				) {
					await client.query(
						'SELECT hybrid_compute_batch.deliver($1,\'{"kind":"invalidate","payload":{}}\'::jsonb)',
						[work.instance],
					);
				}
				const claimedCoverage = beforeCoverage?.input === null || beforeCoverage === undefined
					? null
					: digest === null
					? beforeCoverage.input
					: { ...beforeCoverage.input, digest };
				const { rows: [stored] } = await client.query(
					"UPDATE compute.capture SET inputs=$2::jsonb,claimed_coverage=$3::jsonb WHERE instance_id=$1 RETURNING inputs",
					[
						work.instance,
						inputs,
						claimedCoverage === null ? null : JSON.stringify(claimedCoverage),
					],
				);
				const unchanged = BigInt(beforeCompleted) > 0n &&
					digest !== null &&
					beforeCoverage?.completed !== null &&
					beforeCoverage?.input !== null &&
					afterCoverage?.sink !== null &&
					beforeCoverage !== undefined &&
					afterCoverage !== undefined &&
					beforeCoverage.completed.version === spec.version &&
					beforeCoverage.completed.digest === digest &&
					strictJson(beforeCoverage.completed.to ?? null, true) ===
						strictJson(afterCoverage.sink, true);
				return { spec, work, inputs: stored.inputs, unchanged };
			};
			const claim = await (async () => {
				const client = await db.connect();
				let deferred:
					| {
						spec: BatchSpec;
						work: Awaited<ReturnType<typeof getWork>>;
						alreadyClaimed: boolean;
						requested: string;
						completed: string;
						coverage: {
							input: Record<string, unknown> | null;
							sink: Record<string, unknown> | null;
							completed: Record<string, unknown> | null;
						} | undefined;
						captured: unknown;
						inputs: string;
						digest: string | null;
					}
					| undefined;
				try {
					for (let attempt = 0;; attempt++) {
						await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
						try {
							const { rows: [work] } = await client.query<WorkDelivery>(
								"SELECT * FROM durex.work WHERE key = $1",
								[key],
							);
							if (!work) throw new Error(`durex.work holds no ${key}`);
							if (work.outcome !== null) {
								await client.query("COMMIT");
								return;
							}
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
							if (state.claimed !== null) {
								if (!spec.hasCapture || await spec.hasCapture(state.inputs)) {
									await client.query("COMMIT");
									return { spec, work, inputs: state.inputs, unchanged: false };
								}
							}
							const { rows: [coverage] } = await client.query<{
								input: Record<string, unknown> | null;
								sink: Record<string, unknown> | null;
								completed: Record<string, unknown> | null;
							}>(
								`SELECT compute.input_coverage($2) AS input,
                        compute.sink_coverage($2) AS sink,
                        c.completed_coverage AS completed
                 FROM compute.capture c WHERE c.instance_id=$1`,
								[work.instance, name],
							);
							const captured = await spec.capture(client);
							const inputs = strictJson(captured);
							const digest = captureDigest(captured);
							const { rows: [{ wrote }] } = await client.query<{ wrote: boolean }>(
								"SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS wrote",
							);
							if (wrote) {
								await client.query("SELECT compute.lock_batches()");
								const lockedWork = await getWork(client, key);
								if (lockedWork.outcome !== null) {
									await client.query("COMMIT");
									return;
								}
								const result = await finishClaim(
									client,
									spec,
									lockedWork,
									state.claimed !== null,
									state.requested,
									state.completed,
									coverage,
									state.requested,
									coverage,
									inputs,
									digest,
								);
								await client.query("COMMIT");
								return result;
							}
							await client.query("COMMIT");
							deferred = {
								spec,
								work,
								alreadyClaimed: state.claimed !== null,
								requested: state.requested,
								completed: state.completed,
								coverage,
								captured,
								inputs,
								digest,
							};
							break;
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
				if (!deferred) return;
				let discardDeferred = false;
				const claimed = await transaction(db, async (claimClient) => {
					const work = await getWork(claimClient, key);
					if (work.outcome !== null) {
						discardDeferred = true;
						return;
					}
					const { rows: [afterState] } = await claimClient.query(
						"SELECT * FROM compute.batch WHERE name=$1",
						[deferred.spec.name],
					);
					if (afterState.version !== deferred.spec.version) {
						discardDeferred = true;
						throw new Error(`incompatible computation ${deferred.spec.name}`);
					}
					if (!deferred.alreadyClaimed && afterState.claimed !== null) {
						discardDeferred = true;
						return;
					}
					const { rows: [afterCoverage] } = await claimClient.query<{
						input: Record<string, unknown> | null;
						sink: Record<string, unknown> | null;
						completed: Record<string, unknown> | null;
					}>(
						`SELECT compute.input_coverage($2) AS input,
                    compute.sink_coverage($2) AS sink,
                    c.completed_coverage AS completed
             FROM compute.capture c WHERE c.instance_id=$1`,
						[work.instance, deferred.spec.name],
					);
					discardDeferred = false;
					return await finishClaim(
						claimClient,
						deferred.spec,
						work,
						deferred.alreadyClaimed,
						deferred.requested,
						deferred.completed,
						deferred.coverage,
						afterState.requested,
						afterCoverage,
						deferred.inputs,
						deferred.digest,
					);
				}).catch(async (error) => {
					if (
						deferred.captured && typeof deferred.captured === "object" &&
						deferred.spec.release
					) {
						await deferred.spec.release(deferred.captured, {
							...(deferred.captured as Record<string, unknown>),
							capture: deferred.captured,
						});
					}
					throw error;
				});
				if (
					discardDeferred && deferred.captured &&
					typeof deferred.captured === "object" && deferred.spec.release
				) {
					await deferred.spec.release(deferred.captured, {
						...(deferred.captured as Record<string, unknown>),
						capture: deferred.captured,
					});
				}
				return claimed;
			})();
			if (!claim) return;
			await claim.spec.captured?.(claim.inputs);
			if (claim.unchanged) {
				await transaction(db, async (client) => {
					await settleWork(client, key, "done", {});
					await client.query(
						`UPDATE compute.capture SET inputs=NULL,
            completed_coverage=CASE
              WHEN claimed_coverage IS NULL OR compute.sink_coverage($2) IS NULL THEN NULL
              ELSE claimed_coverage || jsonb_build_object('to',compute.sink_coverage($2))
            END,
            claimed_coverage=NULL
            WHERE instance_id=$1`,
						[claim.work.instance, claim.spec.name],
					);
					await client.query("SELECT compute.after_work($1,false)", [
						claim.spec.name,
					]);
				});
				await claim.spec.release?.(claim.inputs, {
					...(claim.inputs as Record<string, unknown>),
					capture: claim.inputs,
				});
				return;
			}
			const output = await claim.spec.calculate(claim.inputs);
			let settled = false;
			try {
				try {
					const settleClaim = async (client: pg.PoolClient) => {
						await settleWork(client, key, "done", {});
						await client.query(
							`UPDATE compute.capture SET inputs=NULL,
              completed_coverage=CASE
                WHEN claimed_coverage IS NULL OR compute.sink_coverage($2) IS NULL THEN NULL
                ELSE claimed_coverage || jsonb_build_object('to',compute.sink_coverage($2))
              END,
              claimed_coverage=NULL
              WHERE instance_id=$1`,
							[claim.work.instance, claim.spec.name],
						);
						await client.query("SELECT compute.after_work($1,true)", [
							claim.spec.name,
						]);
					};
					if (claim.spec.stage) {
						const client = await db.connect();
						let releaseError: Error | undefined;
						try {
							const staged = await claim.spec.stage(client, output);
							let publishError: unknown;
							try {
								for (let attempt = 0;; attempt++) {
									await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
									try {
										await client.query("SELECT compute.lock_batches()");
										const onCommit = await staged.publish(client);
										await settleClaim(client);
										await client.query("COMMIT");
										onCommit?.();
										break;
									} catch (error) {
										await client.query("ROLLBACK").catch((rollbackError) => {
											releaseError = rollbackError instanceof Error
												? rollbackError
												: new Error(String(rollbackError));
										});
										if (
											releaseError ||
											!(error instanceof pg.DatabaseError) ||
											!["40001", "40P01"].includes(error.code ?? "") ||
											attempt >= TRANSACTION_ATTEMPTS - 1
										) throw error;
									}
								}
							} catch (error) {
								publishError = error;
								throw error;
							} finally {
								try {
									await staged.close();
								} catch (closeError) {
									releaseError = closeError instanceof Error
										? closeError
										: new Error(String(closeError));
									if (publishError !== undefined) {
										// deno-lint-ignore no-unsafe-finally
										throw new AggregateError(
											[publishError, closeError],
											"staged publication and cleanup failed",
										);
									}
									// deno-lint-ignore no-unsafe-finally
									throw closeError;
								}
							}
						} finally {
							client.release(releaseError);
						}
					} else {
						await transaction(db, async (client) => {
							await claim.spec.publish(client, output);
							await settleClaim(client);
						});
					}
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
							`UPDATE compute.capture SET inputs=NULL,claimed_coverage=NULL,
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
				settled = true;
			} finally {
				if (!settled) await claim.spec.discard?.(output);
			}
			await claim.spec.release?.(claim.inputs, output);
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
