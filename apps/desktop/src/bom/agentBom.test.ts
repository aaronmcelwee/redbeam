import { describe, expect, it } from 'vitest'
import type { Markup, PieceResult, Scope } from '@redbeam/domain'
import { bomScopeFilter, collinearOverlap, fieldPerimeters, perAreaCounts } from './agentBom.js'

const scope = (id: string, label: string): Scope => ({ id, label, specifications: {} } as unknown as Scope)
const SCOPES = [scope('a', 'CL114 Clouds'), scope('b', 'CL115 Tiles'), scope('c', 'CL1150 Wood')]

describe('bomScopeFilter', () => {
  it('is everything when nothing is asked', () => {
    expect(bomScopeFilter({}, SCOPES)).toEqual({ ids: null })
  })
  it('takes ids', () => {
    expect(bomScopeFilter({ scopeId: 'a', scopeIds: ['b'] }, SCOPES)).toEqual({ ids: new Set(['a', 'b']) })
    expect(bomScopeFilter({ scopeId: 'zz' }, SCOPES)).toEqual({ error: 'no such scope: zz' })
  })
  it('matches a whole name before a part of one', () => {
    expect(bomScopeFilter({ scope: 'cl115 tiles' }, SCOPES)).toEqual({ ids: new Set(['b']) })
    expect(bomScopeFilter({ scope: 'CL115' }, SCOPES)).toEqual({ ids: new Set(['b', 'c']) })
    expect('error' in bomScopeFilter({ scope: 'nothing' }, SCOPES)).toBe(true)
  })
})

describe('perAreaCounts', () => {
  const m = (id: string, scopeId: string, kind: Markup['kind'], pageId = 'p1'): Markup =>
    ({ id, scopeId, documentId: 'd', pageId, kind, rings: [] })
  it('lays each area out alone with the cutouts on its sheet', () => {
    const seen: string[][] = []
    const layOut = (_s: Scope, ms: readonly Markup[]): PieceResult => {
      seen.push(ms.map((x) => x.id))
      return {
        productType: 'panels', cells: [], runs: [], blockers: [],
        quantities: [{ itemKey: 'panel_count', label: 'Panels', quantity: ms.length * 10, unit: 'EA' }],
      }
    }
    const out = perAreaCounts(
      [SCOPES[0]!],
      [m('a1', 'a', 'area'), m('a2', 'a', 'area', 'p2'), m('c1', 'a', 'cutout'), m('x', 'b', 'area')],
      layOut,
      (pid) => ({ page: pid === 'p1' ? 0 : 1, sheet: pid === 'p1' ? 'A1' : 'A2' }),
    )
    expect(seen).toEqual([['a1', 'c1'], ['a2']])
    expect(out.areas).toEqual([
      { scopeId: 'a', markupId: 'a1', page: 0, sheet: 'A1', counts: { panel_count: 20 } },
      { scopeId: 'a', markupId: 'a2', page: 1, sheet: 'A2', counts: { panel_count: 10 } },
    ])
    expect(out.items).toEqual({ panel_count: { label: 'Panels', unit: 'EA' } })
  })
  it('says why an area has no count', () => {
    const out = perAreaCounts([SCOPES[0]!], [m('a1', 'a', 'area')],
      () => ({ productType: 'panels', cells: [], runs: [], quantities: [], blockers: ['Panel W'] }),
      () => ({ page: 0, sheet: null }))
    expect(out.areas[0]!.blocked).toEqual(['Panel W'])
  })
})

describe('fieldPerimeters', () => {
  it('counts the frame round two chevron wings once, and the fold line on its own', () => {
    // Two 100 x 50 pt wings sharing the 50 pt edge at x = 200, on a 1000 pt page at 0.1 ft/pt.
    const sq = (x0: number) => [[{ x: x0 / 1000, y: 0.1 }, { x: (x0 + 100) / 1000, y: 0.1 }, { x: (x0 + 100) / 1000, y: 0.15 }, { x: x0 / 1000, y: 0.15 }]]
    const out = fieldPerimeters(
      [{ pageId: 'p', rings: sq(100) }, { pageId: 'p', rings: sq(200) }],
      () => ({ width: 1000, height: 1000 }), () => 0.1, () => ({ page: 0, sheet: 'A1' }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.framePoints).toBeCloseTo(500, 3)
    expect(out[0]!.frameFeet).toBeCloseTo(50, 3)
    expect(out[0]!.sharedFeet).toBeCloseTo(5, 3)
  })
  it('collinearOverlap ignores parallel edges apart', () => {
    expect(collinearOverlap({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 20, y: 0 })).toBeCloseTo(5)
    expect(collinearOverlap({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 3 }, { x: 10, y: 3 })).toBe(0)
  })
})
