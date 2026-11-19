import { describe, expect, it } from 'vitest'
import { areaRegion, regionArea, type Markup } from '@redbeam/domain'
import {
  cutEdits, cutoutsOf, cutRemoves, cutTarget, foldCutouts, isCutId, previewCut, recutEdits, uncutAllEdits,
  uncutEdits, withCutouts,
} from './cutouts.js'

const sq = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
const mk = (id: string, kind: Markup['kind'], rings: Markup['rings'], scopeId = 's1', pageId = 'p0'): Markup =>
  ({ id, scopeId, documentId: 'd', pageId, kind, rings })
const apply = (markups: Markup[], edits: Array<{ id: string, after: Markup['rings'] }>) =>
  markups.map((m) => { const e = edits.find((x) => x.id === m.id); return e === undefined ? m : { ...m, rings: e.after } })
const area = (rings: Markup['rings']) => regionArea(areaRegion(rings))

describe('the cutter, a one-shot cut per markup', () => {
  const left = mk('a1', 'area', [sq(0.1, 0.1, 0.4, 0.4)])
  const right = mk('a2', 'area', [sq(0.4, 0.1, 0.7, 0.4)], 's2')
  const away = mk('a3', 'area', [sq(0.1, 0.6, 0.2, 0.7)])
  const across = sq(0.3, 0.2, 0.5, 0.3)

  it('cuts every area it crosses, whatever its scope, each trimmed to its own edge', () => {
    const edits = cutEdits([left, right, away], 'p0', across)
    expect(edits.map((e) => e.id)).toEqual(['a1', 'a2'])
    const [l, r] = edits.map((e) => e.after)
    expect(area(l!)).toBeCloseTo(0.09 - 0.01, 9)
    expect(area(r!)).toBeCloseTo(0.09 - 0.01, 9)
    // The hole lies inside the area it belongs to.
    for (const p of l![1]!) expect(p.x).toBeLessThanOrEqual(0.4 + 1e-12)
    for (const p of r![1]!) expect(p.x).toBeGreaterThanOrEqual(0.4 - 1e-12)
    expect(cutEdits([left], 'p1', across)).toEqual([])
  })

  it('leaves one hole per area, each removed on its own', () => {
    const cut = apply([left, right, away], cutEdits([left, right, away], 'p0', across))
    const holes = cutoutsOf(cut)
    expect(holes.map((h) => h.id)).toEqual(['cut:a1:1', 'cut:a2:1'])
    expect(holes.every((h) => isCutId(h.id) && h.kind === 'cutout')).toBe(true)
    expect(cutTarget('cut:a1:1')).toEqual({ areaId: 'a1', index: 1 })
    const one = apply(cut, uncutEdits(cut, 'cut:a1:1'))
    expect(one.find((m) => m.id === 'a1')).toEqual(left)
    expect(one.find((m) => m.id === 'a2')!.rings).toHaveLength(2)
  })

  it('moves a hole only with its own area: nothing follows, nothing is copied', () => {
    const cut = apply([left, right], cutEdits([left, right], 'p0', across))
    const moved = cut.map((m) => m.id === 'a1' ? { ...m, rings: m.rings.map((r) => r.map((p) => ({ x: p.x, y: p.y + 0.3 }))) } : m)
    expect(area(moved[0]!.rings)).toBeCloseTo(area(cut[0]!.rings), 12)
    expect(moved[1]).toEqual(cut[1])
    expect(cutoutsOf(moved)).toHaveLength(2)
  })

  it('drags a hole within its own area only', () => {
    const cut = withCutouts(apply([left, right], cutEdits([left, right], 'p0', across)))
    const was = cut.find((m) => m.id === 'cut:a1:1')!.rings[0]!
    const there = sq(0.2, 0.2, 0.25, 0.25)
    const live = previewCut(cut, 'cut:a1:1', there)
    expect(live.find((m) => m.id === 'a1')!.rings[1]).toEqual(there)
    expect(live.find((m) => m.id === 'a2')).toEqual(cut.find((m) => m.id === 'a2'))
    const edits = recutEdits(live, 'cut:a1:1', was, there)
    expect(edits.map((e) => [e.id, e.before[1], e.after[1]])).toEqual([['a1', was, there]])
  })

  it('removes several holes of one area together', () => {
    const two = mk('a1', 'area', [sq(0, 0, 1, 1), sq(0.1, 0.1, 0.2, 0.2), sq(0.5, 0.5, 0.6, 0.6), sq(0.7, 0.7, 0.8, 0.8)])
    const edits = uncutAllEdits([two], ['cut:a1:1', 'cut:a1:3'])
    expect(edits).toHaveLength(1)
    expect(edits[0]!.after).toEqual([two.rings[0], two.rings[2]])
    expect(uncutAllEdits([two], ['cut:a1:1'], new Set(['a1']))).toEqual([])
  })

  it('measures what one hole takes out of its area', () => {
    const cut = apply([left, right], cutEdits([left, right], 'p0', across))
    expect(cutRemoves(cut, 'cut:a1:1', (r) => r.map((p) => ({ x: p.x * 100, y: p.y * 100 })))).toBeCloseTo(10 * 10, 6)
  })

  it('folds old separate cutouts into the areas of their scope they open, trimmed', () => {
    const old = mk('c1', 'cutout', [across])
    const stray = mk('c2', 'cutout', [sq(0.8, 0.8, 0.9, 0.9)])
    const { edits, folded } = foldCutouts([left, right, away, old, stray])
    expect(folded.map((c) => c.id)).toEqual(['c1'])
    expect(edits.map((e) => e.id)).toEqual(['a1'])
    expect(area(edits[0]!.after)).toBeCloseTo(0.09 - 0.01, 9)
  })
})
