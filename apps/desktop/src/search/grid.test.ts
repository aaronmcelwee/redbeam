import { describe, expect, it } from 'vitest'
import { commonSpacing, detectGrid, dominantAngle, nearestCrossing } from './grid.js'

const PAGE = { width: 1000, height: 1000 }
/** Segments in points -> the flat normalized array requestGeometry gives. */
const flat = (segs: Array<[number, number, number, number]>) => segs.flatMap(([a, b, c, d]) => [a / 1000, b / 1000, c / 1000, d / 1000])
const ring = (x0: number, y0: number, x1: number, y1: number) => [[
  { x: x0 / 1000, y: y0 / 1000 }, { x: x1 / 1000, y: y0 / 1000 }, { x: x1 / 1000, y: y1 / 1000 }, { x: x0 / 1000, y: y1 / 1000 },
]]

/** A 24-point grid from x 100..340 and y 100..292, drawn one tile edge at a time. */
function tileGrid(step = 24, x0 = 100, y0 = 100, cols = 10, rows = 8): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = []
  for (let c = 0; c <= cols; c++) for (let r = 0; r < rows; r++) out.push([x0 + c * step, y0 + r * step, x0 + c * step, y0 + (r + 1) * step])
  for (let r = 0; r <= rows; r++) for (let c = 0; c < cols; c++) out.push([x0 + c * step, y0 + r * step, x0 + (c + 1) * step, y0 + r * step])
  return out
}

describe('detectGrid', () => {
  it('reads the module, lines and crossings of a grid drawn tile by tile', () => {
    const g = detectGrid(flat(tileGrid()), PAGE, { rings: ring(100, 100, 340, 292) })!
    expect(g).not.toBeNull()
    expect(g.angle).toBeCloseTo(0, 3)
    expect(g.moduleA).toBeCloseTo(24, 3)
    expect(g.moduleB).toBeCloseTo(24, 3)
    expect(g.linesA).toHaveLength(9)
    expect(g.linesB).toHaveLength(11)
    expect(g.crossings).toHaveLength(99)
    expect(g.doubleLines).toBe(false)
  })

  it('snaps to the nearest crossing', () => {
    const g = detectGrid(flat(tileGrid()), PAGE, { rings: ring(100, 100, 340, 292) })!
    const hit = nearestCrossing(g, { x: 0.131, y: 0.152 }, PAGE)!
    expect(hit.point.x * 1000).toBeCloseTo(124, 3)
    expect(hit.point.y * 1000).toBeCloseTo(148, 3)
  })

  it('reads double lines as one line at their centre', () => {
    const segs: Array<[number, number, number, number]> = []
    for (let i = 0; i <= 6; i++) {
      const x = 100 + i * 48
      segs.push([x - 1, 100, x - 1, 388], [x + 1, 100, x + 1, 388])
      const y = 100 + i * 48
      segs.push([100, y - 1, 388, y - 1], [100, y + 1, 388, y + 1])
    }
    const g = detectGrid(flat(segs), PAGE, { rings: ring(95, 95, 393, 393) })!
    expect(g.doubleLines).toBe(true)
    expect(g.bandWidth).toBeCloseTo(2, 3)
    expect(g.moduleA).toBeCloseTo(48, 3)
    expect(g.linesA).toHaveLength(7)
    expect(g.crossings).toHaveLength(49)
  })

  it('finds a rotated grid', () => {
    const a = 30 * Math.PI / 180
    const rot = ([x1, y1, x2, y2]: [number, number, number, number]): [number, number, number, number] => {
      const r = (x: number, y: number) => [500 + (x - 220) * Math.cos(a) - (y - 196) * Math.sin(a), 500 + (x - 220) * Math.sin(a) + (y - 196) * Math.cos(a)]
      const [p, q] = r(x1, y1), [s, t] = r(x2, y2)
      return [p!, q!, s!, t!]
    }
    const g = detectGrid(flat(tileGrid().map(rot)), PAGE, { box: { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 } })!
    expect(g.angle).toBeCloseTo(30, 1)
    expect(g.moduleA).toBeCloseTo(24, 2)
    expect(g.crossings).toHaveLength(99)
  })

  it('ignores short stray lines', () => {
    const segs = [...tileGrid(), [150, 150, 158, 150] as [number, number, number, number], [205, 170, 205, 176] as [number, number, number, number]]
    const g = detectGrid(flat(segs), PAGE, { rings: ring(100, 100, 340, 292) })!
    expect(g.linesA).toHaveLength(9)
    expect(g.linesB).toHaveLength(11)
  })

  it('keeps crossings inside the area only', () => {
    const g = detectGrid(flat(tileGrid()), PAGE, { rings: ring(100, 100, 220, 196) })!
    for (const c of g.crossings) {
      expect(c.x * 1000).toBeLessThanOrEqual(221.5)
      expect(c.y * 1000).toBeLessThanOrEqual(197.5)
    }
    expect(g.crossings).toHaveLength(6 * 5)
  })

  it('says null when there is no grid', () => {
    expect(detectGrid(flat([[0, 0, 10, 0]]), PAGE)).toBeNull()
  })
})

describe('helpers', () => {
  it('commonSpacing picks the repeating gap', () => {
    expect(commonSpacing([24, 24.1, 23.9, 10, 24])).toBeCloseTo(24, 1)
    expect(commonSpacing([])).toBeNull()
  })
  it('dominantAngle reads lines mod 90', () => {
    expect(dominantAngle([[{ x: 0, y: 0 }, { x: 0, y: 100 }], [{ x: 0, y: 0 }, { x: 100, y: 0 }]])).toBeCloseTo(0, 3)
  })
})
