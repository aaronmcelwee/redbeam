import { describe, expect, it } from 'vitest'
import { directionRegions, lineDirections } from './directions.js'

const PAGE = { width: 1000, height: 1000 }
const flat = (segs: Array<[number, number, number, number]>) => segs.flatMap(([a, b, c, d]) => [a / 1000, b / 1000, c / 1000, d / 1000])
const ring = (x0: number, y0: number, x1: number, y1: number) => [[
  { x: x0 / 1000, y: y0 / 1000 }, { x: x1 / 1000, y: y0 / 1000 }, { x: x1 / 1000, y: y1 / 1000 }, { x: x0 / 1000, y: y1 / 1000 },
]]
const areaOf = (rings: Array<Array<{ x: number; y: number }>>) => {
  let s = 0
  for (const r of rings) {
    let a = 0
    for (let i = 0; i < r.length; i++) { const p = r[i]!, q = r[(i + 1) % r.length]!; a += p.x * q.y - q.x * p.y }
    s += a / 2
  }
  return Math.abs(s) * 1e6
}

describe('directionRegions', () => {
  it('splits a field run two ways into two regions with their angles', () => {
    const segs: Array<[number, number, number, number]> = []
    // Left half 100..300: members across the sheet every 10 pt. Right half 300..500: members up it.
    for (let y = 105; y < 300; y += 10) segs.push([100, y, 300, y])
    for (let x = 305; x < 500; x += 10) segs.push([x, 100, x, 300])
    const r = directionRegions(flat(segs), PAGE, { rings: ring(100, 100, 500, 300) })!
    expect(r.directions.map((d) => Math.round(d.angle)).sort((a, b) => a - b)).toEqual([0, 90])
    expect(r.regions).toHaveLength(2)
    const across = r.regions.find((g) => Math.round(g.angle) === 0)!
    const up = r.regions.find((g) => Math.round(g.angle) === 90)!
    expect(across.share).toBeCloseTo(0.5, 1)
    expect(areaOf(across.polygons[0]!)).toBeCloseTo(200 * 200, -3)
    expect(Math.max(...across.polygons[0]![0]!.map((p) => p.x)) * 1000).toBeLessThanOrEqual(311)
    expect(Math.min(...up.polygons[0]![0]!.map((p) => p.x)) * 1000).toBeGreaterThanOrEqual(289)
  })

  it('reads chevron wings at their angles, counter-clockwise from across the sheet', () => {
    const segs: Array<[number, number, number, number]> = []
    // Left wing: lines rising to the right (45). Right wing: falling to the right (135).
    for (let k = -200; k < 200; k += 10) segs.push([100, 300 - k, 300, 100 - k])
    for (let k = -200; k < 200; k += 10) segs.push([300, 100 + k, 500, 300 + k])
    const r = directionRegions(flat(segs), PAGE, { rings: ring(100, 100, 500, 300) })!
    expect(r.regions).toHaveLength(2)
    const angles = r.regions.map((g) => Math.round(g.angle)).sort((a, b) => a - b)
    expect(angles).toEqual([45, 135])
  })

  it('leaves the area outline out and says null with no members', () => {
    const outline: Array<[number, number, number, number]> = [[100, 100, 500, 100], [500, 100, 500, 300], [500, 300, 100, 300], [100, 300, 100, 100]]
    expect(directionRegions(flat(outline), PAGE, { rings: ring(100, 100, 500, 300) })).toBeNull()
  })

  it('one direction is one region', () => {
    const segs: Array<[number, number, number, number]> = []
    for (let y = 105; y < 300; y += 10) segs.push([100, y, 500, y])
    const r = directionRegions(flat(segs), PAGE, { rings: ring(100, 100, 500, 300) })!
    expect(r.regions).toHaveLength(1)
    expect(r.regions[0]!.share).toBe(1)
  })
})

describe('lineDirections', () => {
  it('ignores a direction with too little length', () => {
    const d = lineDirections([[{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 0, y: 0 }, { x: 0, y: 2 }]])
    expect(d).toHaveLength(1)
    expect(d[0]!.angle).toBeCloseTo(0, 3)
  })
})

describe('nestRings', () => {
  it('puts a hole with its outline and keeps two outlines apart', async () => {
    const { nestRings } = await import('./directions.js')
    const sq = (x0: number, y0: number, s: number) => [{ x: x0, y: y0 }, { x: x0 + s, y: y0 }, { x: x0 + s, y: y0 + s }, { x: x0, y: y0 + s }]
    const out = nestRings([sq(0, 0, 10), sq(20, 0, 10), sq(2, 2, 3)])
    expect(out).toHaveLength(2)
    expect(out[0]).toHaveLength(2)
    expect(out[1]).toHaveLength(1)
  })
})
