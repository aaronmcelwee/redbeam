import { describe, expect, it } from 'vitest'
import { calculatePieces, type Markup, type Scope } from '@redbeam/domain'
import { pieceList } from './pieceList.js'

// A 1000 x 1000 pt sheet at 0.05 ft/pt: the area below is 20 ft x 10 ft.
const cal = { feetPerPoint: 0.05, pageWidth: 1000, pageHeight: 1000 }
const scope: Scope = {
  id: 's', label: 'Baffles', scopeType: 'area', color: '#000',
  specifications: {
    productType: 'baffle', spacing: '12', spacingUnit: 'in', stockLength: '96', stockLengthUnit: 'in',
    maxConnectorSpacing: '48', maxConnectorSpacingUnit: 'in',
  },
}
const outer = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.5, y: 0.3 }, { x: 0.1, y: 0.3 }]
// A 2 ft pendant ring cut out of the middle, as a square hole.
const hole = [{ x: 0.28, y: 0.18 }, { x: 0.32, y: 0.18 }, { x: 0.32, y: 0.22 }, { x: 0.28, y: 0.22 }]
const opts = { scopeDirection: [{ x: 0.1, y: 0.2 }, { x: 0.5, y: 0.2 }] as [{ x: number; y: number }, { x: number; y: number }], pageSize: { width: 1000, height: 1000 } }
const area = (rings: Markup['rings']): Markup[] => [{ id: 'a', scopeId: 's', documentId: 'd', pageId: 'p0', kind: 'area', rings }]

describe('pieceList', () => {
  it('lists every run and piece, and its cuts add up to the installed length', () => {
    const r = calculatePieces(scope, area([outer]), cal, opts)
    expect(r.blockers).toEqual([])
    const list = pieceList(r)
    expect(list.runs.length).toBeGreaterThanOrEqual(9)
    const fromRuns = list.runs.reduce((s, run) => s + run.pieces.reduce((t, p) => t + p.cutFeet, 0), 0)
    expect(fromRuns).toBeCloseTo(list.stock.installedFeet, 1)
    expect(list.cutList.reduce((s, c) => s + c.count, 0)).toBe(list.stock.piecesPlaced)
    // A 20 ft run of 8 ft stock is two full pieces and one cut to fit.
    expect(list.runs[0]!.lengthFeet).toBeCloseTo(20, 1)
    expect(list.runs[0]!.pieces.some((p) => p.cutToFit)).toBe(true)
  })

  it('flags runs longer than the stock and gives the stock that would run them whole', () => {
    const r = calculatePieces(scope, area([outer]), cal, opts)
    const over = pieceList(r).longerThanStock!
    expect(over.stockFeet).toBeCloseTo(8, 3)
    expect(over.runs).toBe(pieceList(r).runs.length)
    expect(over.longestFeet).toBeCloseTo(20, 1)
    expect(over.fitsWithoutJoints).toBe(20)
    // 20 ft of 8 ft stock is three pieces, two joints, on every run.
    expect(over.joints).toBe(over.runs * 2)
    const long = calculatePieces({ ...scope, specifications: { ...scope.specifications, stockLength: '25', stockLengthUnit: 'ft' } }, area([outer]), cal, opts)
    expect(pieceList(long).longerThanStock).toBeUndefined()
  })

  it('pages through runs with no cap: pages join up to the whole list', () => {
    const r = calculatePieces(scope, area([outer]), cal, opts)
    const all = pieceList(r).runs
    expect(pieceList(r).truncated).toBeUndefined()
    const first = pieceList(r, { maxRuns: 4 })
    expect(first.runs.length).toBe(4)
    expect(first.nextOffset).toBe(4)
    const rest = pieceList(r, { offset: first.nextOffset! })
    expect(rest.nextOffset).toBeUndefined()
    expect([...first.runs, ...rest.runs].map((x) => x.lengthFeet)).toEqual(all.map((x) => x.lengthFeet))
  })

  it('takes a cutout out of the members that cross it (round 3 #11)', () => {
    const whole = pieceList(calculatePieces(scope, area([outer]), cal, opts))
    const holed = pieceList(calculatePieces(scope, area([outer, hole]), cal, opts))
    // 2 ft of each run through the hole is not installed, and those runs come in two parts.
    expect(holed.stock.installedFeet).toBeLessThan(whole.stock.installedFeet - 2)
    expect(holed.stock.piecesPlaced).toBeGreaterThan(whole.stock.piecesPlaced)
  })
})

describe('cutouts with panel patterns', () => {
  it('leaves the panels under a cutout out', () => {
    const panels: Scope = { ...scope, specifications: { productType: 'panels', panelWidth: '24', panelWidthUnit: 'in', panelLength: '24', panelLengthUnit: 'in' } }
    const big = [{ x: 0.26, y: 0.16 }, { x: 0.34, y: 0.16 }, { x: 0.34, y: 0.24 }, { x: 0.26, y: 0.24 }]
    const n = (rings: Markup['rings']) => calculatePieces(panels, area(rings), cal, opts).quantities.find((q) => q.itemKey === 'panel_count')!.quantity
    expect(n([outer, big])).toBeLessThan(n([outer]))
  })
})
