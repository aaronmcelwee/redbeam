import { describe, expect, it } from 'vitest'
import { checkScale, statedScales } from './statedScale.js'

describe('statedScales', () => {
  it('reads architectural, engineering and metric scales, and the notes', () => {
    const text = [
      '1 REFLECTED CEILING PLAN', 'SCALE: 1/8" = 1\'-0"',
      '3 DETAIL', 'SCALE: 1 1/2″ = 1′-0″',
      'SITE PLAN 1" = 20\'',
      'ENLARGED 1:50',
      'SCALE: AS NOTED',
      'DATE 2026:11', 'REV 1/8/26',
    ].join('\n')
    const { scales, notes } = statedScales({ text })
    expect(scales.map((s) => s.presetId)).toEqual(['arch-1-8', null, 'eng-20', 'metric-50'])
    expect(scales[1]!.feetPerDrawingInch).toBeCloseTo(2 / 3, 6)
    expect(scales[0]!.feetPerPoint).toBeCloseTo(8 / 72, 9)
    expect(notes.map((n) => n.text)).toEqual(['SCALE: AS NOTED'])
  })
})

describe('checkScale', () => {
  it('says a written dimension agrees with 1/8" scale', () => {
    // 12'-6" at 1/8" = 1'-0" is 1.5625" on paper = 112.5 pt.
    const r = checkScale({ x: 0.1, y: 0.5 }, { x: 0.1 + 112.5 / 3456, y: 0.5 }, '12\'-6"', { width: 3456, height: 2592 }, 8 / 72)
    if ('error' in r) throw new Error(r.error)
    expect(r.impliedPresetId).toBe('arch-1-8')
    expect(r.agrees).toBe(true)
    const wrong = checkScale({ x: 0.1, y: 0.5 }, { x: 0.1 + 112.5 / 3456, y: 0.5 }, '12\'-6"', { width: 3456, height: 2592 }, 4 / 72)
    if ('error' in wrong) throw new Error(wrong.error)
    expect(wrong.agrees).toBe(false)
    expect(wrong.errorPercent).toBeCloseTo(-50, 1)
  })
})
