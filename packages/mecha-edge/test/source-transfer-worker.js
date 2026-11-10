import { DurableObject } from "cloudflare:workers";
import { createDuckDB } from "../../duckdb-workerd/.build/duckdb/runtime.js";
import { PagedQuery } from "../src/paged-query.ts";
export class Source extends DurableObject {
	db;
	query;
	async fetch(req) {
		this.db ??= await createDuckDB(this.env.ASSETS, {
			storage: {
				exec: (sql, ...args) => this.ctx.storage.sql.exec(sql, ...args),
			},
			maxDatabaseBytes: 64000000,
			maxTemporaryBytes: 64000000,
		});
		const p = {
			version: "v",
			reads: ["source"],
			queries: {
				total:
					"SELECT count(*)::INTEGER n,sum(value)::DOUBLE total FROM source",
			},
			spec: { name: "probe", file: "unused", to: [] },
		};
		this.query ??= new PagedQuery(this.db, [p]);
		const action = await req.json();
		try {
			if (action.init) {
				this.query.initialize({
					id: "capture",
					name: "probe",
					version: "v",
					revision: 1,
					tables: {
						source: {
							columns: [{ name: "value", type: "integer" }],
							rows: 16384,
						},
					},
				});
			}
			if (action.chunk) await this.query.append(action.chunk);
			if (action.finish) {
				this.query.materialize("total");
				return Response.json({
					rows: this.query.read("total").rows,
					heap: this.db.memoryBytes,
				});
			}
			return Response.json(this.query.progress());
		} catch (e) {
			return new Response(String(e), { status: 400 });
		}
	}
}
export default {
	fetch(req, env) {
		return env.SOURCE.get(env.SOURCE.idFromName(new URL(req.url).pathname))
			.fetch(req);
	},
};
