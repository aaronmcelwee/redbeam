import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { fit, winAnsi, wrap, wrapLines } from './pdfBrand.js'

const font = await (await PDFDocument.create()).embedFont(StandardFonts.HelveticaBold)
const width = (t: string, size: number) => font.widthOfTextAtSize(t, size)

/** Kenneth's file, 2026-11-24: one long word, then a few short ones. */
const FILE = 'A-351B-FLOOR-01---SECTOR-B-EXTERIOR-REFLECTED-CEILING-PLAN-REV.3  M2-M5 BULL009 FO-VT 5-02-26'

describe('wrap', () => {
  it('breaks a name with no spaces after its hyphens, every line inside the measure', () => {
    const lines = wrap(font, 21, FILE, 380)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(width(l, 21)).toBeLessThanOrEqual(380)
    expect(lines[0]!.endsWith('-')).toBe(true)
    // Nothing lost: put back together, it is the name with its spaces collapsed.
    expect(lines.join('').replace(/\s+/g, '')).toBe(FILE.replace(/\s+/g, ''))
  })

  it('breaks between letters only when a word has nowhere else to break', () => {
    const lines = wrap(font, 12, 'X'.repeat(80), 100)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(width(l, 12)).toBeLessThanOrEqual(100)
    expect(lines.join('')).toBe('X'.repeat(80))
  })

  it('still breaks plain words at spaces', () => {
    expect(wrap(font, 12, 'Level 03 ceilings and bulkheads', 90)).toEqual(['Level 03', 'ceilings and', 'bulkheads'])
  })
})

describe('wrapLines', () => {
  it('ends the last line it may take with an ellipsis', () => {
    const lines = wrapLines(font, 21, FILE, 250, 2)
    expect(lines).toHaveLength(2)
    expect(lines[1]!.endsWith('…')).toBe(true)
    expect(width(lines[1]!, 21)).toBeLessThanOrEqual(250)
  })

  it('rejoins a word it broke without a space in it', () => {
    const lines = wrapLines(font, 12, 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF', 50, 1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain(' ')
  })

  it('leaves text that fits alone', () => {
    expect(wrapLines(font, 12, 'Small fit-out', 300, 2)).toEqual(['Small fit-out'])
  })
})

describe('fit and winAnsi', () => {
  it('trims a long label to the width with an ellipsis', () => {
    const t = fit(font, 8, FILE, 120)
    expect(t.endsWith('…')).toBe(true)
    expect(width(t, 8)).toBeLessThanOrEqual(120)
  })

  it('turns what the standard fonts cannot set into what they can', () => {
    expect(winAnsi('2′-6″ – café')).toBe('2\'-6" - café')
    expect(winAnsi('天花板 ✓')).toBe('??? ?')
  })
})
