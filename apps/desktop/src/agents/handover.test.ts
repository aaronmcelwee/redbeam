/** An agent asking to work in a PDF the person has open themselves. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HandoverStore, REFUSAL_MS } from './handover.js'

const FILE = 'C:\\Jobs\\A.pdf'

describe('handover', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('puts the question up once, however many calls wait on it', async () => {
    const h = new HandoverStore()
    const one = h.ask(FILE, 'a', 5000)
    const two = h.ask('c:/jobs/a.pdf', 'a', 5000)
    expect(h.get()).toHaveLength(1)
    h.answer(FILE, 'a', true)
    expect(await one).toBe('yes')
    expect(await two).toBe('yes')
    expect(h.get()).toHaveLength(0)
  })
  it('answers "waiting" when the person has not, and leaves the question up', async () => {
    const h = new HandoverStore()
    const p = h.ask(FILE, 'a', 3000)
    vi.advanceTimersByTime(3001)
    expect(await p).toBe('waiting')
    expect(h.get()).toHaveLength(1)
  })
  it('remembers "Not now" for a while, for that agent and that PDF only', async () => {
    let now = 0
    const h = new HandoverStore(() => now)
    const p = h.ask(FILE, 'a', 3000)
    h.answer(FILE, 'a', false)
    expect(await p).toBe('no')
    // Told at once, with nothing put on screen again.
    expect(await h.ask(FILE, 'a', 3000)).toBe('no')
    expect(h.get()).toHaveLength(0)
    expect(h.isRefused(FILE, 'b')).toBe(false)
    expect(h.isRefused('C:\\Jobs\\B.pdf', 'a')).toBe(false)
    now = REFUSAL_MS + 1
    expect(h.isRefused(FILE, 'a')).toBe(false)
  })
  it('drops the questions of a closed tab and of a departed agent', async () => {
    const h = new HandoverStore()
    const p = h.ask(FILE, 'a', 5000)
    const q = h.ask('C:\\Jobs\\B.pdf', 'b', 5000)
    h.dropFile(FILE)
    h.dropAgent('b')
    expect(await p).toBe('no')
    expect(await q).toBe('no')
    expect(h.get()).toHaveLength(0)
    // Closing the tab is not a refusal of the agent.
    expect(h.isRefused(FILE, 'a')).toBe(false)
  })
  it('tells its readers when a question goes up and comes down', () => {
    const h = new HandoverStore()
    let n = 0
    h.subscribe(() => { n++ })
    void h.ask(FILE, 'a', 1000)
    void h.ask(FILE, 'a', 1000)
    h.answer(FILE, 'a', true)
    expect(n).toBe(2)
  })
})
