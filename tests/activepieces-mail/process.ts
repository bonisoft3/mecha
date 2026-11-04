export async function terminateTree(pid: number): Promise<void> {
	if (Deno.build.os === "windows") {
		const result = await new Deno.Command("taskkill", {
			args: ["/PID", String(pid), "/T", "/F"],
			stdout: "null",
			stderr: "piped",
		}).output();
		if (!result.success) {
			throw new Error(new TextDecoder().decode(result.stderr));
		}
		return;
	}
	const result = await new Deno.Command("ps", {
		args: ["-axo", "pid=,ppid="],
		stdout: "piped",
		stderr: "piped",
	}).output();
	if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
	const children = new Map<number, number[]>();
	for (
		const row of new TextDecoder().decode(result.stdout).trim().split("\n")
	) {
		const [child, parent] = row.trim().split(/\s+/).map(Number);
		children.set(parent, [...(children.get(parent) ?? []), child]);
	}
	const descendants = (
		parent: number,
	): number[] => [parent, ...(children.get(parent) ?? []).flatMap(descendants)];
	// Kill parents first so launchers cannot replace a child during cleanup.
	for (const target of descendants(pid)) {
		try {
			Deno.kill(target, "SIGKILL");
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) throw error;
		}
	}
}
