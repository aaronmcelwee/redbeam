/** Which background PDFs are let go. */
import { describe, expect, it } from 'vitest'
import { IDLE_SLEEP_MS, LIVE_LIMIT, sleepers } from './live.js'

const quiet = () => false

describe('background PDFs', () => {
  it('keeps the ones in use', () => {
    const live = [{ file: 'a', usedAt: 1000 }, { file: 'b', usedAt: 2000 }]
    expect(sleepers(live, { now: 3000, busy: quiet })).toEqual([])
  })
  it('lets go of one nobody has called for in a while', () => {
    const live = [{ file: 'a', usedAt: 0 }, { file: 'b', usedAt: IDLE_SLEEP_MS - 10 }]
    expect(sleepers(live, { now: IDLE_SLEEP_MS, busy: quiet })).toEqual(['a'])
  })
  it('past the limit, lets go of the ones used longest ago', () => {
    const live = Array.from({ length: LIVE_LIMIT + 2 }, (_, i) => ({ file: `f${i}`, usedAt: 1000 + i }))
    expect(sleepers(live, { now: 2000, busy: quiet })).toEqual(['f0', 'f1'])
  })
  it('never lets go of a PDF with a call running in it', () => {
    const live = Array.from({ length: LIVE_LIMIT + 1 }, (_, i) => ({ file: `f${i}`, usedAt: i }))
    expect(sleepers(live, { now: 10 * IDLE_SLEEP_MS, busy: (f) => f === 'f0' })).not.toContain('f0')
    expect(sleepers(live, { now: 100, busy: (f) => f === 'f0' })).toEqual(['f1'])
  })
})
