import { describe, expect, it } from 'vitest'
import { AUTO_EMBED_MS, EMBED_MAX_WAIT_MS, EMBED_QUIET_MS, embedWhenQuiet, type Clock } from './autoEmbed.js'

function fakeClock() {
  let now = 0
  let timers: Array<{ at: number, fn: () => void, id: number }> = []
  let next = 1
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = next++; timers.push({ at: now + ms, fn, id }); return id },
    clearTimeout: (h) => { timers = timers.filter((t) => t.id !== h) },
  }
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (t === undefined || t.at > end) break
      timers.shift()
      now = t.at
      t.fn()
    }
    now = end
  }
  return { clock, advance, now: () => now }
}

describe('embedWhenQuiet', () => {
  it('saves once the change has settled and nobody is touching the window', () => {
    const { clock, advance } = fakeClock()
    let saves = 0
    embedWhenQuiet(() => { saves++ }, () => 60000, clock)
    advance(AUTO_EMBED_MS - 1)
    expect(saves).toBe(0)
    advance(1)
    expect(saves).toBe(1)
  })

  it('waits for a pause while the person is still drawing', () => {
    const f = fakeClock()
    let lastInput = 0
    let saves = 0
    embedWhenQuiet(() => { saves++ }, () => f.now() - lastInput, f.clock)
    // A click every second for twelve seconds.
    for (let s = 0; s < 12; s++) { lastInput = f.now(); f.advance(1000) }
    expect(saves).toBe(0)
    f.advance(EMBED_QUIET_MS)
    expect(saves).toBe(1)
  })

  it('never holds a change unsaved longer than the cap', () => {
    const f = fakeClock()
    let saves = 0
    embedWhenQuiet(() => { saves++ }, () => 0, f.clock)
    f.advance(EMBED_MAX_WAIT_MS - 1)
    expect(saves).toBe(0)
    f.advance(1)
    expect(saves).toBe(1)
  })

  it('does nothing once cancelled', () => {
    const f = fakeClock()
    let saves = 0
    const cancel = embedWhenQuiet(() => { saves++ }, () => 0, f.clock)
    f.advance(AUTO_EMBED_MS + 100)
    cancel()
    f.advance(EMBED_MAX_WAIT_MS)
    expect(saves).toBe(0)
  })
})
