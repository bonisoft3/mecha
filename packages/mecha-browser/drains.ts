// An app's drains in the clusters that run no change capture: the page's
// (cluster.ts) and the Durable Object's (mecha-edge). A drain is a database
// function the cluster calls as the service role when a table it names
// changes, and the call is the whole job (pronto's #Drain): an idempotent
// batch over an absolute read, which writes its own wake tables while work
// remains and nothing when there is none. The container tier calls it from a
// stream over the change bus; here a trigger on each named table notifies, and
// the listener calls every drain whose tables changed, once per settle, as
// that stream's one-second batch does.
//
// Nothing here is durable, and the contract is why nothing need be: a call
// takes whatever is pending then, so a lost wake is a delay until the next
// change, the next tick or the next boot, and a repeated one changes nothing.
// Every drain is called once as the dispatcher installs, which is when a wake
// the last isolate heard and did not answer is recovered, as the stream's start
// is on the container tier. A failed call stays owed and is tried again after the clock's backoff,
// or at once on the next change to its tables.
//
// PGlite enforces no statement_timeout, so a call is bounded by its host: the
// platform's CPU limit at the edge, nothing in a page.
import type { PGlite } from '@electric-sql/pglite'
import { backoff } from './clock.ts'

export interface Drain {
  name: string
  /** The tables whose change wakes it. */
  on: string[]
  /** The function, called with `body` as its named arguments. */
  call: string
  body: Record<string, boolean | number | string>
}

export interface DrainsConfig {
  db: PGlite
  drains: Drain[]
  /** The one chain every use of `db` goes through: PGlite is one connection. */
  serialize: <T>(fn: () => Promise<T>) => Promise<T>
  log: (line: string) => void
  /** Told when the earliest retry moved — a call failed, or a failed drain
   * recovered — by a host whose timers do not outlive it (the object's
   * alarm), which reads it again from retryAt and calls retryDue when it is
   * due. Without one the dispatcher keeps the retry on its own timer. */
  retry?: () => void
}

export interface Drains {
  /** The earliest instant a failed drain is tried again, or null. */
  retryAt: () => number | null
  /** Every failed drain whose pause is over, owed now, resolving once the
   * next pass returns where anything is owed — a fresh dispatcher's first
   * call of every drain included: what the host's timer calls. Later wakes do
   * not hold it, as idle's wait would. */
  retryDue: () => Promise<void>
  /** Resolves when no drain is owed, settling or running. */
  idle: () => Promise<void>
  /** Ends the dispatcher once a call under way returns, for a host that
   * closes the database next: no timer, listener or call outlives it. */
  stop: () => Promise<void>
}

/** The container stream's batching period. */
export const SETTLE_MS = 1000

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/
const ident = (s: string) => `"${s.replaceAll('"', '""')}"`
function refuse(message: string): never {
  throw new Error(message)
}
/** As PostgREST passes a JSON body's values to a function: untyped text,
 * which Postgres reads as the argument's own type, so `50` reaches a `text`
 * parameter as it reaches an `integer` one. */
function literal(drain: string, v: boolean | number | string): string {
  if (typeof v === 'number' && !Number.isSafeInteger(v)) refuse(`drain ${drain} passes ${v}, which is not an integer`)
  return `'${String(v).replaceAll("'", "''")}'`
}

interface State { drain: Drain; sql: string; owed: boolean; failures: number; retryAt: number | null }

