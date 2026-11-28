import { describe, expect, it } from 'vitest'
import {
  checkPrimitiveDefinition, drawPrimitiveArea, formatPieceLength, layoutPrimitive, OPEN_CELL_EXAMPLE, splitRun,
  type PrimitiveGroup, type ScopePrimitive,
} from './primitives.js'

/**
 * 700 Bay St., Toronto (Maxxit PR 254209, SC-1): Aaron's acceptance test.
 * Three 18'x12' islands and one 15'x12', 6"x2" members, at 1:50.
 */
const FPP = 50 / 72 / 12 // feet per PDF point at 1:50
const island = (id: string, x0: number, y0: number, lengthIn: number, widthIn: number): PrimitiveGroup => {
  const L = lengthIn / 12 / FPP, W = widthIn / 12 / FPP
  return {
    pageId: 'ID-202', markupId: id, feetPerPoint: FPP, direction: { x: 1, y: 0 },
    region: [[{ x: x0, y: y0 }, { x: x0 + L, y: y0 }, { x: x0 + L, y: y0 + W }, { x: x0, y: y0 + W }]],
  }
}
const islands = [island('i1', 100, 100, 216, 144), island('i2', 500, 100, 216, 144), island('i3', 100, 400, 216, 144), island('i4', 500, 400, 180, 144)]

function bay(extra: Partial<ScopePrimitive> = {}, params: Record<string, unknown> = {}): ScopePrimitive {
  const check = checkPrimitiveDefinition(OPEN_CELL_EXAMPLE)
  if (!check.ok) throw new Error(check.errors.join('; '))
  return {
    definition: check.definition,
    parameters: { mainPositions: [8.875, 42.75, 103.25, 135.125], crossPositions: [8.875, 40.75, 108, 175.25, 207.125], ...params },
    areas: { i4: { crossPositions: [8.875, 40.75, 90, 139.25, 171.125] } },
    ...extra,
  }
}

