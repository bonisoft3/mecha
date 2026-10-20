// A machine's step on the edge. The migration declares `hybrid_<name>.step`
// over `hybrid_<name>.engine` and leaves the engine to the tier (pronto's
// mecha-reducer.ts): PostgreSQL's is plv8; here it is pgl_step, PGlite for
// workerd's host import (pglite-workerd/modules/pgl_step), which reaches the
// step the object installs under globalThis.__pgliteStep. The machines come
// from the release (pronto's edge.ts writes src/machines.js), one `execute`
// each over the rules the migration embeds.
import type { PGlite } from '@electric-sql/pglite'

export interface EdgeMachine {
  /** The step: hybrid-runtime.js over the machine's rules. A throw is a
   * failed step, which becomes the error the step's transaction aborts on. */
  execute(input: unknown): unknown
}
export type EdgeMachines = Record<string, EdgeMachine>

export type HostStep = (name: string, json: string) => string

/** What pgl_step calls: the machine by name, its answer as JSON text, or a
 * failure after '!', the one way back into PostgreSQL's frames that keeps
 * their cleanup (modules/pgl_step/pgl_step.c raises it). */
export function hostStep(machines: EdgeMachines): HostStep {
  return (name, json) => {
    if (!Object.hasOwn(machines, name)) return `!pgl_step: no machine ${name}`
    try {
      return JSON.stringify(machines[name].execute(JSON.parse(json)))
    } catch (e) {
      return `!${e instanceof Error ? e.message : String(e)}`
    }
  }
}

export function installHostStep(machines: EdgeMachines) {
  ;(globalThis as { __pgliteStep?: HostStep }).__pgliteStep = hostStep(machines)
}

const NAME = /^[a-z][a-z0-9_]{0,30}$/

/** The engines the migrations left to this tier, created the first time the
 * data directory opens here: pgl_step itself, and each machine's engine over
 * it. A machine the migrations do not declare has no schema to hold one. */
export async function installEngines(db: PGlite, machines: string[]): Promise<void> {
  if (machines.length === 0) return
  const statements: string[] = []
  const present = async (signature: string) =>
    (await db.query<{ present: boolean }>(`SELECT to_regprocedure($1) IS NOT NULL AS present`, [signature])).rows[0].present
  if (!(await present('public.pgl_step(text, jsonb)'))) {
    statements.push(
      `CREATE FUNCTION public.pgl_step(name text, input jsonb) RETURNS jsonb LANGUAGE c STRICT AS '$libdir/pgl_step', 'pgl_step';`,
      `REVOKE ALL ON FUNCTION public.pgl_step(text, jsonb) FROM PUBLIC;`,
    )
  }
  for (const name of machines) {
    if (!NAME.test(name)) throw new Error(`invalid machine name ${name}`)
    if (await present(`hybrid_${name}.engine(jsonb)`)) continue
    statements.push(
      `CREATE FUNCTION hybrid_${name}.engine(input jsonb) RETURNS jsonb LANGUAGE sql STRICT AS $engine$ SELECT public.pgl_step('${name}', input) $engine$;`,
      `REVOKE ALL ON FUNCTION hybrid_${name}.engine(jsonb) FROM PUBLIC;`,
    )
  }
  if (statements.length) await db.exec(statements.join('\n'))
}
