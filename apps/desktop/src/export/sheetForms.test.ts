import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, degrees, pushGraphicsState, popGraphicsState, moveTo, lineTo, stroke } from 'pdf-lib'
import { toUserSpace } from './pdfMarkup.js'
import {
  displayedSize, embedSheets, normalizedToUser, turnsOf, userToNormalized, visibleBox, windowForm, windowMatrix,
} from './sheetForms.js'

const box = { left: 10, bottom: 20, right: 1010, top: 720 } // 1000 x 700, off the origin

describe('the page as displayed', () => {
  it('agrees with how markups are written into the PDF, at every turn', () => {
    for (const turns of [0, 1, 2, 3] as const) {
      for (const p of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.25, y: 0.75 }, { x: 0.6, y: 0.1 }]) {
        const mine = normalizedToUser({ box, turns }, p)
        const markup = toUserSpace(p, { x: 10, y: 20, width: 1000, height: 700 }, turns * 90)
        expect(mine.x).toBeCloseTo(markup.x, 9)
        expect(mine.y).toBeCloseTo(markup.y, 9)
        const back = userToNormalized({ box, turns }, mine.x, mine.y)
        expect(back.x).toBeCloseTo(p.x, 9)
        expect(back.y).toBeCloseTo(p.y, 9)
      }
    }
  })

  it('measures a turned sheet the way it is shown', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([1000, 700])
    expect(displayedSize(page)).toEqual({ width: 1000, height: 700 })
    page.setRotation(degrees(90))
    expect(turnsOf(page)).toBe(1)
    expect(displayedSize(page)).toEqual({ width: 700, height: 1000 })
    page.setRotation(degrees(-90))
    expect(turnsOf(page)).toBe(3)
  })

  it('takes the crop box inside the media box', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([1000, 700])
    page.setCropBox(50, 40, 600, 500)
    expect(visibleBox(page)).toEqual({ left: 50, bottom: 40, right: 650, top: 540 })
  })

  it('draws a window so that it fills its rectangle, whatever the turn', () => {
    const window = { x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.5 }
    const rect = { x: 100, y: 50, width: 400, height: 200 }
    for (const turns of [0, 1, 2, 3] as const) {
      const [a, b, c, d, e, f] = windowMatrix({ box, turns }, window, rect)
      const paper = (n: { x: number; y: number }) => {
        const u = normalizedToUser({ box, turns }, n)
        return { x: a * u.x + c * u.y + e, y: b * u.x + d * u.y + f }
      }
      // The window's top-left corner lands on the rectangle's top-left, its bottom-right on the bottom-right.
      expect(paper({ x: 0.2, y: 0.3 }).x).toBeCloseTo(100, 6)
      expect(paper({ x: 0.2, y: 0.3 }).y).toBeCloseTo(250, 6)
      expect(paper({ x: 0.6, y: 0.5 }).x).toBeCloseTo(500, 6)
      expect(paper({ x: 0.6, y: 0.5 }).y).toBeCloseTo(50, 6)
    }
  })
})

describe('embedSheets', () => {
  it('carries a sheet across as a form, and a window of it with only the linework that reaches it', async () => {
    const source = await PDFDocument.create()
    const page = source.addPage([1000, 700])
    // Many short lines across the sheet, so a small window leaves most of them out.
    const ops = []
    for (let i = 0; i < 100; i++) ops.push(pushGraphicsState(), moveTo(i * 10, 0), lineTo(i * 10 + 5, 700), stroke(), popGraphicsState())
    page.pushOperators(...ops)
    const bytes = await source.save()
    const loaded = await PDFDocument.load(bytes)
    const target = await PDFDocument.create()
    const forms = await embedSheets(target, loaded, [0, 0, 5])
    expect([...forms.keys()]).toEqual([0])
    const form = forms.get(0)!
    expect(form.width).toBe(1000)
    expect(form.height).toBe(700)
    const whole = await form.whole()
    const part = await windowForm(target, form, { x0: 0, y0: 0, x1: 0.1, y1: 1 })
    expect(part).not.toBe(whole)
    const size = (ref: typeof whole) => {
      const s = target.context.lookup(ref) as unknown as { dict: { get: (n: PDFName) => unknown } }
      return String(s.dict.get(PDFName.of('Length')))
    }
    expect(Number(size(part))).toBeLessThan(Number(size(whole)))
    // A window over most of the sheet shares the whole sheet's form.
    expect(await windowForm(target, form, { x0: 0, y0: 0, x1: 1, y1: 1 })).toBe(whole)
  })
})
