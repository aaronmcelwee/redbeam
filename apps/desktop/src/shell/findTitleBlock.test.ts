/**
 * NOIC Interior Fit-Up, 2026-11-26: about 150 of 171 sheets unnamed, and
 * others named after tags on the drawing ("CL201", "D6A", "C114", "PT210").
 * A tag moves from sheet to sheet; a title block does not.
 */
import { describe, expect, it } from 'vitest'
import { codeOf, findTitleBlock } from './findTitleBlock.js'
import { readSheetName } from './titleBlock.js'

type W = [string, number, number]
/** A sheet as PDFium gives it: text, and a run per word with its box. */
function sheet(ws: W[]) {
  let text = ''
  const runs = ws.map(([t, x, y]) => {
    const start = text.length
    text += `${t}\n`
    return { start, length: t.length, x0: x, y0: y, x1: x + 0.006 * t.length, y1: y + 0.008 }
  })
  return { text, runs }
}

const TITLES = ['REFLECTED CEILING PLAN', 'FLOOR PLAN', 'FINISH PLAN', 'DOOR SCHEDULE', 'ENLARGED PLANS', 'DETAILS',
  'INTERIOR ELEVATIONS', 'FURNITURE PLAN', 'DEMOLITION PLAN', 'PARTITION TYPES', 'MILLWORK', 'SIGNAGE']

function set(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const r = (k: number) => ((i * 37 + k * 11) % 70) / 100 + 0.05
    return sheet([
      // Tags all over the drawing, on lines of their own, each followed by words in capitals.
      ['CL201', r(1), r(2)], ['ACOUSTIC CEILING TILE', r(1), r(2) + 0.01],
      ['D6A', r(3), r(4)], ['PT210', r(5), r(6)], ['C114', r(7), r(1)], ['FSC-45G', r(2), r(5)],
      // The title block, bottom right, the same on every sheet but for the number and the title.
      ['NORTH ONTARIO INNOVATION CENTRE', 0.86, 0.80],
      ['ACME ARCHITECTS INC', 0.86, 0.83],
      ['DRAWING TITLE', 0.86, 0.87],
      // Each word its own run, as many title blocks write them; the long ones reach cells the short ones never do.
      ...TITLES[i % TITLES.length]!.split(' ').map((word, k, all): W => [word, 0.86 + all.slice(0, k).join(' ').length * 0.006 + (k > 0 ? 0.006 : 0), 0.89]),
      ['PROJECT NO', 0.86, 0.93], ['24-118', 0.86, 0.945],
      ['SHEET', 0.93, 0.93], [`ID-${100 + i}`, 0.93 + (i % 3) * 0.001, 0.95],
    ])
  })
}

describe('finding the title block from where words sit across sheets', () => {
  it('finds the number box under the tags, and names every sheet from it', () => {
    const pages = set(24)
    const found = findTitleBlock(pages)!
    expect(found).not.toBeNull()
    expect(found.sheets).toBe(24)
    const names = pages.map((p) => readSheetName(p, found.regions))
    expect(names.map((n) => n?.number)).toEqual(pages.map((_, i) => `ID-${100 + i}`))
    expect(names[0]!.title).toBe('REFLECTED CEILING PLAN')
    expect(names[6]!.title).toBe('INTERIOR ELEVATIONS')
    // The block's furniture is not the title.
    expect(names[0]!.title).not.toContain('ACME')
  })
  it('keeps a title that most sheets share', () => {
    const pages = Array.from({ length: 20 }, (_, i) => sheet([
      ['ACME ARCHITECTS INC', 0.86, 0.83],
      ...(i < 12 ? ['REFLECTED', 'CEILING', 'PLAN'] : ['DETAILS']).map((w, k): W => [w, 0.86 + k * 0.06, 0.89]),
      [`A-${200 + i}`, 0.93, 0.95],
    ]))
    const found = findTitleBlock(pages)!
    expect(readSheetName(pages[3]!, found.regions)).toEqual({ number: 'A-203', title: 'REFLECTED CEILING PLAN' })
    expect(readSheetName(pages[15]!, found.regions)!.title).toBe('DETAILS')
  })
  it('works from a sample of a few sheets', () => {
    expect(findTitleBlock(set(4))?.sheets).toBe(4)
  })
  it('finds nothing, rather than a guess, when no box holds a different code on most sheets', () => {
    // A spec book: no title block, a section number at the top.
    const spec = Array.from({ length: 10 }, () => sheet([['SECTION 09 51 13', 0.1, 0.05], ['PART 1 GENERAL', 0.1, 0.1]]))
    expect(findTitleBlock(spec)).toBeNull()
    // The same code on every sheet is a project number, not a sheet number.
    const same = Array.from({ length: 10 }, () => sheet([['A100', 0.9, 0.95], ['FLOOR PLAN', 0.9, 0.9]]))
    expect(findTitleBlock(same)).toBeNull()
    expect(findTitleBlock([sheet([['A101', 0.9, 0.95]])])).toBeNull()
  })
  it('reads sheet codes, and not revisions, levels or labels', () => {
    expect(codeOf('A-101')).toBe('A-101')
    expect(codeOf('A1.01')).toBe('A1.01')
    expect(codeOf('ID-201')).toBe('ID-201')
    expect(codeOf('R2')).toBeNull()
    expect(codeOf('L46')).toBeNull()
    expect(codeOf('ISSUED FOR TENDER')).toBeNull()
  })
})
