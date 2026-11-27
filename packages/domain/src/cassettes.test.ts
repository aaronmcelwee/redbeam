import { describe, expect, it } from 'vitest'
import { cassettePieceList, cassetteQuantities, cassetteWidthAdvice, cassetteWidthProblem, layoutCassettes, lengthInside, readCassetteInputs, type CassetteInputs } from './cassettes.js'
import type { PanelLayoutGroup } from './panels.js'

// 1 ft = 10 pt. Cassettes run along x (their length), stack along y (their width).
const FPP = 0.1
const field = (wFt: number, hFt: number, hole?: [number, number, number, number]): PanelLayoutGroup => ({
  region: [
    [{ x: 0, y: 0 }, { x: wFt * 10, y: 0 }, { x: wFt * 10, y: hFt * 10 }, { x: 0, y: hFt * 10 }],
    ...(hole !== undefined ? [[
      { x: hole[0] * 10, y: hole[1] * 10 }, { x: hole[2] * 10, y: hole[1] * 10 },
      { x: hole[2] * 10, y: hole[3] * 10 }, { x: hole[0] * 10, y: hole[3] * 10 },
    ]] : []),
  ],
  directionLine: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
  origin: { x: 0, y: 0 },
  feetPerPoint: FPP,
})
const INPUTS: CassetteInputs = {
  widthFeet: 2, lengthFeet: 8, gapFeet: 0, spacingFeet: 0.5, stockLengthFeet: 8,
  yieldGranularity: 'full', removableShare: 0, trimLengthFeet: null,
}
const amounts = (groups: PanelLayoutGroup[], over: Partial<CassetteInputs> = {}) =>
  Object.fromEntries(cassetteQuantities(layoutCassettes(groups, { ...INPUTS, ...over }, { feetPerPoint: FPP })).map((q) => [q.itemKey, q.quantity]))

describe('cassettes, counted as built (#174)', () => {
  it('counts a field of whole modules as full cassettes', () => {
    // 8 ft x 20 ft: ten 2 ft x 8 ft modules, four baffles each.
    expect(amounts([field(8, 20)])).toMatchObject({
      cassette_count: 10, cassette_full: 10, baffle_count: 40, primary_stock: 40, end_caps: 80, installed_length: 320,
    })
    expect(amounts([field(8, 20)]).cassette_partial).toBeUndefined()
  })

  it('lists partial cassettes on their own and cuts their baffles to fit', () => {
    // 3 ft x 3 ft: two modules touched. The first holds four 3 ft baffles,
    // the second only the two whose lines are inside 3 ft. Counting every
    // touched module as full gave 2 x 4 = 8 whole baffles.
    const q = amounts([field(3, 3)])
    expect(q).toMatchObject({ cassette_count: 2, cassette_partial: 2, baffle_count: 6, baffle_cut: 6, installed_length: 18, end_caps: 12 })
    expect(q.cassette_full).toBeUndefined()
    // Each 3 ft cut is 3/8 of a stock: a whole stock at full yield, half at half, and so on.
    expect(q.primary_stock).toBe(6)
    expect(amounts([field(3, 3)], { yieldGranularity: 'half' }).primary_stock).toBe(3)
    expect(amounts([field(3, 3)], { yieldGranularity: 'quarter' }).primary_stock).toBe(3)
  })

  it('skips baffles that fall in a hole', () => {
    // A 2 ft x 2 ft hole through the middle of an 8 x 4 field.
    const q = amounts([field(8, 4, [3, 1, 5, 3])])
    expect(q.cassette_count).toBe(2)
    expect(q.cassette_partial).toBe(2)
    // Four baffles run whole; the four whose lines cross the hole are two 3 ft pieces each.
    expect(q.baffle_count).toBe(12)
    expect(q.baffle_cut).toBe(8)
    expect(q.installed_length).toBe(64 - 4 * 2)
  })

  it('reports cassettes by area beside the count, for a check', () => {
    expect(amounts([field(3, 3)]).cassette_by_area).toBe(0.6)
  })
})

