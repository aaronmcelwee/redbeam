import { describe, expect, it } from 'vitest'
import { openFor, scopeStage, summaryLabel, summaryToTsv } from './scopeSummary.js'

describe('the scope stage', () => {
  it('opens a new scope on Setup', () => {
    expect(scopeStage({ takingOff: false, markups: 0, missing: 0 })).toBe('setup')
    expect(scopeStage({ takingOff: false, markups: 0, missing: 2 })).toBe('setup')
  })

  it('stays on Setup while a required measure is blank, even with markups', () => {
    expect(scopeStage({ takingOff: false, markups: 4, missing: 1 })).toBe('setup')
  })

  it('is Take off whenever takeoff mode is on for the scope', () => {
    expect(scopeStage({ takingOff: true, markups: 0, missing: 2 })).toBe('takeoff')
    expect(scopeStage({ takingOff: true, markups: 4, missing: 0 })).toBe('takeoff')
  })

  it('is Review once takeoff is left with markups and nothing missing', () => {
    expect(scopeStage({ takingOff: false, markups: 4, missing: 0 })).toBe('review')
  })

  it('opens Setup first on Setup, Markups otherwise', () => {
    expect(openFor('setup', 0)).toEqual({ setup: true, markups: false })
    expect(openFor('setup', 3)).toEqual({ setup: true, markups: true })
    expect(openFor('takeoff', 3)).toEqual({ setup: false, markups: true })
    expect(openFor('review', 3)).toEqual({ setup: false, markups: true })
  })
})

describe('the summary copy', () => {
  it('is two columns, name and number, one line per row of the card', () => {
    const tsv = summaryToTsv([
      { label: 'Area', unit: 'SF', quantity: 391.8 },
      { label: 'Perimeter', unit: 'LF', quantity: 158.4 },
      { label: 'Panels 2′ 0″ × 2′ 0″', unit: 'EA', quantity: 110 },
      { label: 'Perimeter trim', unit: 'EA', quantity: 32 },
    ])
    expect(tsv).toBe('Area (SF)\t391.8\r\nPerimeter (LF)\t158.4\r\nPanels 2′ 0″ × 2′ 0″ (EA)\t110\r\nPerimeter trim (EA)\t32\r\n')
  })

  it('writes numbers a spreadsheet can add: no separators, two decimals at most', () => {
    expect(summaryToTsv([{ label: 'Area', unit: 'SF', quantity: 19968.4567 }])).toBe('Area (SF)\t19968.46\r\n')
  })

  it('leaves a quantity it cannot count empty, and keeps tabs out of the name', () => {
    expect(summaryToTsv([{ label: 'Panels\t4′', unit: 'EA', quantity: null }])).toBe('Panels 4′ (EA)\t\r\n')
  })

  it('names a line without a unit plainly', () => {
    expect(summaryLabel({ label: 'Parts', unit: '', quantity: 3 })).toBe('Parts')
  })
})
