// Installs the lake's DuckDB extensions where main.ts loads them from: run
// once at image build, and before the tests that reach Postgres.

import { duckdb } from "./main.ts";

await (await (await duckdb()).connect()).run("INSTALL postgres; INSTALL ducklake");
