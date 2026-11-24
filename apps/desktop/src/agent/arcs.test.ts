import { describe, expect, it } from 'vitest'
import { regionArea } from '@redbeam/domain'
import { arcPoints, circleRing, expandRing } from './arcs.js'

const page = { width: 1000, height: 500 }
const toPts = (r: Array<{ x: number; y: number }>) => r.map((p) => ({ x: p.x * page.width, y: p.y * page.height }))

describe('arcs', () => {
  it('a bulge of 1 is a half circle through the right side', () => {
    // From (0.1, 0.5) to (0.1, 0.3) on a 1000x500 sheet: a 100 pt chord, radius 50.
    const pts = arcPoints({ x: 0.1, y: 0.5 }, { x: 0.1, y: 0.3 }, 1, page)
    expect(pts.length).toBeGreaterThan(10)
    for (const p of toPts(pts)) expect(Math.hypot(p.x - 100, p.y - 200)).toBeCloseTo(50, 3)
  })
  it('a stadium (rounded-end room) has the true area', () => {
    // 200 x 100 pt rectangle with half circles on both short ends: 200*100 + pi*50^2.
    const ring = expandRing([
      { x: 0.1, y: 0.2 }, { x: 0.3, y: 0.2, bulge: -1 },
      { x: 0.3, y: 0.4 }, { x: 0.1, y: 0.4, bulge: -1 },
    ], page, true)!
    const area = Math.abs(regionArea([toPts(ring)]))
    expect(Math.abs(area / (200 * 100 + Math.PI * 50 * 50) - 1)).toBeLessThan(0.001)
  })
  it('a circle is round in points, whatever the page proportions', () => {
    const ring = circleRing({ cx: 0.5, cy: 0.5, r: 0.02 }, page)
    for (const p of toPts(ring)) expect(Math.hypot(p.x - 500, p.y - 250)).toBeCloseTo(20, 3)
  })
})
