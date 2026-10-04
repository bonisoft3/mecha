/**
 * Electric's HTTP protocol, answered in process, for tests that drive a real
 * ShapeStream through a fetcher. It speaks what @electric-sql/client 1.5.27
 * asks of a server: a full log or `log=changes_only` from `offset=now`, a
 * subset snapshot answered as `{metadata, data}` from the rows its predicate
 * admits, and live long-polls that resolve when the test pushes a change. Row
 * values are Postgres's text spellings, as Electric sends them; `schema` names
 * each column's SQL type, per table.
 */
export type FakeRow = Record<string, string | null>
export type FakeChange = { operation: "insert" | "update" | "delete"; value: FakeRow; txid: number }
export type FakeSubset = { table: string; where: string; params: Record<string, string>; url: URL }

export interface FakeElectricOptions {
  schema: Record<string, Record<string, { type: string }>>
  /** Each table's rows, which a full shape and a subset read, and a push changes. */
  rows?: Record<string, FakeRow[]>
  key?: string
  /** The snapshot's visibility: a change whose txid is below `xmin` is in it. */
  xmin?: number
}

/**
 * A subset's predicate as the client compiles a view's: quoted columns
 * compared with `$n` or `= ANY($n)`, `IS [NOT] NULL`, AND, OR, NOT and
 * parentheses. Anything else is a predicate this fake cannot answer, and
 * throws.
 */
function predicate(where: string, params: Record<string, string>): (row: FakeRow) => boolean {
  const tokens = where.match(/"[^"]+"|\$\d+|[()=]|[A-Za-z]+/g) ?? []
  let at = 0
  const take = (want?: string) => {
    const token = tokens[at++]
    if (token === undefined || (want !== undefined && token.toUpperCase() !== want)) {
      throw new Error(`the fake Electric cannot read: ${where}`)
    }
    return token
  }
  const peek = () => tokens[at]?.toUpperCase()
  const param = () => params[take().slice(1)]
  type Test = (row: FakeRow) => boolean
  const or = (): Test => {
    const terms = [and()]
    while (peek() === "OR") {
      take()
      terms.push(and())
    }
    return (row) => terms.some((t) => t(row))
  }
  const and = (): Test => {
    const terms = [unary()]
    while (peek() === "AND") {
      take()
      terms.push(unary())
    }
    return (row) => terms.every((t) => t(row))
  }
  const unary = (): Test => {
    if (peek() === "NOT") {
      take()
      const inner = unary()
      return (row) => !inner(row)
    }
    if (peek() === "(") {
      take()
      const inner = or()
      take(")")
      return inner
    }
    const col = take().slice(1, -1)
    if (peek() === "IS") {
      take()
      const negated = peek() === "NOT"
      if (negated) take()
      take("NULL")
      return (row) => (row[col] == null) !== negated
    }
    take("=")
    if (peek() === "ANY") {
      take()
      take("(")
      const values = param().slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, ""))
      take(")")
      return (row) => values.includes(String(row[col]))
    }
    const value = param()
    return (row) => String(row[col]) === value
  }
  const test = or()
  if (at !== tokens.length) throw new Error(`the fake Electric cannot read: ${where}`)
  return test
}

export function fakeElectric(options: FakeElectricOptions) {
  const key = options.key ?? "id"
  const server: Record<string, FakeRow[]> = Object.fromEntries(Object.entries(options.rows ?? {}).map(([t, rows]) => [t, [...rows]]))
  const requests: URL[] = []
  const subsets: FakeSubset[] = []
  const failing = new Map<string, { status: number; body: unknown }[]>()
  const live = new Map<string, { offset: number; batches: FakeChange[][]; wake: (() => void) | null }>()
  const stream = (table: string) => {
    let s = live.get(table)
    if (s === undefined) live.set(table, (s = { offset: 0, batches: [], wake: null }))
    return s
  }
  const headers = (table: string) => ({
    "content-type": "application/json",
    "electric-handle": `h-${table}`,
    "electric-offset": `0_${stream(table).offset}`,
    "electric-schema": JSON.stringify(options.schema[table]),
    "electric-cursor": String(stream(table).offset),
  })
  const message = (table: string, operation: string, value: FakeRow, txid?: number) => ({
    key: `"public"."${table}"/"${value[key]}"`,
    value,
    headers: { operation, relation: ["public", table], ...(txid === undefined ? {} : { txids: [txid] }) },
  })
  const upToDate = (table: string) => ({ headers: { control: "up-to-date", global_last_seen_lsn: String(stream(table).offset) } })
  const json = (table: string, body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: headers(table) })

  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/auth/shape")) {
      const body = JSON.parse(String(init?.body ?? "{}"))
      return new Response(JSON.stringify({ token: "t", where: `table ${body.table}`, expires_in: 900 }), { status: 200 })
    }
    requests.push(url)
    const p = url.searchParams
    const table = p.get("table") ?? ""
    if (p.has("subset__where")) {
      const where = p.get("subset__where")!
      const params = JSON.parse(p.get("subset__params") ?? "{}")
      subsets.push({ table, where, params, url })
      const failure = failing.get(table)?.shift()
      if (failure !== undefined) return json(table, failure.body, failure.status)
      const xmin = String(options.xmin ?? 1)
      return json(table, {
        metadata: { xmin, xmax: xmin, xip_list: [], snapshot_mark: subsets.length, database_lsn: String(stream(table).offset) },
        data: (server[table] ?? []).filter(predicate(where, params)).map((row) => message(table, "insert", row)),
      })
    }
    if (p.get("live") !== "true") {
      if (p.get("log") === "changes_only" || p.get("offset") === "now") return json(table, [upToDate(table)])
      return json(table, [...(server[table] ?? []).map((row) => message(table, "insert", row)), upToDate(table)])
    }
    const s = stream(table)
    if (s.batches.length === 0) {
      await new Promise<void>((resolve, reject) => {
        s.wake = resolve
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      })
    }
    const batch = s.batches.shift()!
    s.offset += 1
    return json(table, [...batch.map((c) => message(table, c.operation, c.value, c.txid)), upToDate(table)])
  }

  return {
    fetcher: fetcher as typeof fetch,
    requests,
    subsets,
    /** Delivers the changes as one batch of the table's live stream, and
     * applies them to the rows a later subset reads. */
    push(table: string, ...changes: FakeChange[]) {
      const rows = (server[table] ??= [])
      for (const c of changes) {
        const at = rows.findIndex((r) => r[key] === c.value[key])
        if (c.operation === "delete") {
          if (at >= 0) rows.splice(at, 1)
        } else if (at >= 0) rows[at] = c.value
        else rows.push(c.value)
      }
      const s = stream(table)
      s.batches.push(changes)
      const wake = s.wake
      s.wake = null
      wake?.()
    },
    /** Answers the next subsets of `table` with each `status` and `body` in
     * turn, one per subset. */
    fail(table: string, ...answers: [number, unknown][]) {
      failing.set(table, [...(failing.get(table) ?? []), ...answers.map(([status, body]) => ({ status, body }))])
    },
  }
}
