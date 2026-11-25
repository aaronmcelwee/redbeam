/** Which background PDFs are let go. */
import { describe, expect, it } from 'vitest'
import { IDLE_SLEEP_MS, sleepers } from './live.js'

const quiet = () => false

describe('background PDFs', () => {
  it('keeps the ones in use', () => {
    const live = [{ file: 'a', usedAt: 1000 }, { file: 'b', usedAt: 2000 }]
    expect(sleepers(live, { now: 3000, busy: quiet, held: quiet })).toEqual([])
  })
  it('lets go of one nobody has called for in a while, longest ago first', () => {
    const live = [{ file: 'b', usedAt: 5 }, { file: 'a', usedAt: 0 }, { file: 'c', usedAt: IDLE_SLEEP_MS - 10 }]
    expect(sleepers(live, { now: IDLE_SLEEP_MS + 5, busy: quiet, held: quiet })).toEqual(['a', 'b'])
  })
  it('has no limit on how many are live: twenty in use all stay', () => {
    const live = Array.from({ length: 20 }, (_, i) => ({ file: `f${i}`, usedAt: 1000 + i }))
    expect(sleepers(live, { now: 2000, busy: quiet, held: quiet })).toEqual([])
  })
  it('never lets go of a PDF a live session has, however long it has been quiet', () => {
    const live = [{ file: 'a', usedAt: 0 }, { file: 'b', usedAt: 0 }]
    expect(sleepers(live, { now: 100 * IDLE_SLEEP_MS, busy: quiet, held: (f) => f === 'a' })).toEqual(['b'])
  })
  it('never lets go of a PDF with a call running in it', () => {
    const live = [{ file: 'a', usedAt: 0 }, { file: 'b', usedAt: 0 }]
    expect(sleepers(live, { now: 10 * IDLE_SLEEP_MS, busy: (f) => f === 'a', held: quiet })).toEqual(['b'])
  })
})
