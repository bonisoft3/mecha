export const pieces = {
	fixture: {
		getAction(name: string) {
			if (name !== "run") return undefined;
			return {
				async run(ctx: { propsValue: Record<string, unknown>; auth: unknown }) {
					const p = ctx.propsValue;
					console.log("untrusted logs");
					if (p.mode === "hang") {
						await new Promise((resolve) => setTimeout(resolve, 10000));
					}
					if (p.mode === "large") return "x".repeat(10000);
					if (p.mode === "invalid") return 2;
					return {
						props: p,
						auth: ctx.auth,
						inherited: Deno.env.get("OTHER_SECRET") ?? null,
					};
				},
			};
		},
	},
};
