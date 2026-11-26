import { describe, expect, it } from 'vitest'
import { detectPattern, linesFromSegments, measurePoints } from './measure.js'

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

describe('get_lines filters', () => {
  const pg = { width: 1000, height: 1000 }
  it('keeps only lines inside the box, by orientation and length, without duplicates', () => {
    const flat = [
      0.1, 0.1, 0.3, 0.1, // horizontal, 200 pt
      0.3, 0.1, 0.1, 0.1, // the same, drawn backwards
      0.1, 0.1, 0.1, 0.3, // vertical
      0.1, 0.5, 0.9, 0.5, // horizontal, crosses out of the box
      0.1, 0.2, 0.12, 0.2, // short
    ]
    const box = { x0: 0, y0: 0, x1: 0.5, y1: 0.4 }
    const r = linesFromSegments(flat, pg, { inside: box, orientation: 'horizontal', minLengthPoints: 50 })
    expect(r.lines).toHaveLength(1)
    expect(r.duplicatesRemoved).toBe(1)
    expect(r.lines[0]).toMatchObject({ x1: 0.1, x2: 0.3, angle: 0 })
    expect(linesFromSegments(flat, pg, { orientation: 'vertical' }).lines).toHaveLength(1)
    expect(linesFromSegments(flat, pg, { maxLengthPoints: 100, dedupe: false }).lines).toHaveLength(1)
    const byY = linesFromSegments(flat, pg, { sort: 'y', dedupe: true }).lines.map((l) => l.y1)
    expect(byY).toEqual([...byY].sort((a, b) => a - b))
  })
  /*
   * The takeoff benchmark (2026-11-25, Brock's bad corner): get_lines handed
   * back lines whose ends lay far outside the box asked about. The geometry
   * read keeps any segment that might touch the box, and a diagonal passing
   * near a corner, or a wall running the length of the sheet, came back whole.
   */
  it('cuts lines to the box and leaves out the ones that only pass near it', () => {
    const box = { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }
    const flat = [
      0, 0.5, 1, 0.5, // a wall right across the sheet
      0.45, 0.45, 0.55, 0.55, // wholly inside
      0.3, 0.65, 0.65, 0.3, // a diagonal that clips the corner
      0.2, 0.75, 0.75, 0.2, // a diagonal that passes outside the corner: both ends on different sides
    ]
    const r = linesFromSegments(flat, pg, { clipTo: box })
    expect(r.lines).toHaveLength(3)
    for (const l of r.lines) {
      for (const [x, y] of [[l.x1, l.y1], [l.x2, l.y2]] as const) {
        expect(x).toBeGreaterThanOrEqual(0.4 - 1e-6); expect(x).toBeLessThanOrEqual(0.6 + 1e-6)
        expect(y).toBeGreaterThanOrEqual(0.4 - 1e-6); expect(y).toBeLessThanOrEqual(0.6 + 1e-6)
      }
    }
    const wall = r.lines.find((l) => l.angle === 0)!
    expect(wall).toMatchObject({ x1: 0.4, x2: 0.6, lengthPoints: 200, cut: true })
    expect(r.lines.find((l) => l.angle === 45)!.cut).toBeUndefined()
  })

  it('keeps only lines at an angle', () => {
    const flat = [0, 0, 0.1, 0.1, 0, 0, 0.1, 0, 0.2, 0.2, 0.3, 0.31]
    expect(linesFromSegments(flat, pg, { angle: 45, angleTolerance: 1 }).lines).toHaveLength(1)
    expect(linesFromSegments(flat, pg, { angle: 225, angleTolerance: 3 }).lines).toHaveLength(2)
  })
})

describe('detectPattern', () => {
  const pg = { width: 1000, height: 1000 }
  it('reads spacing, member length, runs and rows from parallel members', () => {
    // 6 horizontal baffles 60 pt apart, two 200 pt members end to end on each line, each drawn with two faces 4 pt apart.
    const flat: number[] = []
    for (let i = 0; i < 6; i++) {
      const y = (100 + i * 60) / 1000
      for (const face of [0, 0.004]) {
        flat.push(0.1, y + face, 0.3, y + face)
        flat.push(0.31, y + face, 0.51, y + face)
      }
    }
    const r = detectPattern(flat, pg, { feetPerPoint: 0.1 })
    if ('error' in r) throw new Error(r.error)
    expect(r.direction).toBe('horizontal')
    expect(r.runs).toBe(6)
    expect(r.rows).toBe(2)
    expect(r.spacingPoints).toBeCloseTo(60, 1)
    expect(r.spacingFeet).toBeCloseTo(6, 2)
    expect(r.memberLengthPoints).toBeCloseTo(200, 1)
    expect(r.regularity).toBe(1)
  })

  it('tells beams from slabs when they are drawn differently (NOIC L7 breakroom)', () => {
    // 24 members 12 pt apart: every 4th a beam drawn as two faces 2.1 pt apart, slabs one line between.
    const flat: number[] = []
    for (let i = 0; i < 24; i++) {
      const y = 100 + i * 12
      if (i % 4 === 0) {
        flat.push(0.1, (y - 1.05) / 1000, 0.5, (y - 1.05) / 1000)
        flat.push(0.1, (y + 1.05) / 1000, 0.5, (y + 1.05) / 1000)
      } else flat.push(0.1, y / 1000, 0.5, y / 1000)
    }
    const r = detectPattern(flat, pg, { feetPerPoint: 0.1 })
    if ('error' in r) throw new Error(r.error)
    expect(r.runs).toBe(24)
    expect(r.spacingPoints).toBeCloseTo(12, 1)
    expect(r.memberTypes).toHaveLength(2)
    expect(r.memberTypes[0]).toMatchObject({ type: 'A', drawnAs: 'one line', count: 18 })
    expect(r.memberTypes[1]).toMatchObject({ type: 'B', drawnAs: 'faces', count: 6 })
    expect(r.memberTypes[1]!.faceWidthPoints).toBeCloseTo(2.1, 1)
    expect(r.repeat).toMatchObject({ every: 4, pattern: 'BAAA' })
  })

  it('reports one kind for a uniform field', () => {
    const flat: number[] = []
    for (let i = 0; i < 8; i++) flat.push(0.1, (100 + i * 20) / 1000, 0.5, (100 + i * 20) / 1000)
    const r = detectPattern(flat, pg, { feetPerPoint: 0.1 })
    if ('error' in r) throw new Error(r.error)
    expect(r.memberTypes).toHaveLength(1)
    expect(r.repeat).toBeUndefined()
    expect(r.spacingPoints).toBeCloseTo(20, 1)
  })
})
