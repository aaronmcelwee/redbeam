import { describe, expect, it } from 'vitest'
import { areaRegion, regionArea, type Markup } from '@redbeam/domain'
import {
  cutEdits, cutoutsOf, cutRemoves, foldCutouts, isCutId, previewCut, recutEdits, uncutEdits, withCutouts,
} from './cutouts.js'

const sq = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
const mk = (id: string, kind: Markup['kind'], rings: Markup['rings'], scopeId = 's1', pageId = 'p0'): Markup =>
  ({ id, scopeId, documentId: 'd', pageId, kind, rings })
const apply = (markups: Markup[], edits: Array<{ id: string, after: Markup['rings'] }>) =>
  markups.map((m) => { const e = edits.find((x) => x.id === m.id); return e === undefined ? m : { ...m, rings: e.after } })

describe('the cutter', () => {
  const left = mk('a1', 'area', [sq(0.1, 0.1, 0.4, 0.4)])
  const right = mk('a2', 'area', [sq(0.4, 0.1, 0.7, 0.4)], 's2')
  const away = mk('a3', 'area', [sq(0.1, 0.6, 0.2, 0.7)])
  const across = sq(0.3, 0.2, 0.5, 0.3)

  it('cuts every area it crosses, whatever its scope, and no other', () => {
    const edits = cutEdits([left, right, away], 'p0', across)
    expect(edits.map((e) => e.id)).toEqual(['a1', 'a2'])
    expect(edits[0]!.after).toEqual([left.rings[0], across])
    expect(cutEdits([left], 'p1', across)).toEqual([])
  })

  it('shows one cutout for the same cut in two areas, and deleting it restores both', () => {
    const cut = apply([left, right, away], cutEdits([left, right, away], 'p0', across))
    const cutouts = cutoutsOf(cut)
    expect(cutouts).toHaveLength(1)
    expect(isCutId(cutouts[0]!.id)).toBe(true)
    expect(cutouts[0]!.kind).toBe('cutout')
    const restored = apply(cut, uncutEdits(cut, cutouts[0]!))
    expect(restored).toEqual([left, right, away])
    // An area deleted in the same gesture is not edited as well.
    expect(uncutEdits(cut, cutouts[0]!, new Set(['a1'])).map((e) => e.id)).toEqual(['a2'])
  })

  it('moves the cut with the area, and a moved area keeps its own cut', () => {
    const cut = apply([left, right], cutEdits([left, right], 'p0', across))
    const moved = cut.map((m) => m.id === 'a1' ? { ...m, rings: m.rings.map((r) => r.map((p) => ({ x: p.x, y: p.y + 0.3 }))) } : m)
    expect(regionArea(areaRegion(moved[0]!.rings))).toBeCloseTo(regionArea(areaRegion(cut[0]!.rings)), 12)
    expect(cutoutsOf(moved)).toHaveLength(2)
  })

  it('drags one cutout in every area it cuts', () => {
    const cut = withCutouts(apply([left, right], cutEdits([left, right], 'p0', across)))
    const id = cut.find((m) => isCutId(m.id))!.id
    const there = sq(0.35, 0.25, 0.45, 0.35)
    const live = previewCut(cut, id, there)
    expect(live.find((m) => m.id === 'a1')!.rings[1]).toEqual(there)
    expect(live.find((m) => m.id === 'a2')!.rings[1]).toEqual(there)
    const edits = recutEdits(live, live.find((m) => m.id === id)!, across, there)
    expect(edits.map((e) => [e.id, e.before[1], e.after[1]])).toEqual([['a1', across, there], ['a2', across, there]])
  })

  it('measures what a cutout takes out of its areas', () => {
    const cut = apply([left, right], cutEdits([left, right], 'p0', across))
    const removed = cutRemoves(cut, cutoutsOf(cut)[0]!, (r) => r.map((p) => ({ x: p.x * 100, y: p.y * 100 })))
    expect(removed).toBeCloseTo(20 * 10, 6)
  })

  it('folds old separate cutouts into the areas of their scope they open', () => {
    const old = mk('c1', 'cutout', [across])
    const stray = mk('c2', 'cutout', [sq(0.8, 0.8, 0.9, 0.9)])
    const { edits, folded } = foldCutouts([left, right, away, old, stray])
    expect(folded.map((c) => c.id)).toEqual(['c1'])
    expect(edits).toEqual([{ id: 'a1', before: left.rings, after: [left.rings[0], across] }])
  })
})
