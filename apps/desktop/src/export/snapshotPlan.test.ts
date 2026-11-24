import { describe, expect, it } from 'vitest'
import { calculatePieces, type Calibration, type Markup, type Scope } from '@redbeam/domain'
import { SNAPSHOT_FRAME, SNAPSHOT_MIN } from './snapshotPages.js'
import { pageIndexOf, planSnapshots, scaleBarFeet, type PlanPieces, type PlanSheet } from './snapshotPlan.js'

const SIDE = 1000 // every test sheet is 1000 x 1000 points

const panels: Scope = {
  id: 's1', label: 'CL03', scopeType: 'area', color: '#2B6CB0',
  specifications: {
    productType: 'panels', panelWidth: '2', panelWidthUnit: 'ft', panelLength: '4', panelLengthUnit: 'ft',
    perimeterTrimLength: '10', perimeterTrimLengthUnit: 'ft',
    scopeDefaultDirection: { x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, sourcePage: 0 },
  },
}

/** A rectangle `w` by `h` feet at (x, y) feet, on a sheet at `fpp` feet per point. */
const rect = (x: number, y: number, w: number, h: number, fpp: number) => {
  const n = (feet: number) => feet / fpp / SIDE
  return [{ x: n(x), y: n(y) }, { x: n(x + w), y: n(y) }, { x: n(x + w), y: n(y + h) }, { x: n(x), y: n(y + h) }]
}
const area = (id: string, pageId: string, ring: Array<{ x: number; y: number }>, scopeId = 's1'): Markup =>
  ({ id, scopeId, documentId: pageId.replace(/-p\d+$/, ''), pageId, kind: 'area', rings: [ring] })

/** Lay a scope out the way the workspace does, each sheet at its own scale. */
function laidOut(scope: Scope, markups: Markup[], fpps: Record<string, number>): PlanPieces {
  const calibrations = new Map<string, Calibration>(Object.entries(fpps).map(([p, f]) => [p, { feetPerPoint: f, pageWidth: SIDE, pageHeight: SIDE }]))
  const result = calculatePieces(scope, markups, [...calibrations.values()][0]!, {
    scopeDirection: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }],
    pageSize: { width: SIDE, height: SIDE },
    calibrations,
    pageSizes: new Map([...calibrations.keys()].map((p) => [p, { width: SIDE, height: SIDE }])),
    defaultPatternCorner: 'top-left',
  })
  expect(result.blockers).toEqual([])
  const trim = result.quantities.find((q) => q.itemKey === 'perimeter_trim')
  return { scopeId: scope.id, cells: result.cells, runs: result.runs, ...(trim !== undefined ? { trimLengthFeet: 10 } : {}) }
}

const plan = (markups: Markup[], pieces: PlanPieces[], sheets: Record<string, number | null>) => planSnapshots({
  scopes: [{ id: 's1', label: 'CL03', color: '#2B6CB0' }, { id: 's2', label: 'CL04', color: '#C05621' }],
  markups,
  pieces,
  sheet: (pageId): PlanSheet | null => (pageId in sheets ? { width: SIDE, height: SIDE, feetPerPoint: sheets[pageId]! } : null),
  sheetLabelFor: (pageId) => `Sheet ${pageIndexOf(pageId)}`,
  frame: SNAPSHOT_FRAME,
  minPicture: SNAPSHOT_MIN,
})

describe('pageIndexOf', () => {
  it('reads the zero-based page off a page id', () => {
    expect(pageIndexOf('doc-1-p0')).toBe(0)
    expect(pageIndexOf('d1-p12')).toBe(12)
    expect(pageIndexOf('nonsense')).toBeNull()
  })
})

describe('planSnapshots', () => {
  it('prints rooms drawn at different scales at one scale, so they compare', () => {
    // The same 30' x 20' room on a 1/8" sheet and on a 1/4" one.
    const markups = [area('a', 'd-p0', rect(10, 10, 30, 20, 1 / 9)), area('b', 'd-p1', rect(10, 10, 30, 20, 1 / 18))]
    const { cards, base } = plan(markups, [], { 'd-p0': 1 / 9, 'd-p1': 1 / 18 })
    expect(cards).toHaveLength(2)
    expect(cards[0]!.scale).toBe(base)
    expect(cards[1]!.scale).toBe(base)
    expect(cards[0]!.width).toBeCloseTo(cards[1]!.width, 6)
    expect(cards[0]!.quantity?.value).toBeCloseTo(600, 6)
    expect(cards[1]!.quantity?.value).toBeCloseTo(600, 6)
  })

  it('prints a closet larger than the hall, at one detail scale', () => {
    const markups = [area('hall', 'd-p0', rect(5, 5, 100, 60, 1 / 9)), area('closet', 'd-p0', rect(5, 80, 3, 3, 1 / 9))]
    const { cards, base, detail } = plan(markups, [], { 'd-p0': 1 / 9 })
    const hall = cards.find((c) => c.id.includes('hall'))!
    const closet = cards.find((c) => c.id.includes('closet'))!
    expect(hall.scale).toBe(base)
    expect(closet.scale).toBe(detail)
    expect(detail!.pointsPerFoot).toBeGreaterThan(base!.pointsPerFoot)
  })

  it('says a sheet with no scale is not to scale, with no quantity', () => {
    const { cards, base } = plan([area('a', 'd-p0', rect(10, 10, 30, 20, 1 / 9))], [], { 'd-p0': null })
    expect(cards[0]!.scale).toBeNull()
    expect(cards[0]!.quantity).toBeNull()
    expect(base).toBeNull()
  })

  it('leaves out takeoff on a sheet it cannot size, and takeoff of other scopes', () => {
    const markups = [area('a', 'd-p0', rect(10, 10, 30, 20, 1 / 9)), area('b', 'd-p7', rect(10, 10, 30, 20, 1 / 9)), area('c', 'd-p0', rect(50, 10, 5, 5, 1 / 9), 'other')]
    expect(plan(markups, [], { 'd-p0': 1 / 9 }).cards.map((c) => c.id)).toEqual(['area-a'])
  })
})

