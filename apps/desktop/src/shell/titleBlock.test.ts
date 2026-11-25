import { describe, expect, it } from 'vitest'
import type { TextRun } from '@redbeam/viewer'
import { isTinyBox, labelOf, labelsToWrite, parseRegions, readSheetName, textInBox } from './titleBlock.js'
import { buildSheetIndex } from './sheets.js'

/** A page built from words and their boxes, the way PDFium hands them over. */
function page(words: Array<[string, number, number, number, number]>): { text: string; runs: TextRun[] } {
  let text = ''
  const runs: TextRun[] = []
  for (const [t, x0, y0, x1, y1] of words) {
    runs.push({ start: text.length, length: t.length, x0, y0, x1, y1 })
    text += `${t}\n`
  }
  return { text, runs }
}

// The Newark AirTrain title block (Station 3, sheet A3001), boxes as PDFium reads them.
const newark = page([
  ['AIRTRAIN', 0.898, 0.6235, 0.918, 0.629],
  ['NEWARK', 0.920, 0.6235, 0.939, 0.629],
  // The title's words arrive AFTER the contract number in text order.
  ['EWR-154.945', 0.924, 0.902, 0.965, 0.911],
  ['A3001', 0.921, 0.9227, 0.962, 0.94],
  ['PLAN', 0.936, 0.670, 0.953, 0.678],
  ['OVERALL', 0.888, 0.670, 0.918, 0.679],
  ['SITE', 0.920, 0.670, 0.934, 0.679],
])
const regions = {
  number: { x0: 0.915, y0: 0.915, x1: 0.97, y1: 0.945 },
  title: { x0: 0.875, y0: 0.665, x1: 0.965, y1: 0.685 },
}

describe('reading the title block boxes', () => {
  it('reads the drawing number, not the contract number above it', () => {
    expect(readSheetName(newark, regions)).toEqual({ number: 'A3001', title: 'OVERALL SITE PLAN' })
  })

  it('puts a title back in reading order, line by line', () => {
    const p = page([
      ['DRAWINGS', 0.5, 0.21, 0.6, 0.23],
      ['INDEX', 0.3, 0.11, 0.4, 0.13],
      ['OF', 0.45, 0.11, 0.48, 0.13],
    ])
    expect(textInBox(p, { x0: 0.2, y0: 0.05, x1: 0.7, y1: 0.3 })).toBe('INDEX OF DRAWINGS')
  })

  it('takes the field label off when the box took it in too', () => {
    const p = page([
      ['Drawing', 0.1, 0.1, 0.2, 0.12], ['Number', 0.1, 0.13, 0.2, 0.15], ['IX0510', 0.3, 0.12, 0.5, 0.16],
      ['Title', 0.1, 0.3, 0.2, 0.32], ['INDEX', 0.3, 0.3, 0.4, 0.32], ['OF', 0.41, 0.3, 0.45, 0.32],
    ])
    expect(readSheetName(p, {
      number: { x0: 0, y0: 0.05, x1: 0.6, y1: 0.2 }, title: { x0: 0, y0: 0.25, x1: 0.6, y1: 0.35 },
    })).toEqual({ number: 'IX0510', title: 'INDEX OF' })
  })

  it('names nothing when the number box is empty, so the sheet keeps its other name', () => {
    expect(readSheetName(page([['COVER', 0.1, 0.1, 0.2, 0.12]]), regions)).toBeNull()
  })

  it('reads numbers only when no title box was drawn', () => {
    expect(readSheetName(newark, { number: regions.number, title: null })).toEqual({ number: 'A3001', title: '' })
  })

  it('accepts a box dragged in any direction', () => {
    expect(textInBox(newark, { x0: 0.97, y0: 0.945, x1: 0.915, y1: 0.915 })).toBe('A3001')
  })
})

describe('what goes into the PDF', () => {
  it('labels every page: the boxes first, then the file’s own label, else nothing', () => {
    const named = [{ number: 'IX0510', title: 'INDEX OF DRAWINGS' }, null, { number: 'A3001', title: '' }]
    expect(labelsToWrite(3, named, ['Cover', 'Legend', null])).toEqual(['IX0510 - INDEX OF DRAWINGS', 'Legend', 'A3001'])
  })

  it('writes no labels when the boxes read nothing anywhere', () => {
    expect(labelsToWrite(2, [null, null], ['A', 'B'])).toBeNull()
  })

  it('splits back into number and title when the file is opened again', () => {
    const label = labelOf({ number: 'IX0510', title: 'INDEX OF DRAWINGS' })
    const rows = buildSheetIndex({ pageCount: 1, shape: 'none', outline: [], labels: [label], takeoffPages: new Set() })
    expect([rows[0]!.rows[0]!.number, rows[0]!.rows[0]!.title]).toEqual(['IX0510', 'INDEX OF DRAWINGS'])
  })

  it('keeps the boxes through a save', () => {
    expect(parseRegions(JSON.stringify(regions))).toEqual(regions)
    expect(parseRegions(JSON.stringify({ number: regions.number }))).toEqual({ number: regions.number, title: null })
    expect(parseRegions('{"number":{"x0":2}}')).toBeNull()
    expect(parseRegions('not json')).toBeNull()
    expect(isTinyBox({ x0: 0.5, y0: 0.5, x1: 0.5005, y1: 0.6 })).toBe(true)
  })
})

describe('the sheet index', () => {
  it('lets the title block names beat the outline and the page labels', () => {
    const groups = buildSheetIndex({
      pageCount: 3, shape: 'per-sheet', takeoffPages: new Set(),
      outline: [0, 1, 2].map((p) => ({ title: 'EWR-154.945 NEWARK LIBERTY', page: p, children: [] })),
      labels: [null, null, null],
      named: [{ number: 'IX0510', title: 'INDEX OF DRAWINGS' }, null, { number: 'A3001', title: 'OVERALL SITE PLAN' }],
    })
    expect(groups[0]!.rows.map((r) => r.number)).toEqual(['IX0510', 'EWR-154.945', 'A3001'])
  })
})

describe('names set one sheet at a time', () => {
  it('beat what the boxes read, and keep the rest', async () => {
    const { mergeNames, parseOverrides } = await import('./titleBlock.js')
    const over = parseOverrides(JSON.stringify({ 1: { number: 'A3002', title: 'SITE PLAN' }, x: { number: 'bad' }, 5: { number: '' } }))
    expect([...over.keys()]).toEqual([1])
    expect(mergeNames(3, [{ number: 'IX0510', title: '' }, { number: 'EWR-154.945', title: '' }, null], over))
      .toEqual([{ number: 'IX0510', title: '' }, { number: 'A3002', title: 'SITE PLAN' }, null])
  })
})
