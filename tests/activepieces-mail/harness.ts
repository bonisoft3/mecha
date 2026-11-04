import { rootCertificates } from "node:tls";
import { terminateTree } from "./process.ts";

export const cwd = new URL(".", import.meta.url);
const piece = new URL("../../pieces/mail/", cwd);
const service = new URL("../../services/activepieces/", cwd);
export const mailImage = Deno.env.get("MAIL_IMAGE");

export async function docker(...args: string[]) {
	const result = await new Deno.Command("docker", {
		args,
		stdout: "piped",
		stderr: "piped",
	}).output();
	if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
	return new TextDecoder().decode(result.stdout).trim();
}
export async function ready(
	url: string,
	exited?: Promise<Deno.CommandStatus>,
	bridge = false,
) {
	const deadline = Date.now() + 60_000;
	for (;;) {
		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(1000),
				...(bridge
					? {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}",
					}
					: {}),
			});
			await response.body?.cancel();
			if (response.status !== (bridge ? 400 : 200)) {
				throw new TypeError(`Not ready: ${response.status}`);
			}
			return;
		} catch (error) {
			if (
				!(error instanceof TypeError) &&
				!(error instanceof DOMException && error.name === "TimeoutError")
			) throw error;
			if (Date.now() >= deadline) throw error;
			await Promise.race([
				new Promise((resolve) => setTimeout(resolve, 250)),
				...(exited
					? [exited.then((status) => {
						throw new Error(`Launcher exited before readiness: ${status.code}`);
					})]
					: []),
			]);
		}
	}
}
export async function startBridge(
	env: Record<string, string>,
	network?: string,
	trustFixture = false,
) {
	const fixture = await Deno.makeTempDir({ prefix: "mail-runner-" });
	const name = `mail-bridge-${crypto.randomUUID().slice(0, 8)}`;
	const remove = () => Deno.remove(fixture, { recursive: true });
	try {
		await Deno.mkdir(`${fixture}/src`);
		for (
			const file of [
				"src/index.ts",
				"send.input.schema.json",
				"send.output.schema.json",
				"mail.auth.schema.json",
				"package.json",
				"deno.json",
				"deno.lock",
			]
		) {
			await Deno.copyFile(new URL(file, piece), `${fixture}/${file}`);
		}
		await Deno.writeTextFile(
			`${fixture}/registry.ts`,
			'import { mail } from "./src/index.ts";\nexport const pieces = { mail };\n',
		);
		const inputSchema = JSON.parse(
			await Deno.readTextFile(`${fixture}/send.input.schema.json`),
		);
		const outputSchema = JSON.parse(
			await Deno.readTextFile(`${fixture}/send.output.schema.json`),
		);
		const authSchema = JSON.parse(
			await Deno.readTextFile(`${fixture}/mail.auth.schema.json`),
		);
		const fixedProps = {
			host: env.MAIL_HOST,
			port: Number(env.MAIL_PORT),
			starttls: env.MAIL_STARTTLS === "true",
			messageIdDomain: "airlock.example",
			...(trustFixture
				? {
					ca: [
						...rootCertificates,
						await Deno.readTextFile(new URL("fixtures/smtp-cert.pem", cwd)),
					],
				}
				: {}),
		};
		const hasAuth = Boolean(env.MAIL_USER || env.MAIL_PASSWORD);
		const manifest = {
			version: 1,
			limits: {
				timeoutMs: 8000,
				maxConcurrent: 2,
				maxRequestBytes: 65536,
				maxResultBytes: 65536,
			},
			actions: {
				sendMail: {
					piece: "mail",
					action: "send-mail",
					inputSchema,
					outputSchema,
					fixedProps,
					idempotencyKeyProp: "requestKey",
					...(hasAuth
						? { auth: { jsonSecret: "SMTP_AUTH_JSON", schema: authSchema } }
						: {}),
				},
			},
		};
		await Deno.writeTextFile(
			`${fixture}/manifest.json`,
			JSON.stringify(manifest),
		);
		const secret: Record<string, string> = hasAuth
			? {
				SMTP_AUTH_JSON: JSON.stringify({
					type: "CUSTOM_AUTH",
					props: { user: env.MAIL_USER, password: env.MAIL_PASSWORD },
				}),
			}
			: {};
		if (mailImage) {
			await Deno.writeTextFile(
				`${fixture}/Dockerfile`,
				`ARG BASE_IMAGE
FROM \${BASE_IMAGE}
COPY deno.json deno.lock package.json registry.ts send.input.schema.json send.output.schema.json mail.auth.schema.json /app/
COPY src/index.ts /app/src/index.ts
RUN deno cache --frozen --config /app/deno.json /app/registry.ts
`,
			);
			const fixtureImage = await docker(
				"build",
				"-q",
				"--build-arg",
				`BASE_IMAGE=${mailImage}`,
				fixture,
			);
			await docker(
				"run",
				"-d",
				"--name",
				name,
				...(network ? ["--network", network] : []),
				...(Deno.build.os === "linux" &&
						env.MAIL_HOST === "host.docker.internal"
					? ["--add-host", "host.docker.internal:host-gateway"]
					: []),
				"-v",
				`${fixture}:/app:ro`,
				"-p",
				"127.0.0.1::8080",
				...Object.entries(secret).flatMap((
					[key, value],
				) => ["-e", `${key}=${value}`]),
				fixtureImage,
			);
			const exited = docker("wait", name).then((code) => ({
				success: code === "0",
				code: Number(code),
				signal: null,
			}));
			const stop = async () => {
				await docker("rm", "-f", name);
				await exited;
				await remove();
			};
			try {
				const port = Number(
					(await docker("port", name, "8080")).split(":").pop(),
				);
				const url = `http://127.0.0.1:${port}/actions/sendMail/`;
				await ready(url, exited, true);
				return { url, stop };
			} catch (error) {
				const logs = await docker("logs", name);
				await stop();
				throw new Error(`Container runner failed: ${logs}`, { cause: error });
			}
		}
		const socket = Deno.listen({ hostname: "127.0.0.1", port: 0 });
		const port = (socket.addr as Deno.NetAddr).port;
		socket.close();
		const child = new Deno.Command(Deno.execPath(), {
			args: [
				"run",
				"--frozen",
				"--allow-read",
				"--allow-env",
				"--allow-net",
				"--allow-run",
				"--allow-sys=hostname",
				"main.ts",
			],
			cwd: service,
			env: {
				...secret,
				ACTIVEPIECES_MANIFEST: `${fixture}/manifest.json`,
				ACTIVEPIECES_REGISTRY: `${fixture}/registry.ts`,
				PORT: String(port),
			},
			stdout: "inherit",
			stderr: "inherit",
		}).spawn();
		let finished = false;
		const status = child.status.then((result) => {
			finished = true;
			return result;
		});
		const stop = async () => {
			if (!finished) await terminateTree(child.pid);
			await status;
			await remove();
		};
		try {
			const url = `http://127.0.0.1:${port}/actions/sendMail/`;
			await ready(url, status, true);
			return { url, stop };
		} catch (error) {
			await stop();
			throw error;
		}
	} catch (error) {
		try {
			await Deno.stat(fixture);
		} catch (e) {
			if (e instanceof Deno.errors.NotFound) throw error;
			throw e;
		}
		await remove();
		throw error;
	}
}
