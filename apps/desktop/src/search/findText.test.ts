import { describe, expect, it } from 'vitest'
import { findInPageText, pageForSheet, sheetKey, wordsOnPage } from './findText.js'

// "SEE C-7 AND C-70" as PDFium would give it: one run per word.
const text = 'SEE C-7 AND C-70\r\nDOOR TYPE'
const runs = [
  { start: 0, length: 3, x0: 0.10, y0: 0.20, x1: 0.13, y1: 0.21 },
  { start: 4, length: 3, x0: 0.14, y0: 0.20, x1: 0.17, y1: 0.21 },
  { start: 8, length: 3, x0: 0.18, y0: 0.20, x1: 0.21, y1: 0.21 },
  { start: 12, length: 4, x0: 0.22, y0: 0.20, x1: 0.26, y1: 0.21 },
  { start: 18, length: 4, x0: 0.10, y0: 0.30, x1: 0.14, y1: 0.31 },
  { start: 23, length: 4, x0: 0.15, y0: 0.30, x1: 0.19, y1: 0.31 },
]
const page = { text, runs }

describe('findInPageText', () => {
  it('finds every occurrence with the box of the word it is in', () => {
    const m = findInPageText(page, 'c-7')
    expect(m.map((x) => x.text)).toEqual(['C-7', 'C-70'])
    expect(m[0]!.box).toEqual({ x0: 0.14, y0: 0.2, x1: 0.17, y1: 0.21 })
    expect(m[0]!.center).toEqual({ x: 0.155, y: 0.205 })
  })

  it('keeps to whole words when asked', () => {
    expect(findInPageText(page, 'C-7', { wholeWord: true }).map((x) => x.text)).toEqual(['C-7'])
  })

  it('honours case when asked', () => {
    expect(findInPageText(page, 'c-7', { caseSensitive: true })).toEqual([])
  })

  it('boxes a phrase that spans words', () => {
    const [m] = findInPageText(page, 'door type')
    expect(m!.text).toBe('DOOR TYPE')
    expect(m!.box).toEqual({ x0: 0.1, y0: 0.3, x1: 0.19, y1: 0.31 })
  })

  it('stops at the limit', () => {
    expect(findInPageText(page, 'c', { limit: 1 })).toHaveLength(1)
  })

  it('finds nothing in an empty query or page', () => {
    expect(findInPageText(page, '  ')).toEqual([])
    expect(findInPageText({ text: '', runs: [] }, 'x')).toEqual([])
  })
})

describe('wordsOnPage', () => {
  it('lists words, or only those inside a box', () => {
    expect(wordsOnPage(page)).toHaveLength(6)
    expect(wordsOnPage(page, { x0: 0, y0: 0.25, x1: 1, y1: 0.4 }).map((w) => w.text)).toEqual(['DOOR', 'TYPE'])
  })
})

describe('sheets by code', () => {
  const rows = [{ page: 4, number: 'A4.0' }, { page: 5, number: 'A4.1' }, { page: 9, number: 'Page 10' }]
  it('matches punctuation and case loosely', () => {
    expect(sheetKey('A.4.0')).toBe('a40')
    expect(pageForSheet(rows, 'A.4.0')).toBe(4)
    expect(pageForSheet(rows, 'a4.1')).toBe(5)
  })
  it('says nothing rather than guess', () => {
    expect(pageForSheet(rows, 'A9')).toBeNull()
    expect(pageForSheet([{ page: 1, number: 'A-1' }, { page: 2, number: 'A1' }], 'a.1')).toBeNull()
  })
})