describe('Parallel Open Cell primitive', () => {
  it('formats lengths as the shop writes them', () => {
    expect(formatPieceLength(108)).toBe("9'-0")
    expect(formatPieceLength(106)).toBe("8'-10")
    expect(formatPieceLength(58.5)).toBe('58-1/2in')
    expect(formatPieceLength(5.875)).toBe('5-7/8in')
    expect(splitRun(212, 120, 'centred')).toEqual([106, 106])
    expect(splitRun(212, 120, 'from origin')).toEqual([120, 92])
  })

  it('gives exactly the 700 Bay cut list from one scope, island 4 overriding crossPositions', () => {
    const out = layoutPrimitive(bay(), islands)
    expect(out.blockers).toEqual([])
    expect(Object.fromEntries(out.skus.map((s) => [s.sku, s.count]))).toEqual({
      "Frame main 9'-0 mitre 1 end": 12,
      "Frame main 7'-6 mitre 1 end": 4,
      "Frame end 6'-0 mitre 1 end": 16,
      "Main 8'-10": 24,
      "Main 7'-4": 8,
      'Cross 58-1/2in': 20,
      'Cross 31-7/8in': 20,
      'Cross 29-7/8in': 20,
      'Cross 5-7/8in': 40,
    })
    expect(out.skus).toHaveLength(9)
    expect(out.totalPieces).toBe(164)
    expect(out.totalLinearFeet).toBeGreaterThan(715)
    expect(out.totalLinearFeet).toBeLessThan(735)
    const hw = Object.fromEntries(out.hardware.map((h) => [h.key, h.qty]))
    expect(hw).toEqual({ seams: 32, crossings: 168, 'mitred-corners': 16 })
    expect(out.skus.find((s) => s.sku === "Main 8'-10")).toMatchObject({ lengthInches: 106, linearFeet: 212 })
  })

  it('is parametric: maxPiece 144 makes the 12\' frame ends single pieces mitred both ends, and fewer seams', () => {
    const out = layoutPrimitive(bay({}, { maxPiece: 144 }), islands)
    const by = Object.fromEntries(out.skus.map((s) => [s.sku, s.count]))
    expect(by["Frame end 12'-0 mitre 2 ends"]).toBe(8)
    expect(by["Frame end 6'-0 mitre 1 end"]).toBeUndefined()
    expect(out.hardware.find((h) => h.key === 'seams')!.qty).toBe(24)
  })

  it('takes the exact size from an area, and counts hangers when given a spacing', () => {
    const drawnOff = [island('a', 0, 0, 216.3, 143.8)]
    const p = bay({ areas: {} }, { hangerSpacing: 48 })
    const out = layoutPrimitive(p, drawnOff)
    expect(out.areas[0]!.used).toEqual({ length: 216, width: 144 })
    // 2 frame mains of 216 (6 each) + 4 mains of 212 (6 each)
    expect(out.hardware.find((h) => h.key === 'hangers')!.qty).toBe(36)
  })

  it('names the field and the reason when something is wrong', () => {
    const bad = checkPrimitiveDefinition({ name: 'x', generator: 'parallel_open_cell', parameters: { maxPeice: 120, frame: { default: 'round' } } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.errors.join('\n')).toMatch(/parameters\.maxPeice: not a parameter/)
      expect(bad.errors.join('\n')).toMatch(/parameters\.frame\.default: "round" is not one of none, square, mitred/)
    }
    const missing = layoutPrimitive({ ...bay(), parameters: {} }, islands.slice(0, 1))
    expect(missing.blockers[0]).toMatch(/^parameters\.mainPositions: required/)
    const outside = layoutPrimitive(bay({ areas: { i1: { mainPositions: [8.875, 143] } } }), islands.slice(0, 1))
    expect(outside.blockers[0]).toMatch(/area i1: mainPositions\[1\]: 143 in puts the member outside the frame/)
    expect(checkPrimitiveDefinition({ name: 'x', generator: 'grid' }).ok).toBe(false)
  })

  it('refuses an area that is not a rectangle square to the mains', () => {
    const tri: PrimitiveGroup = { ...islands[0]!, region: [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }]] }
    expect(layoutPrimitive(bay({ areas: {} }), [tri]).blockers[0]).toMatch(/not a rectangle/)
  })

  it('runs mains top to bottom at 90 degrees, positions from the left', () => {
    const tall: PrimitiveGroup = { ...island('t', 0, 0, 144, 216), direction: { x: 0, y: 1 } }
    const out = layoutPrimitive(bay({ areas: {} }), [tall])
    expect(out.blockers).toEqual([])
    expect(out.totalPieces).toBe(41)
    expect(out.areas[0]!.used).toEqual({ length: 216, width: 144 })
  })

  it('draws one island for the viewer: its pieces, seams and hangers in its own frame', () => {
    const d = drawPrimitiveArea(bay({}, { hangerSpacing: 48 }), 'i4', { length: 180, width: 144 })
    expect(d.errors).toEqual([])
    expect(d.pieces).toHaveLength(41)
    const layout = layoutPrimitive(bay({ areas: { i4: bay().areas!['i4']! } }, { hangerSpacing: 48 }), [islands[3]!])
    expect(d.seams).toHaveLength(layout.hardware.find((h) => h.key === 'seams')!.qty)
    expect(d.hangers).toHaveLength(layout.hardware.find((h) => h.key === 'hangers')!.qty)
    // Every hanger sits on a member, inside the island.
    for (const [a, c] of d.hangers) { expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThanOrEqual(180); expect(c).toBeLessThanOrEqual(144) }
    // Hangers pulled in from the ends: same spacing rule, none at the very end.
    const inset = drawPrimitiveArea(bay({}, { hangerSpacing: 48, hangerFromEnd: 6 }), 'i4', { length: 180, width: 144 })
    expect(inset.hangers.some(([a]) => a === 0)).toBe(false)
    expect(inset.hangers.some(([a]) => Math.abs(a - 6) < 1e-9)).toBe(true)
    // Without a size, one that holds every centreline.
    const typical = drawPrimitiveArea(bay({ areas: {} }), null)
    expect(typical.length).toBeCloseTo(207.125 + 8.875)
    expect(typical.errors).toEqual([])
  })
})
