const SUBSET_CONCURRENCY = 4

export function subsetScheduler() {
  type Waiting = { run: () => void }
  let active = 0
  const waiting: Waiting[] = []
  const pump = () => {
    while (active < SUBSET_CONCURRENCY && waiting.length) {
      const next = waiting.shift()!
      active++
      next.run()
    }
  }
  return <T>(load: () => T | Promise<T>, signal: AbortSignal, canceled: () => T | Promise<T>): Promise<T> => {
    if (signal.aborted) return Promise.resolve().then(canceled)
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const index = waiting.indexOf(item)
        if (index < 0) return
        waiting.splice(index, 1)
        signal.removeEventListener('abort', cancel)
        Promise.resolve().then(canceled).then(resolve, reject)
      }
      const item: Waiting = { run: () => {
        signal.removeEventListener('abort', cancel)
        Promise.resolve().then(() => signal.aborted ? canceled() : load()).then(resolve, reject).finally(() => { active--; pump() })
      } }
      waiting.push(item)
      signal.addEventListener('abort', cancel, { once: true })
      pump()
    })
  }
}
