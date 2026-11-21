import pg from "npm:pg@8.16.3";
import type { Batches } from "./batches.ts";
import type { NativeRuntime } from "./native-runtime.ts";

type Runtime = Pick<NativeRuntime, "spec" | "pending" | "check" | "onReady"> & {
	engine: Pick<NativeRuntime["engine"], "subscribe">;
};

export async function openNativeReadiness(
	connectionString: string,
	db: pg.Pool,
	runtimes: readonly Runtime[],
	coordinator: Pick<Batches, "invalidateNames">,
) {
	if (!runtimes.length) {
		return {
			promise: new Promise<void>(() => {}),
			close: () => Promise.resolve(),
		};
	}
	const abort = new AbortController();
	const failed = Promise.withResolvers<Error>();
	const listener = new pg.Client({ connectionString, keepAlive: true, keepAliveInitialDelayMillis: 10_000 });
	const byName = new Map(
		runtimes.map((runtime) => [runtime.spec.name, runtime]),
	);
	const dirty = new Set<string>();
	let pulse = Promise.withResolvers<void>();
	function wake(name: string) {
		if (abort.signal.aborted || !byName.has(name)) return;
		dirty.add(name);
		pulse.resolve();
	}
	listener.on("error", failed.resolve);
	listener.on("end", () => {
		if (!abort.signal.aborted) {
			failed.resolve(new Error("native readiness listener ended"));
		}
	});
	listener.on("notification", ({ channel, payload }) => {
		if (channel === "compute_native_ready" && payload) wake(payload);
	});
	try {
		await listener.connect();
		// LISTEN commits before reconciliation so a repair cannot fall into a scan/listen gap.
		await listener.query("LISTEN compute_native_ready");
	} catch (error) {
		abort.abort();
		try {
			await listener.end();
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "native readiness initialization and cleanup failed", { cause: error });
		}
		throw error;
	}
	const subscriptions = runtimes.map((runtime) => {
		runtime.onReady = () => wake(runtime.spec.name);
		wake(runtime.spec.name);
		return runtime.engine.subscribe(abort.signal, runtime.onReady);
	});
	const run = (async () => {
		while (!abort.signal.aborted) {
			await pulse.promise;
			pulse = Promise.withResolvers<void>();
			const names = [...dirty];
			dirty.clear();
			for (const name of names) {
				if (abort.signal.aborted) return;
				const runtime = byName.get(name)!;
				const { rows } = await db.query(
					"SELECT 1 FROM compute.batch WHERE name=$1 AND requested > coalesce(claimed, completed) AND wake IS NOT NULL",
					[name],
				);
				if (rows.length) await runtime.check();
				else if (await runtime.pending()) {
					await coordinator.invalidateNames([name]);
				}
			}
		}
	})();
	const promise = Promise.race([
		run,
		failed.promise.then((error) => {
			throw error;
		}),
		...subscriptions,
	]);
	return {
		promise,
		async close() {
			abort.abort();
			pulse.resolve();
			for (const runtime of runtimes) runtime.onReady = undefined;
			const closed = await Promise.allSettled([
				listener.end(),
				run,
				...subscriptions,
			]);
			const errors = closed.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : []
			);
			if (errors.length) {
				throw new AggregateError(errors, "native readiness shutdown failed");
			}
		},
	};
}
