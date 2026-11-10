// PGlite is one connection and a turn cannot be interrupted, so the order of waiters is all a
// priority can buy. A render holds its turn for seconds and an API read or write for milliseconds,
// so they wait in separate lanes: a write behind a render lane waited for every render ahead of it.
export type Lane = 'api' | 'render' | 'low' | 'background-render'

const TURNS_BEFORE_YIELD = 4
// Short database turns share a connection with whole background SSR transactions.
const LOW_TURNS_BEFORE_RENDER = 16

export function lanes() {
  let running = false
  let apiStreak = 0
  let lowStreak = 0
  let backgroundLowTurns = 0
  const waiting: Record<Lane, Array<() => void>> = { api: [], render: [], low: [], 'background-render': [] }
  function pump() {
    if (running) return
    const { api, render, low } = waiting
    const background = waiting['background-render']
    const backgroundLane = low.length && background.length ? (backgroundLowTurns >= LOW_TURNS_BEFORE_RENDER ? 'background-render' : 'low')
      : low.length ? 'low' : background.length ? 'background-render' : undefined
    const lane: Lane | undefined =
      backgroundLane && ((api.length === 0 && render.length === 0) || lowStreak >= TURNS_BEFORE_YIELD) ? backgroundLane
      : render.length > 0 && (api.length === 0 || apiStreak >= TURNS_BEFORE_YIELD) ? 'render'
      : api.length > 0 ? 'api'
      : undefined
    if (lane === undefined) return
    apiStreak = lane === 'api' ? (render.length > 0 ? apiStreak + 1 : 0) : lane === 'render' ? 0 : apiStreak
    if (lane === 'low' || lane === 'background-render') {
      lowStreak = 0
      backgroundLowTurns = lane === 'low' ? Math.min(backgroundLowTurns + 1, LOW_TURNS_BEFORE_RENDER) : 0
    } else lowStreak = backgroundLane ? lowStreak + 1 : 0
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