export async function createDrains(cfg: DrainsConfig): Promise<Drains> {
  const { db, serialize, log } = cfg
  const states: State[] = cfg.drains.map((drain) => {
    if (!IDENTIFIER.test(drain.call)) refuse(`drain ${drain.name} calls ${drain.call}, which is not a function's name`)
    // A trigger reports its table unqualified, so a qualified name never wakes.
    for (const t of drain.on) if (!IDENTIFIER.test(t)) refuse(`drain ${drain.name} names ${t}, which is not a table's name`)
    const args = Object.entries(drain.body).map(([k, v]) => {
      if (!IDENTIFIER.test(k)) refuse(`drain ${drain.name} passes ${k}, which is not an argument's name`)
      return `${ident(k)} => ${literal(drain.name, v)}`
    })
    return { drain, sql: `SELECT ${ident(drain.call)}(${args.join(', ')})`, owed: true, failures: 0, retryAt: null }
  })
  const tables = [...new Set(states.flatMap((s) => s.drain.on))]

  // A row trigger, not a statement's: a statement that changes no row must
  // not wake a drain, or a queue drain's empty UPDATE would never sleep. A
  // truncate empties the table whole, so it wakes once, per statement. A
  // table no drain names any more, since a release dropped its drain, loses
  // its triggers here: the edge's directory keeps them across releases.
  await serialize(async () => {
    const stale = (await db.query<{ t: string }>(
      `SELECT DISTINCT c.relname AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
       WHERE g.tgname IN ('drain_notify', 'drain_truncate') AND NOT (c.relname = ANY($1))`, [tables],
    )).rows.map((r) => r.t)
    if (tables.length === 0 && stale.length === 0) return
    await db.exec(`CREATE OR REPLACE FUNCTION drain_notify() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_notify('drain', TG_TABLE_NAME); RETURN NULL; END $$;` +
      stale.map((t) => `DROP TRIGGER IF EXISTS drain_notify ON ${ident(t)}; DROP TRIGGER IF EXISTS drain_truncate ON ${ident(t)};`).join('\n') +
      tables.map((t) => `DROP TRIGGER IF EXISTS drain_notify ON ${ident(t)}; DROP TRIGGER IF EXISTS drain_truncate ON ${ident(t)};
        CREATE TRIGGER drain_notify AFTER INSERT OR UPDATE OR DELETE ON ${ident(t)} FOR EACH ROW EXECUTE FUNCTION drain_notify();
        CREATE TRIGGER drain_truncate AFTER TRUNCATE ON ${ident(t)} FOR EACH STATEMENT EXECUTE FUNCTION drain_notify();`).join('\n'))
  })
  if (states.length === 0) return { retryAt: () => null, retryDue: () => Promise.resolve(), idle: () => Promise.resolve(), stop: () => Promise.resolve() }

  let settling: ReturnType<typeof setTimeout> | null = null
  let retrying: ReturnType<typeof setTimeout> | null = null
  let busy = false
  let current: Promise<void> = Promise.resolve()
  let stopped = false
  let waiters: (() => void)[] = []
  /** Waiting for the end of the next pass. */
  let passing: (() => void)[] = []
  const quiet = () => stopped || (settling === null && !busy && !states.some((s) => s.owed))
  const wake = () => {
    for (const w of waiters) w()
    waiters = []
  }

  const settle = () => {
    if (!stopped && settling === null && !busy) settling = setTimeout(() => { current = run() }, SETTLE_MS)
  }
  const retryAt = () => states.reduce<number | null>((m, s) => s.retryAt !== null && (m === null || s.retryAt < m) ? s.retryAt : m, null)
  const retryDue = (): Promise<void> => {
    for (const s of states) {
      if (s.retryAt === null || s.retryAt > Date.now()) continue
      s.owed = true
      s.retryAt = null
    }
    if (stopped || (!busy && !states.some((s) => s.owed))) return Promise.resolve()
    settle()
    return new Promise((resolve) => passing.push(resolve))
  }
  const armRetry = () => {
    if (retrying !== null) clearTimeout(retrying)
    retrying = null
    const at = retryAt()
    if (at === null || stopped || cfg.retry) return
    // A timer may fire a little before its instant; what is not yet due is
    // armed again rather than dropped.
    retrying = setTimeout(() => {
      retrying = null
      void retryDue()
      armRetry()
    }, Math.max(at - Date.now(), 0))
  }

  // A call's own writes notify after its commit, while it still runs, so a
  // queue drain is owed again for the next settle until a call writes nothing.
  async function run() {
    settling = null
    busy = true
    const before = retryAt()
    const ending = passing
    passing = []
    let failed = false
    for (const s of states) {
      if (stopped) break
      if (!s.owed) continue
      s.owed = false
      try {
        await serialize(() => db.transaction(async (tx) => {
          await tx.exec(`SELECT set_config('request.jwt.claims', '{"role":"service"}', true); SELECT set_config('app.scopes', '', true); SET LOCAL ROLE service;`)
          await tx.query(s.sql)
        }))
        s.failures = 0
        s.retryAt = null
      } catch (e) {
        s.failures++
        s.retryAt = Date.now() + backoff(s.failures)
        failed = true
        log(`drain ${s.drain.name} failed (${s.failures} in a row): ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    busy = false
    if (failed) armRetry()
    if (retryAt() !== before) cfg.retry?.()
    for (const p of ending) p()
    if (states.some((s) => s.owed)) settle()
    else {
      // Asked for during this pass, with nothing left owed: no pass follows.
      for (const p of passing) p()
      passing = []
    }
    if (quiet()) wake()
  }

  const unlisten = await db.listen('drain', (table: string) => {
    let woke = false
    for (const s of states) {
      if (!s.drain.on.includes(table)) continue
      s.owed = true
      woke = true
    }
    if (woke) settle()
  })
  settle()

  return {
    retryAt,
    retryDue,
    idle: () => quiet() ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve)),
    stop: async () => {
      stopped = true
      if (settling !== null) clearTimeout(settling)
      if (retrying !== null) clearTimeout(retrying)
      settling = retrying = null
      await current
      await unlisten()
      for (const p of passing) p()
      passing = []
      wake()
    },
  }
}
