export interface QueryStage {
	name: string;
	sql: string;
}
export interface QueryStages {
	sql: string;
	stages: QueryStage[];
}
export type StagedQueries = Record<string, QueryStages>;

const selectable = (sql: unknown): sql is string =>
	typeof sql === "string" && /^\s*(SELECT|WITH)\b/i.test(sql) &&
	!/\bnextval\b|\bU\s*&\s*"/i.test(sql);

export function validateQueryStages(
	value: unknown,
	queries: Record<string, string>,
): StagedQueries | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("invalid query stages");
	}
	const names = new Set<string>();
	for (const [query, plan] of Object.entries(value)) {
		if (
			!Object.hasOwn(queries, query) || !plan || typeof plan !== "object" ||
			Object.keys(plan).sort().join() !== "sql,stages" ||
			!selectable(plan.sql) || !Array.isArray(plan.stages)
		) {
			throw new Error("invalid staged query");
		}
		for (const stage of plan.stages) {
			if (
				!stage || typeof stage !== "object" ||
				Object.keys(stage).sort().join() !== "name,sql" ||
				typeof stage.name !== "string" ||
				!/^__duckstream_[a-zA-Z0-9_]+$/.test(stage.name) ||
				names.has(stage.name) || !selectable(stage.sql)
			) throw new Error("invalid query stage");
			names.add(stage.name);
		}
	}
	return value as StagedQueries;
}
