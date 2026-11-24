import { describe, expect, it } from 'vitest'
import { linesFromSegments, measurePoints } from './measure.js'

const page = { width: 1000, height: 500 }

describe('measurePoints', () => {
  it('measures a run in feet at the page scale', () => {
    const m = measurePoints([{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.2 }], page, { pageFeetPerPoint: 0.1 })
    expect(m.lengthPoints).toBe(300)
    expect(m.lengthFeet).toBe(30)
    expect(m.length).toBe(`30' - 0"`)
    expect(m.scaleSource).toBe('page')
  })

  it('gives the area of a closed shape', () => {
    const m = measurePoints([{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.1, y: 0.2 }, { x: 0, y: 0.2 }], page, { closed: true, pageFeetPerPoint: 0.5 })
    expect(m.areaSquarePoints).toBe(10000)
    expect(m.areaSquareFeet).toBe(2500)
    expect(m.lengthPoints).toBe(400)
  })

  it('uses a scale region over the page scale', () => {
    const regions = [{ id: 'r1', pageId: 'p', label: 'detail', feetPerPoint: 0.01, rect: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 } }]
    const m = measurePoints([{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }], page, { regions, pageFeetPerPoint: 1 })
    expect(m.lengthFeet).toBe(1)
    expect(m.scaleSource).toBe('region')
  })

  it('says points only when there is no scale', () => {
    const m = measurePoints([{ x: 0, y: 0 }, { x: 0.1, y: 0 }], page)
    expect(m.lengthFeet).toBeNull()
    expect(m.scaleSource).toBe('none')
    expect(m.warning).toMatch(/no scale/)
  })
})

describe('linesFromSegments', () => {
  it('lists lines longest first and drops short ones', () => {
    const r = linesFromSegments([0, 0, 0.1, 0, 0, 0, 0.5, 0, 0, 0, 0.001, 0], page, { feetPerPoint: 0.1, minLengthPoints: 5 })
    expect(r.total).toBe(2)
    expect(r.lines[0]!.lengthPoints).toBe(500)
    expect(r.lines[0]!.lengthFeet).toBe(50)
  })
})
