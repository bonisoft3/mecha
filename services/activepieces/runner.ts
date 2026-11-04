import { Ajv, type ValidateFunction } from "ajv";

interface Action {
	piece: string;
	action: string;
	inputSchema: object | boolean;
	outputSchema: object | boolean;
	auth?: { jsonSecret: string; schema: object | boolean };
	fixedProps: Record<string, unknown>;
	idempotencyKeyProp?: string;
}
interface Manifest {
	version: 1;
	revision?: string;
	limits: {
		timeoutMs: number;
		maxConcurrent: number;
		maxRequestBytes: number;
		maxResultBytes: number;
	};
	actions: Record<string, Action>;
}
interface Compiled {
	action: Action;
	input: ValidateFunction;
	output: ValidateFunction;
	auth?: ValidateFunction;
}
const object = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v);
function checkRefs(value: unknown): void {
	if (Array.isArray(value)) { for (const item of value) checkRefs(item); }
	else if (object(value)) {
		for (const [key, item] of Object.entries(value)) {
			if (
				key === "$ref" && (typeof item !== "string" || !item.startsWith("#"))
			) throw new Error("Only local schema references are supported");
			checkRefs(item);
		}
	}
}
export function prepare(
	value: unknown,
): {
	revision?: string;
	limits: Manifest["limits"];
	actions: Map<string, Compiled>;
} {
	if (
		!object(value) || value.version !== 1 || !object(value.limits) ||
		!object(value.actions)
	) throw new Error("Invalid manifest");
	if (
		value.revision !== undefined &&
		(typeof value.revision !== "string" || !value.revision)
	) throw new Error("Invalid revision");
	const limits = value.limits;
	for (
		const name of [
			"timeoutMs",
			"maxConcurrent",
			"maxRequestBytes",
			"maxResultBytes",
		]
	) {
		if (!Number.isSafeInteger(limits[name]) || (limits[name] as number) < 1) {
			throw new Error(`Invalid limit ${name}`);
		}
	}
	if ((limits.timeoutMs as number) > 8000) throw new Error("Invalid timeout");
	const ajv = new Ajv({
		strict: true,
		allowUnionTypes: true,
		allErrors: false,
	});
	const actions = new Map<string, Compiled>();
	for (const [alias, raw] of Object.entries(value.actions)) {
		if (
			!/^[A-Za-z0-9_-]+$/.test(alias) || !object(raw) ||
			typeof raw.piece !== "string" || !raw.piece ||
			typeof raw.action !== "string" || !raw.action ||
			!object(raw.fixedProps) ||
			!(object(raw.inputSchema) || typeof raw.inputSchema === "boolean") ||
			!(object(raw.outputSchema) || typeof raw.outputSchema === "boolean")
		) throw new Error("Invalid action");
		if (
			raw.idempotencyKeyProp !== undefined &&
			(typeof raw.idempotencyKeyProp !== "string" || !raw.idempotencyKeyProp ||
				Object.hasOwn(raw.fixedProps, raw.idempotencyKeyProp))
		) throw new Error("Invalid identity property");
		if (
			raw.auth !== undefined &&
			(!object(raw.auth) || typeof raw.auth.jsonSecret !== "string" ||
				!raw.auth.jsonSecret ||
				!(object(raw.auth.schema) || typeof raw.auth.schema === "boolean"))
		) throw new Error("Invalid auth");
		const action = raw as unknown as Action;
		checkRefs(action.inputSchema);
		checkRefs(action.outputSchema);
		if (action.auth) checkRefs(action.auth.schema);
		actions.set(alias, {
			action,
			input: ajv.compile(action.inputSchema),
			output: ajv.compile(action.outputSchema),
			auth: action.auth && ajv.compile(action.auth.schema),
		});
	}
	return {
		revision: value.revision as string | undefined,
		limits: limits as unknown as Manifest["limits"],
		actions,
	};
}
function resolveAuth(
	entry: Compiled,
	env: (name: string) => string | undefined,
): unknown {
	if (!entry.action.auth) return undefined;
	const raw = env(entry.action.auth.jsonSecret);
	if (raw === undefined) throw new Error("Required secret is missing");
	let auth: unknown;
	try {
		auth = JSON.parse(raw);
	} catch {
		throw new Error("Secret is not JSON");
	}
	if (!entry.auth!(auth)) throw new Error("Secret violates its schema");
	return auth;
}
export function validateSecrets(
	config: ReturnType<typeof prepare>,
	env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): void {
	for (const entry of config.actions.values()) resolveAuth(entry, env);
}
async function readBounded(
	stream: ReadableStream<Uint8Array>,
	max: number,
	stopped?: Promise<never>,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const read = reader.read();
			const { value, done } =
				await (stopped ? Promise.race([read, stopped]) : read);
			if (done) break;
			size += value.length;
			if (size > max) throw new Error("overflow");
			chunks.push(value);
		}
	} catch (error) {
		reader.cancel().catch(() => console.error("Failed to cancel input stream"));
		throw error;
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}
const decode = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
function childOptions(
	registry: string,
	env: (name: string) => string | undefined,
	network: boolean,
) {
	const registryUrl = new URL(
		registry.startsWith("/") ? `file://${registry}` : registry,
		import.meta.url,
	).href;
	if (!registryUrl.startsWith("file:")) {
		throw new Error("Registry must be local");
	}
	const registryDir = decodeURIComponent(new URL(".", registryUrl).pathname);
	const serviceDir = decodeURIComponent(new URL(".", import.meta.url).pathname);
	const denoDir = env("DENO_DIR");
	const readPaths = ["/app", registryDir, serviceDir, denoDir].filter(Boolean)
		.join(",");
	return {
		registryUrl,
		args: [
			"run",
			"--cached-only",
			"--frozen",
			`--config=${registryDir}deno.json`,
			`--allow-read=${readPaths}`,
			...(network ? ["--allow-net"] : []),
			"--allow-env",
			new URL("./child.ts", import.meta.url).pathname,
		],
		env: denoDir
			? { DENO_DIR: denoDir } as Record<string, string>
			: {} as Record<string, string>,
	};
}
export async function probe(
	config: ReturnType<typeof prepare>,
	registry: string,
): Promise<void> {
	const opts = childOptions(registry, (name) => Deno.env.get(name), false);
	const child = new Deno.Command(Deno.execPath(), {
		args: opts.args,
		clearEnv: true,
		env: opts.env,
		stdin: "piped",
		stdout: "null",
		stderr: "null",
	}).spawn();
	const writer = child.stdin.getWriter();
	await writer.write(
		encoder.encode(
			JSON.stringify({
				registry: opts.registryUrl,
				probe: [...config.actions.values()].map(({ action }) => ({
					piece: action.piece,
					action: action.action,
				})),
			}),
		),
	);
	await writer.close();
	const timeout = setTimeout(() => killChild(child), config.limits.timeoutMs);
	try {
		if (!(await child.status).success) {
			throw new Error("Registry admission failed");
		}
	} finally {
		clearTimeout(timeout);
	}
}
function closeConnection(conn: Deno.TcpConn) {
	try {
		conn.close();
	} catch (error) {
		if (!(error instanceof Deno.errors.BadResource)) throw error;
	}
}
function killChild(child: Deno.ChildProcess) {
	try {
		child.kill("SIGKILL");
	} catch (error) {
		if (
			!(error instanceof Deno.errors.NotFound) &&
			!(error instanceof TypeError &&
				error.message === "Child process has already terminated")
		) throw error;
	}
}
export function handler(
	config: ReturnType<typeof prepare>,
	registry: string,
	env: (name: string) => string | undefined = (name) => Deno.env.get(name),
) {
	let active = 0;
	return async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const match = /^\/actions\/([A-Za-z0-9_-]+)\/$/.exec(url.pathname);
		if (!match || url.search || !config.actions.has(match[1])) {
			return new Response(null, { status: 404 });
		}
		if (req.method !== "POST") return new Response(null, { status: 405 });
		const key = req.headers.get("Idempotency-Key");
		if (!key?.trim()) return new Response(null, { status: 400 });
		const entry = config.actions.get(match[1])!;
		const { action } = entry;
		const invocationId = crypto.randomUUID();
		const started = performance.now();
		const fail = (kind: string) => {
			console.error(
				JSON.stringify({
					kind,
					alias: match[1],
					piece: action.piece,
					revision: config.revision,
					invocationId,
					durationMs: Math.round(performance.now() - started),
				}),
			);
			return Response.json({ error: { kind, invocationId } }, { status: 503 });
		};
		if (active >= config.limits.maxConcurrent) return fail("capacity");
		active++;
		let child: Deno.ChildProcess | undefined;
		let listener: Deno.TcpListener | undefined;
		let exited = false;
		let reason = "child_failure";
		let rejectStop!: (error: Error) => void;
		const stopped = new Promise<never>((_, reject) => {
			rejectStop = reject;
		});
		const stop = (kind: string) => {
			reason = kind;
			rejectStop(new Error(kind));
		};
		const abort = () => stop("disconnected");
		req.signal.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => stop("deadline"), config.limits.timeoutMs);
		try {
			if (req.signal.aborted) {
				reason = "disconnected";
				throw new Error("disconnected");
			}
			let body: unknown;
			try {
				body = JSON.parse(
					decode.decode(
						await readBounded(
							req.body ?? new ReadableStream({
								start(c) {
									c.close();
								},
							}),
							config.limits.maxRequestBytes,
							stopped,
						),
					),
				);
			} catch (error) {
				if (reason === "deadline" || reason === "disconnected") throw error;
				return new Response(null, {
					status: error instanceof Error && error.message === "overflow"
						? 413
						: 400,
				});
			}
			if (
				!object(body) || Object.keys(body).length !== 1 || !object(body.props)
			) return new Response(null, { status: 400 });
			if (
				Object.keys(action.fixedProps).some((key) =>
					Object.hasOwn(body.props!, key)
				) ||
				(action.idempotencyKeyProp &&
					Object.hasOwn(body.props, action.idempotencyKeyProp))
			) return new Response(null, { status: 400 });
			const props = {
				...body.props,
				...action.fixedProps,
				...(action.idempotencyKeyProp
					? { [action.idempotencyKeyProp]: key }
					: {}),
			};
			if (!entry.input(props)) return new Response(null, { status: 400 });
			const auth = resolveAuth(entry, env);
			listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
			const port = (listener.addr as Deno.NetAddr).port;
			const token = crypto.randomUUID();
			const opts = childOptions(registry, env, true);
			child = new Deno.Command(Deno.execPath(), {
				args: opts.args,
				clearEnv: true,
				env: opts.env,
				stdin: "piped",
				stdout: "null",
				stderr: "null",
			}).spawn();
			child.status.then(() => {
				exited = true;
			});
			const data = encoder.encode(
				JSON.stringify({
					port,
					token,
					registry: opts.registryUrl,
					piece: action.piece,
					action: action.action,
					props,
					auth,
				}),
			);
			const execute = async () => {
				const writer = child!.stdin.getWriter();
				await writer.write(data);
				await writer.close();
				const conn = await listener!.accept();
				try {
					let bytes: Uint8Array;
					try {
						bytes = await readBounded(
							conn.readable,
							config.limits.maxResultBytes + token.length + 1,
						);
					} catch (error) {
						if (error instanceof Error && error.message === "overflow") {
							reason = "result_too_large";
						}
						throw error;
					}
					const text = decode.decode(bytes);
					if (!text.startsWith(token + "\n")) {
						throw new Error("Invalid channel");
					}
					const payload = JSON.parse(text.slice(token.length + 1));
					if (
						!object(payload) || !Object.hasOwn(payload, "result") ||
						!entry.output(payload.result)
					) {
						reason = "invalid_output";
						throw new Error("Invalid output");
					}
					const status = await child!.status;
					if (!status.success) throw new Error("Child failed");
					return Response.json({ result: payload.result });
				} finally {
					closeConnection(conn);
				}
			};
			return await Promise.race([
				execute(),
				stopped,
				child.status.then((status) => {
					if (!status.success) throw new Error("Child failed");
					return new Promise<never>(() => {});
				}),
			]);
		} catch {
			return fail(reason);
		} finally {
			clearTimeout(timer);
			req.signal.removeEventListener("abort", abort);
			listener?.close();
			if (child) {
				if (!exited) killChild(child);
				await child.status;
			}
			active--;
		}
	};
}
