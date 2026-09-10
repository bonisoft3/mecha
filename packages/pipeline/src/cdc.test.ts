import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { live } from "@electric-sql/pglite/live"
import { createCDCPipelineListener } from "./cdc"
import type { PipelineConfig, PipelineContext } from "./types"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS "test_input" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "value" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending'
);
CREATE OR REPLACE FUNCTION mecha_notify_cdc() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('cdc', json_build_object('table', TG_TABLE_NAME, 'op', TG_OP, 'row', row_to_json(NEW))::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS test_input_cdc ON "test_input";
CREATE TRIGGER test_input_cdc AFTER INSERT ON "test_input" FOR EACH ROW EXECUTE FUNCTION mecha_notify_cdc();
`

describe("CDC pipeline listener", () => {
  let pglite: PGlite
  const httpCalls: Array<{ url: string; method: string; body: any }> = []

  const pipeline: PipelineConfig = {
    input: { cdc: { table: "test_input" } },
    pipeline: {
      processors: [
        // cdc.ts wraps the row in {data: JSON.stringify(row)} to match rpk's
        // CloudEvents-from-Dapr envelope. Pipelines must unwrap with .data | fromjson.
        { jq: '.data | fromjson | select(.status == "pending")' },
        { jq: '{id: .id, result: (.value | ascii_upcase)}' },
      ],
    },
    output: {
      http_client: {
        url: "/crud/test_output",
        verb: "POST",
        headers: { Prefer: "return=representation" },
      },
    },
  }

  const ctx: PipelineContext = {
    httpHandler: async (req: Request) => {
      const body = await req.json()
      httpCalls.push({ url: req.url, method: req.method, body })
      return new Response(JSON.stringify(body), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    },
    env: {},
  }

  beforeEach(async () => {
    pglite = await PGlite.create({ extensions: { live } })
    await pglite.exec(SCHEMA)
    httpCalls.length = 0
  })

  afterEach(async () => {
    await pglite.close()
  })

  it("executes pipeline on CDC event and sends output", async () => {
    const cleanup = await createCDCPipelineListener(pglite, [pipeline], ctx)

    await pglite.query(`INSERT INTO test_input (id, value, status) VALUES ('t1', 'hello', 'pending')`)
    await new Promise((r) => setTimeout(r, 500))

    expect(httpCalls).toHaveLength(1)
    expect(httpCalls[0].method).toBe("POST")
    expect(httpCalls[0].body).toEqual({ id: "t1", result: "HELLO" })

    cleanup()
  })

  it("filters out non-matching rows", async () => {
    const cleanup = await createCDCPipelineListener(pglite, [pipeline], ctx)

    await pglite.query(`INSERT INTO test_input (id, value, status) VALUES ('t2', 'skip', 'complete')`)
    await new Promise((r) => setTimeout(r, 500))

    expect(httpCalls).toHaveLength(0)

    cleanup()
  })
})
