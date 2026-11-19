import { describe, expect, it } from 'vitest'
import { areaRegion, cutChanges, sameRing } from './cuts.js'
import { regionArea } from './geometry.js'
import { effectiveAreaRings, perimeterFeet, type Markup } from './scope.js'

const sq = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
const cal = { feetPerPoint: 1, pageWidth: 100, pageHeight: 100 }
const area = (id: string, rings: Markup['rings']): Markup => ({ id, scopeId: 's', documentId: 'd', pageId: 'p', kind: 'area', rings })

describe('cuts as part of the area', () => {
  it('measures the outline less its cuts, a cut across the edge as a notch', () => {
    const rings = [sq(0, 0, 10, 10), sq(2, 2, 4, 4), sq(8, 4, 14, 6)]
    expect(regionArea(areaRegion(rings))).toBeCloseTo(100 - 4 - 4, 9)
  })

  it('takes overlapping cuts out once', () => {
    expect(regionArea(areaRegion([sq(0, 0, 10, 10), sq(1, 1, 5, 5), sq(3, 3, 7, 7)]))).toBeCloseTo(100 - 16 - 16 + 4, 9)
  })

  it('leaves a plain outline exactly as drawn', () => {
    expect(areaRegion([sq(0, 0, 1, 1)])).toEqual([sq(0, 0, 1, 1)])
  })

  it('cuts only an area it changes and does not swallow', () => {
    expect(cutChanges([sq(0, 0, 1, 1)], sq(0.5, 0.5, 2, 2))).toBe(true)
    expect(cutChanges([sq(0, 0, 1, 1)], sq(2, 2, 3, 3))).toBe(false)
    expect(cutChanges([sq(0, 0, 1, 1)], sq(-1, -1, 2, 2))).toBe(false)
  })

  it('compares rings within a tolerance', () => {
    expect(sameRing(sq(0, 0, 1, 1), sq(0, 0, 1, 1.0000001))).toBe(true)
    expect(sameRing(sq(0, 0, 1, 1), sq(0, 0, 1, 1.1))).toBe(false)
  })

  it('totals two cut areas without filling a hole of one with the other', () => {
    const a = area('a', [sq(0, 0, 0.1, 0.1), sq(0.02, 0.02, 0.04, 0.04)])
    const b = area('b', [sq(0.2, 0, 0.3, 0.1)])
    expect(regionArea(effectiveAreaRings([a, b], cal))).toBeCloseTo(100 - 4 + 100, 6)
    expect(perimeterFeet([a], cal)).toBeCloseTo(40 + 8, 6)
  })
})
