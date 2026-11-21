import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { parsePageRange, printedWhat, sheetsPdf } from './print.js'

describe('parsePageRange', () => {
  it('reads single sheets, ranges and open ends, 1-based', () => {
    expect(parsePageRange('3', 10)).toEqual([2])
    expect(parsePageRange('1-3, 8', 10)).toEqual([0, 1, 2, 7])
    expect(parsePageRange('8-', 10)).toEqual([7, 8, 9])
    expect(parsePageRange('-2', 10)).toEqual([0, 1])
    expect(parsePageRange('5 to 4', 10)).toEqual([3, 4])
    expect(parsePageRange('all', 3)).toEqual([0, 1, 2])
  })
  it('drops repeats and keeps the order typed', () => {
    expect(parsePageRange('5, 1-2, 2', 10)).toEqual([4, 0, 1])
  })
  it('says why it cannot read one', () => {
    expect(parsePageRange('', 10)).toMatch(/type sheet numbers/)
    expect(parsePageRange('11', 10)).toBe('there are 10 sheets')
    expect(parsePageRange('0', 10)).toMatch(/from 1/)
    expect(parsePageRange('a3', 10)).toMatch(/not a sheet number/)
  })
})

describe('sheetsPdf', () => {
  it('keeps only the sheets asked for, in that order', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([100, 200]); doc.addPage([300, 400]); doc.addPage([500, 600])
    const bytes = await doc.save()
    const cut = await PDFDocument.load(await sheetsPdf(bytes, [2, 0]))
    expect(cut.getPages().map((p) => p.getWidth())).toEqual([500, 100])
  })
  it('hands back the file itself for every sheet', async () => {
    const doc = await PDFDocument.create()
    doc.addPage(); doc.addPage()
    const bytes = await doc.save()
    expect(await sheetsPdf(bytes, [0, 1])).toBe(bytes)
  })
})

describe('printedWhat', () => {
  it('names one sheet, all of them, or a count', () => {
    const label = (i: number) => `A${i}`
    expect(printedWhat([3], 10, label)).toBe('sheet A3')
    expect(printedWhat([0, 1], 2, label)).toBe('all 2 sheets')
    expect(printedWhat([0, 1], 5, label)).toBe('2 sheets')
  })
})
