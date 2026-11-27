import { describe, expect, it } from 'vitest'
import { polylineLength, regionArea } from '@redbeam/domain'
import { emptyDraft, type DraftState } from '../draw.js'
import { arcThrough, backCurvePoint, bulgeThrough, circleFrom, curveModeForKey, finishCurve, placeCurvePoint, previewCurve } from './curves.js'

const page = { width: 1000, height: 500 }
// Page points -> normalized, so tests can speak in points.
const n = (x: number, y: number) => ({ x: x / page.width, y: y / page.height })
const inPoints = (ring: Array<{ x: number; y: number }>) => ring.map((p) => ({ x: p.x * page.width, y: p.y * page.height }))
const mods = { ctrlKey: false, metaKey: false, altKey: false }

describe('three-point arcs', () => {
  it('a half circle through its top has bulge 1 one way and -1 the other', () => {
    // y down on the page: (200,100) is ABOVE the chord from (100,200) to (300,200).
    const up = bulgeThrough(n(100, 200), n(200, 100), n(300, 200), page)
    const down = bulgeThrough(n(100, 200), n(200, 300), n(300, 200), page)
    expect(Math.abs(up!)).toBeCloseTo(1, 6)
    expect(up! * down!).toBeLessThan(0)
  })

  it('every point lies on the circle and the arc passes the through point', () => {
    const a = n(100, 200), m = n(200, 100), b = n(300, 200)
    const pts = inPoints(arcThrough(a, m, b, page))
    for (const p of pts) expect(Math.hypot(p.x - 200, p.y - 200)).toBeCloseTo(100, 1)
    expect(pts[pts.length - 1]).toEqual({ x: 300, y: 200 })
    // The top of the half circle is on the arc, the bottom is not.
    expect(Math.min(...pts.map((p) => p.y))).toBeLessThan(100.1)
    expect(Math.max(...pts.map((p) => p.y))).toBeLessThanOrEqual(200 + 1e-6)
  })

  it('takes the long way round when the through point says so', () => {
    // Through a point near the start on the far side: three quarters of a circle.
    const pts = inPoints(arcThrough(n(300, 200), n(200, 300), n(200, 100), page))
    const len = polylineLength([{ x: 300, y: 200 }, ...pts], 1, 1)
    expect(len).toBeCloseTo((3 / 4) * 2 * Math.PI * 100, 0)
  })

  it('three points in a line are a straight segment', () => {
    expect(arcThrough(n(0, 0), n(50, 50), n(100, 100), page)).toEqual([n(100, 100)])
  })

  it('stays within a hundredth of a point of the true curve', () => {
    const pts = inPoints(arcThrough(n(100, 200), n(200, 100), n(300, 200), page))
    const all = [{ x: 100, y: 200 }, ...pts]
    for (let i = 1; i < all.length; i++) {
      const mx = (all[i - 1]!.x + all[i]!.x) / 2, my = (all[i - 1]!.y + all[i]!.y) / 2
      expect(100 - Math.hypot(mx - 200, my - 200)).toBeLessThan(0.0101)
    }
  })
})

describe('circles', () => {
  it('a circle from its centre and edge has the area of the circle, round on a non-square page', () => {
    const ring = circleFrom(n(500, 250), n(500, 150), page)
    expect(regionArea([inPoints(ring)]) / (Math.PI * 100 * 100)).toBeCloseTo(1, 3)
  })
})

describe('placing clicks', () => {
  it('A arcs one segment, then the trace is straight again', () => {
    let d: DraftState = { ...emptyDraft('area'), mode: 'arc' }
    d = placeCurvePoint(d, n(100, 200), page).draft
    expect(d.points).toHaveLength(1)
    d = placeCurvePoint(d, n(200, 100), page).draft
    expect(d.pivot).toEqual(n(200, 100))
    expect(d.points).toHaveLength(1)
    d = placeCurvePoint(d, n(300, 200), page).draft
    expect(d.points.length).toBeGreaterThan(10)
    expect(d.mode).toBe('line')
    expect(d.pivot).toBeUndefined()
    d = placeCurvePoint(d, n(300, 300), page).draft
    expect(d.points[d.points.length - 1]).toEqual(n(300, 300))
  })

  it('Backspace takes back a whole arc, then a through point', () => {
    let d: DraftState = emptyDraft('polyline')
    d = placeCurvePoint(d, n(100, 200), page).draft
    d = { ...d, mode: 'arc' }
    d = placeCurvePoint(d, n(200, 100), page).draft
    d = placeCurvePoint(d, n(300, 200), page).draft
    d = backCurvePoint(d)
    expect(d.points).toEqual([n(100, 200)])
    d = { ...d, mode: 'arc' }
    d = placeCurvePoint(d, n(200, 100), page).draft
    d = backCurvePoint(d)
    expect(d.pivot).toBeUndefined()
    expect(d.points).toEqual([n(100, 200)])
  })

  it('a circle is finished on its second click and stays armed', () => {
    let d: DraftState = { ...emptyDraft('cutout'), mode: 'circle' }
    const first = placeCurvePoint(d, n(500, 250), page)
    expect(first.complete).toBe(false)
    d = first.draft
    const second = placeCurvePoint(d, n(560, 250), page)
    expect(second.complete).toBe(true)
    expect(second.draft.mode).toBe('circle')
    expect(second.draft.points.length).toBeGreaterThan(12)
  })

  it('a Linear circle is closed: its length is the circumference', () => {
    let d: DraftState = { ...emptyDraft('polyline'), mode: 'circle' }
    d = placeCurvePoint(d, n(500, 250), page).draft
    d = placeCurvePoint(d, n(600, 250), page).draft
    expect(polylineLength(inPoints(d.points), 1, 1)).toBeCloseTo(2 * Math.PI * 100, 0)
  })

  it('Enter with an arc half placed closes the area along it', () => {
    let d: DraftState = emptyDraft('area')
    for (const p of [n(100, 200), n(100, 400), n(300, 400), n(300, 200)]) d = placeCurvePoint(d, p, page).draft
    d = { ...d, mode: 'arc' }
    d = placeCurvePoint(d, n(200, 100), page).draft
    const done = finishCurve(d, page)
    // A 200 x 200 square plus a half circle of radius 100 on top.
    expect(regionArea([inPoints(done.points)]) / (200 * 200 + (Math.PI * 100 * 100) / 2)).toBeCloseTo(1, 3)
    expect(done.points[done.points.length - 1]).not.toEqual(done.points[0])
  })

  it('the preview runs from the last point through the pivot to the cursor', () => {
    let d: DraftState = emptyDraft('area')
    d = placeCurvePoint(d, n(100, 200), page).draft
    d = { ...d, mode: 'arc', pivot: n(200, 100), cursor: n(300, 200) }
    expect(previewCurve(d, page).length).toBeGreaterThan(10)
  })
})

describe('keys', () => {
  it('A arcs only mid-trace; Shift+C circles only before one', () => {
    expect(curveModeForKey('a', mods, { points: [], mode: 'line' })).toBeNull()
    expect(curveModeForKey('a', mods, { points: [n(1, 1)], mode: 'line' })).toBe('arc')
    expect(curveModeForKey('a', mods, { points: [n(1, 1)], mode: 'arc' })).toBe('line')
    expect(curveModeForKey('a', { ...mods, ctrlKey: true }, { points: [n(1, 1)] })).toBeNull()
    expect(curveModeForKey('C', mods, { points: [] })).toBe('circle')
    expect(curveModeForKey('C', mods, { points: [n(1, 1)] })).toBeNull()
  })
})
