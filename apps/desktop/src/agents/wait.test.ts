import { describe, expect, it } from 'vitest'
import { nextTask, pause, until } from './wait.js'

describe('until', () => {
  // Counted in looks, not milliseconds: a busy CI runner can stall any test for longer than a poll.
  it('answers at once when the condition already holds', async () => {
    let looks = 0
    expect(await until(() => { looks++; return true }, 10_000)).toBe(true)
    expect(looks).toBe(1)
  })

  it('answers as soon as the condition holds, not a poll interval later', async () => {
    // What a write does: the state lands a task or two after the call.
    let there = false
    let looks = 0
    void nextTask().then(() => nextTask()).then(() => { there = true })
    expect(await until(() => { looks++; return there }, 10_000)).toBe(true)
    // One look per task: seen within a few tasks of landing, with no timer in between.
    expect(looks).toBeLessThanOrEqual(5)
  })

  it('keeps waiting past the eager spell for something slow', async () => {
    let there = false
    setTimeout(() => { there = true }, 120)
    expect(await until(() => there, 5_000)).toBe(true)
  })

  it('gives up when the time is up, and says so', async () => {
    const t0 = performance.now()
    expect(await until(() => false, 80)).toBe(false)
    const took = performance.now() - t0
    expect(took).toBeGreaterThanOrEqual(75)
    expect(took).toBeLessThan(400)
  })

  it('pause resolves', async () => {
    const t0 = performance.now()
    await pause(20)
    expect(performance.now() - t0).toBeGreaterThanOrEqual(15)
  })
})
