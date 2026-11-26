import { describe, expect, it } from 'vitest'
import type { Markup, PieceResult, Scope } from '@redbeam/domain'
import { bomScopeFilter, perAreaCounts } from './agentBom.js'

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
