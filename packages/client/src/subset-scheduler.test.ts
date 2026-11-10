import { describe, expect, it } from 'vitest'
import { subsetScheduler } from './subset-scheduler.js'

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('subset scheduler', () => {
  it('bounds concurrent snapshots across shapes and starts the next when one finishes', async () => {
    const schedule = subsetScheduler(), controller = new AbortController()
    const pending: (() => void)[] = []
    let active = 0, maximum = 0, started = 0
    const jobs = Array.from({ length: 40 }, () => schedule(() => {
      started++; active++; maximum = Math.max(maximum, active)
      return new Promise<void>(resolve => pending.push(() => { active--; resolve() }))
    }, controller.signal, () => undefined))
    await tick()
    expect(started).toBe(4)
    while (pending.length) { pending.shift()!(); await tick() }
    await Promise.all(jobs)
    expect(started).toBe(40)
    expect(maximum).toBe(4)
  })

  it('does not start an admitted load after its shape is cleaned up', async () => {
    const schedule = subsetScheduler(), shape = new AbortController()
    let started = false
    const canceled = schedule(() => { started = true; return true }, shape.signal, () => undefined)
    shape.abort()
    await canceled
    expect(started).toBe(false)
  })

  it('drops queued work on shape cleanup and passes real failures to callers', async () => {
    const schedule = subsetScheduler(), shape = new AbortController(), other = new AbortController()
    const pending: (() => void)[] = []
    const running = Array.from({ length: 4 }, () => schedule(() => new Promise<void>(resolve => pending.push(resolve)), other.signal, () => undefined))
    let started = false
    const canceled = schedule(() => { started = true; return true }, shape.signal, () => undefined)
    const failed = schedule(() => Promise.reject(new Error('HTTP 500')), other.signal, () => undefined)
    const failure = expect(failed).rejects.toThrow('HTTP 500')
    shape.abort()
    await canceled
    expect(started).toBe(false)
    await tick()
    pending.shift()!()
    await failure
    pending.forEach(resolve => resolve())
    await Promise.all(running)
    expect(started).toBe(false)
  })
})