describe('perimeter trim on an area', () => {
  it('draws the lengths the takeoff counts: each edge from its corner, the last cut to fit', () => {
    // 25' and 12' sides at 10' lengths: 3 + 2 + 3 + 2.
    const markups = [area('a', 'd-p0', rect(10, 10, 25, 12, 1 / 9))]
    const pieces = laidOut(panels, markups, { 'd-p0': 1 / 9 })
    const card = plan(markups, [pieces], { 'd-p0': 1 / 9 }).cards[0]!
    expect(card.trim?.pieces).toBe(10)
    // A joint inside each edge wherever one length meets the next; the corners need none.
    expect(card.trim?.joints).toHaveLength(6)
    const first = card.trim!.joints.map((j) => j.at)
    // The first joint is 10' along the top edge from its corner.
    expect(first.some((p) => Math.abs(p.x - (20 * 9) / SIDE) < 1e-9 && Math.abs(p.y - (10 * 9) / SIDE) < 1e-9)).toBe(true)
  })

  it('matches the count in the quantities, sheet by sheet at each scale', () => {
    const markups = [area('a', 'd-p0', rect(10, 10, 25, 12, 1 / 9)), area('b', 'd-p1', rect(10, 10, 25, 12, 1 / 18))]
    const scope = { ...panels }
    const pieces = laidOut(scope, markups, { 'd-p0': 1 / 9, 'd-p1': 1 / 18 })
    const calibrations = new Map<string, Calibration>([
      ['d-p0', { feetPerPoint: 1 / 9, pageWidth: SIDE, pageHeight: SIDE }],
      ['d-p1', { feetPerPoint: 1 / 18, pageWidth: SIDE, pageHeight: SIDE }],
    ])
    const counted = calculatePieces(scope, markups, calibrations.get('d-p0')!, {
      scopeDirection: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }], pageSize: { width: SIDE, height: SIDE }, calibrations,
      pageSizes: new Map([['d-p0', { width: SIDE, height: SIDE }], ['d-p1', { width: SIDE, height: SIDE }]]), defaultPatternCorner: 'top-left',
    }).quantities.find((q) => q.itemKey === 'perimeter_trim')!.quantity
    const drawn = plan(markups, [pieces], { 'd-p0': 1 / 9, 'd-p1': 1 / 18 }).cards.reduce((n, c) => n + (c.trim?.pieces ?? 0), 0)
    expect(drawn).toBe(counted)
    expect(drawn).toBe(20)
  })

  it('runs round a curve in one length and marks where a round room starts', () => {
    // A round room 20' across, drawn as 36 facets: one edge, 62.8' round, 7 lengths.
    const c = { x: 60, y: 60 }
    const ring = Array.from({ length: 36 }, (_, i) => ({
      x: (c.x + 10 * Math.cos((i * Math.PI) / 18)) * 9 / SIDE,
      y: (c.y + 10 * Math.sin((i * Math.PI) / 18)) * 9 / SIDE,
    }))
    const markups = [area('round', 'd-p0', ring)]
    const card = plan(markups, [laidOut(panels, markups, { 'd-p0': 1 / 9 })], { 'd-p0': 1 / 9 }).cards[0]!
    expect(card.trim?.pieces).toBe(7)
    expect(card.trim?.joints).toHaveLength(7)
  })

  it('draws no trim where the scope is not laid out or counts none', () => {
    const markups = [area('a', 'd-p0', rect(10, 10, 25, 12, 1 / 9))]
    expect(plan(markups, [{ scopeId: 's1', cells: [], runs: [], trimLengthFeet: 10 }], { 'd-p0': 1 / 9 }).cards[0]!.trim).toBeNull()
    const pieces = laidOut(panels, markups, { 'd-p0': 1 / 9 })
    const { trimLengthFeet: _, ...noTrim } = pieces
    expect(plan(markups, [noTrim], { 'd-p0': 1 / 9 }).cards[0]!.trim).toBeNull()
  })
})

describe('scaleBarFeet', () => {
  it('picks a round length near the target', () => {
    expect(scaleBarFeet(4.5)).toBe(10) // 1/16": 45 points
    expect(scaleBarFeet(18)).toBe(4) // 1/4": 72 points
  })
})
