import { describe, expect, it } from 'vitest'
import { checkOutline } from './outlineCheck.js'

const page = { width: 3370, height: 2384 }
const square = [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.4 }, { x: 0.2, y: 0.4 }]

describe('checkOutline', () => {
  it('passes a sound outline with a cutout inside it', () => {
    const hole = [{ x: 0.25, y: 0.25 }, { x: 0.25, y: 0.3 }, { x: 0.3, y: 0.3 }, { x: 0.3, y: 0.25 }]
    expect(checkOutline([square, hole], { page })).toEqual([])
  })

  it('flags corners clicked out of order (a bow tie)', () => {
    const bowTie = [{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }, { x: 0.4, y: 0.2 }, { x: 0.2, y: 0.4 }]
    const issues = checkOutline([bowTie], { page })
    expect(issues.map((i) => i.code)).toEqual(['self-crossing'])
    expect(issues[0]!.at!.x).toBeCloseTo(0.3, 4)
    expect(issues[0]!.at!.y).toBeCloseTo(0.3, 4)
  })

  it('finds a crossing in a long outline', () => {
    const ring = Array.from({ length: 2000 }, (_, i) => {
      const a = (i / 2000) * Math.PI * 2
      return { x: 0.5 + 0.2 * Math.cos(a), y: 0.5 + 0.2 * Math.sin(a) }
    })
    expect(checkOutline([ring], { page })).toEqual([])
    // Swap two points far apart: the outline now crosses itself.
    const bad = ring.slice()
    ;[bad[100], bad[900]] = [bad[900]!, bad[100]!]
    expect(checkOutline([bad], { page }).some((i) => i.code === 'self-crossing')).toBe(true)
  })

  it('flags points off the sheet and points in the title block', () => {
    expect(checkOutline([[{ x: 0.2, y: 0.2 }, { x: 1.3, y: 0.2 }, { x: 0.2, y: 0.4 }]], { page })[0]!.code).toBe('off-page')
    const titleBlock = { x0: 0.9, y0: 0, x1: 1, y1: 1 }
    const stray = [{ x: 0.2, y: 0.2 }, { x: 0.95, y: 0.2 }, { x: 0.2, y: 0.4 }]
    expect(checkOutline([stray], { page, notDrawing: [titleBlock] })[0]!.code).toBe('outside-drawing')
    expect(checkOutline([square], { page, drawingArea: { x0: 0.25, y0: 0, x1: 1, y1: 1 } })[0]!.code).toBe('outside-drawing')
  })

  it('flags a cutout outside its outline, crossing rings and a flat outline', () => {
    const outside = [{ x: 0.6, y: 0.6 }, { x: 0.7, y: 0.6 }, { x: 0.7, y: 0.7 }]
    expect(checkOutline([square, outside], { page }).map((i) => i.code)).toEqual(['cutout-outside'])
    const crossing = [{ x: 0.3, y: 0.3 }, { x: 0.5, y: 0.3 }, { x: 0.5, y: 0.35 }]
    expect(checkOutline([square, crossing], { page }).map((i) => i.code)).toContain('rings-cross')
    const flat = [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.2 }, { x: 0.4, y: 0.2 }]
    expect(checkOutline([flat], { page }).map((i) => i.code)).toEqual(['no-area'])
    expect(checkOutline([[{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }]], { page })[0]!.code).toBe('too-few-points')
  })
})
