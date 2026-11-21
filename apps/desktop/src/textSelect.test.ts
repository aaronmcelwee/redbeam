import { describe, expect, it } from 'vitest'
import { wordsAsText, wordsInBox } from './textSelect'

// "NOTE 2 ACT-1 CEILING" plotted out of order: line two first, then line one.
const text = 'ACT-1 CEILING NOTE 2 TAG'
const runs = [
  { start: 0, length: 5, x0: 0.10, y0: 0.20, x1: 0.15, y1: 0.22 },  // ACT-1 (line 2)
  { start: 6, length: 7, x0: 0.16, y0: 0.20, x1: 0.24, y1: 0.22 },  // CEILING (line 2)
  { start: 14, length: 4, x0: 0.10, y0: 0.17, x1: 0.14, y1: 0.19 }, // NOTE (line 1)
  { start: 19, length: 1, x0: 0.15, y0: 0.171, x1: 0.16, y1: 0.191 }, // 2 (line 1, a hair lower)
  { start: 21, length: 3, x0: 0.80, y0: 0.80, x1: 0.83, y1: 0.82 },  // TAG, far away
]

describe('text selection', () => {
  it('takes the words whose centre is in the box, corners in any order', () => {
    const w = wordsInBox(text, runs, { x0: 0.3, y0: 0.3, x1: 0.05, y1: 0.1 })
    expect(w.map((x) => x.text).sort()).toEqual(['2', 'ACT-1', 'CEILING', 'NOTE'])
  })
  it('reads them back as lines, top to bottom and left to right', () => {
    const w = wordsInBox(text, runs, { x0: 0, y0: 0, x1: 0.5, y1: 0.5 })
    expect(wordsAsText(w)).toBe('NOTE 2\nACT-1 CEILING')
  })
  it('is empty for an empty box', () => {
    expect(wordsAsText(wordsInBox(text, runs, { x0: 0.5, y0: 0.5, x1: 0.6, y1: 0.6 }))).toBe('')
  })
})
