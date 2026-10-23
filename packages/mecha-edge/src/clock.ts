// The ticker on the edge: the sweep the page's cluster runs too
// (mecha-browser's clock.ts), on two clocks, as the ticker asks of every tier.
// The object's alarm stands at the next instant any schedule owes a runnable
// tick, so the object sleeps between occurrences: a daily schedule costs the
// free plan one wake a day, where a minutely poke would hold the object awake.
// The Worker's Cron Trigger pokes from outside the object on a coarse cadence,
// so a tick is never later than that where an alarm was lost, and the
// occurrences a lost span left behind are recorded on its pokes rather than
// chased one wake at a time. A tick records which clock minted it.
import type { EdgeEnv } from './object.ts'
export { type Clock, createClock, hasSchedules, nextDue, type Report, serviceCrud, sweepDue, type SweepRetry } from '../../mecha-browser/clock.ts'

/** The poke, from the Worker that holds the object: its Cron Trigger's
 * `scheduled`, the clock outside the object. Here rather than in object.ts
 * so a Worker needs nothing of the object's runtime to send it. */
export async function pokeCluster(env: EdgeEnv): Promise<void> {
  const res = await env.CLUSTER.get(env.CLUSTER.idFromName('cluster')).fetch(new Request('https://cluster/poke?caller=cron-trigger', { method: 'POST' }))
  const text = await res.text()
  if (!res.ok) throw new Error(`poke answered ${res.status}: ${text}`)
}
