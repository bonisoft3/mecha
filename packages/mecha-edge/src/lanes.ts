// PGlite is one connection and a turn cannot be interrupted, so the order of waiters is all a
// priority can buy. A render holds its turn for seconds and an API read or write for milliseconds,
// so they wait in separate lanes: a write behind a render lane waited for every render ahead of it.
export type Lane = 'api' | 'render' | 'low'

const TURNS_BEFORE_YIELD = 4

export function lanes() {
  let running = false
  let apiStreak = 0
  let lowStreak = 0
  const waiting: Record<Lane, Array<() => void>> = { api: [], render: [], low: [] }
  function pump() {
    if (running) return
    const { api, render, low } = waiting
    const lane: Lane | undefined =
      low.length > 0 && ((api.length === 0 && render.length === 0) || lowStreak >= TURNS_BEFORE_YIELD) ? 'low'
      : render.length > 0 && (api.length === 0 || apiStreak >= TURNS_BEFORE_YIELD) ? 'render'
      : api.length > 0 ? 'api'
      : undefined
    if (lane === undefined) return
    apiStreak = lane === 'api' ? apiStreak + 1 : lane === 'render' ? 0 : apiStreak
    lowStreak = lane === 'low' ? 0 : lowStreak + 1
    running = true
    waiting[lane].shift()!()
  }
  return function serialize<T>(fn: () => Promise<T>, lane: Lane): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      waiting[lane].push(() => {
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
          running = false
          pump()
        })
      })
      pump()
    })
  }
}