describe('cassette inputs (#175)', () => {
  it('lays modules on a pitch that adds the gap', () => {
    // 2 ft modules with a 6" gap: 4.5 ft holds two whole modules.
    expect(amounts([field(8, 4.5)], { gapFeet: 0.5 })).toMatchObject({ cassette_count: 2, cassette_full: 2 })
    expect(amounts([field(8, 4.5)])).toMatchObject({ cassette_count: 3, cassette_full: 2, cassette_partial: 1 })
  })

  it('uses its own cassette length, not the stock length', () => {
    // 4 ft modules from 8 ft stock: two per stock at half yield.
    expect(amounts([field(8, 2)], { lengthFeet: 4, yieldGranularity: 'half' })).toMatchObject({
      cassette_count: 2, cassette_full: 2, baffle_count: 8, primary_stock: 4,
    })
  })

  it('rounds the removable share up to whole cassettes', () => {
    expect(amounts([field(8, 20)], { removableShare: 0.15 }).cassette_removable).toBe(2)
  })

  it('reads the new keys, and requires the cassette length', () => {
    const base = { spacing: '6', spacingUnit: 'in', stockLength: '8', stockLengthUnit: 'ft', cassetteWidth: '24', cassetteWidthUnit: 'in' }
    expect(readCassetteInputs(base)).toEqual({ missing: ['Cassette L'] })
    expect(readCassetteInputs({ ...base, cassetteLength: '8', cassetteLengthUnit: 'ft' })).toMatchObject({ lengthFeet: 8, gapFeet: 0, removableShare: 0, trimLengthFeet: null })
    expect(readCassetteInputs({ ...base, cassetteLength: '48', cassetteLengthUnit: 'in', cassetteGap: '1/2', cassetteGapUnit: 'in', removableShare: '10%' }))
      .toMatchObject({ lengthFeet: 4, gapFeet: 1 / 24, removableShare: 0.1 })
    expect(readCassetteInputs({ spacing: '6', spacingUnit: 'in' })).toEqual({ missing: ['Stock', 'Cassette W', 'Cassette L'] })
  })
})

describe('cassette width from the spacing (#176)', () => {
  it('suggests the whole multiples either side and warns', () => {
    const a = cassetteWidthAdvice(2, 7.5 / 12)
    expect(a.wholeMultiple).toBe(false)
    expect(a.bafflesPerCassette).toBe(3)
    expect(a.belowFeet * 12).toBeCloseTo(22.5)
    expect(a.aboveFeet * 12).toBeCloseTo(30)
    const layout = layoutCassettes([field(8, 20)], { ...INPUTS, spacingFeet: 7.5 / 12 }, { feetPerPoint: FPP })
    expect(layout.warnings[0]).toContain('22 1/2" or 30"')
  })

  it('refuses a width that is not a whole number of spacings', () => {
    const specs = { spacing: '7 1/2', spacingUnit: 'in', stockLength: '8', stockLengthUnit: 'ft', cassetteWidth: '24', cassetteWidthUnit: 'in', cassetteLength: '8', cassetteLengthUnit: 'ft' }
    expect(cassetteWidthProblem(specs)).toBe('Cassette W 24" is not a whole number of 7 1/2" spacings. Use 22 1/2" or 30".')
    expect(readCassetteInputs(specs)).toEqual({ missing: [cassetteWidthProblem(specs)] })
    expect(cassetteWidthProblem({ ...specs, cassetteWidth: '30' })).toBeNull()
    expect(readCassetteInputs({ ...specs, cassetteWidth: '30' })).toMatchObject({ widthFeet: 2.5 })
  })

  it('is quiet for a whole multiple', () => {
    expect(cassetteWidthAdvice(2.5, 7.5 / 12)).toMatchObject({ wholeMultiple: true, bafflesPerCassette: 4 })
    expect(layoutCassettes([field(8, 20)], INPUTS, { feetPerPoint: FPP }).warnings).toEqual([])
  })
})

describe('cassette outputs (#177)', () => {
  it('gives perimeter trim in feet, and in pieces only at a stated trim length', () => {
    expect(amounts([field(8, 20)])).toMatchObject({ perimeter_length: 56 })
    expect(amounts([field(8, 20)]).perimeter_trim).toBeUndefined()
    expect(amounts([field(8, 20)], { trimLengthFeet: 10 })).toMatchObject({ perimeter_length: 56, perimeter_trim: 6 })
  })

  it('lists full and partial cassettes and every cut', () => {
    const list = cassettePieceList(layoutCassettes([field(11, 3)], INPUTS, { feetPerPoint: FPP }))
    // Columns 0-8 ft and 8-16 ft; rows 0-2 ft and 2-4 ft.
    expect(list.full).toBe(1)
    expect(list.partial).toBe(3)
    expect(list.cutBaffles).toEqual([
      { length: "3'-0\"", feet: 3, count: 6, stockFraction: 1 },
    ])
    expect(list.partialTypes).toContainEqual({ count: 1, baffles: ['full', 'full'] })
    expect(list.partialTypes).toContainEqual({ count: 1, baffles: ["3'-0\"", "3'-0\""] })
    expect(list.installedFeet).toBe(66)
  })
})

describe('lengthInside', () => {
  it('measures the part of a line inside a region with a hole', () => {
    const r = field(10, 10, [4, 0, 6, 10]).region
    // The hole spans the field's height, so its rectangle is only a cut in x.
    expect(lengthInside({ x: -10, y: 50 }, { x: 110, y: 50 }, r)).toBeCloseTo(80)
  })
})
