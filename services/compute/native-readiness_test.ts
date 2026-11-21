import { assertEquals, assertRejects } from "@std/assert";
import pg from "npm:pg@8.16.3";
import type { BatchSpec } from "./batches.ts";
import { openNativeReadiness } from "./native-readiness.ts";
import { pgTest, postgres } from "./pg-machine-test.ts";

async function fixture() {
	const server = await postgres();
	const db = new pg.Pool({ connectionString: server.url });
	await db.query(
		"CREATE SCHEMA compute; CREATE TABLE compute.batch(name text, requested int, claimed int, completed int, wake text); INSERT INTO compute.batch VALUES ('test',0,NULL,0,NULL)",
	);
	const checked = Promise.withResolvers<void>();
	const busyChecked = Promise.withResolvers<void>();
	let ready = false;
	let busy = false;
	let scheduled = 0;
	let error: Error | undefined;
	const disconnected = Promise.withResolvers<void>();
	const runtime = {
		spec: { name: "test" } as BatchSpec,
		onReady: undefined as (() => void) | undefined,
		check: () => Promise.resolve(),
		pending: () => {
			checked.resolve();
			if (busy) busyChecked.resolve();
			if (error) return Promise.reject(error);
			return Promise.resolve(ready && !busy);
		},
		engine: {
			subscribe: (signal: AbortSignal) => {
				signal.addEventListener("abort", () => disconnected.resolve(), {
					once: true,
				});
				return disconnected.promise;
			},
		},
	};
	const scheduledSignal = Promise.withResolvers<void>();
	const watcher = await openNativeReadiness(server.url, db, [runtime], {
		invalidateNames: () => {
			scheduled++;
			ready = false;
			scheduledSignal.resolve();
			return Promise.resolve();
		},
	});
	await checked.promise;
	return {
		db,
		runtime,
		watcher,
		scheduledSignal,
		busyChecked,
		scheduled: () => scheduled,
		busy: (value: boolean) => {
			busy = value;
		},
		ready: () => {
			ready = true;
		},
		fail: () => {
			error = new Error("capture failed");
			runtime.onReady!();
		},
		disconnect: () =>
			disconnected.reject(new Error("subscription disconnected")),
		async close() {
			try {
				await watcher.close();
			} finally {
				await db.end();
				await server[Symbol.asyncDispose]();
			}
		},
	};
}

pgTest(
	"native wake while busy is recovered by completion without a second stream event",
	async () => {
		const f = await fixture();
		try {
			f.busy(true);
			f.ready();
			f.runtime.onReady!();
			await f.busyChecked.promise;
			assertEquals(f.scheduled(), 0);
			f.busy(false);
			f.runtime.onReady!();
			await f.scheduledSignal.promise;
			assertEquals(f.scheduled(), 1);
		} finally {
			await f.close();
		}
	},
);

pgTest(
	"native readiness surfaces capture failures without another CDC event",
	async () => {
		const f = await fixture();
		f.fail();
		await assertRejects(() => f.watcher.promise, Error, "capture failed");
		await assertRejects(
			() => f.close(),
			AggregateError,
			"native readiness shutdown failed",
		);
	},
);

pgTest(
	"native subscription failure rejects the service lifecycle and shutdown joins it",
	async () => {
		const f = await fixture();
		f.disconnect();
		await assertRejects(
			() => f.watcher.promise,
			Error,
			"subscription disconnected",
		);
		await assertRejects(
			() => f.close(),
			AggregateError,
			"native readiness shutdown failed",
		);
	},
);
