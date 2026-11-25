/**
 * What a big drawing read by range (lazyPdf.ts) is used for besides the
 * takeoff: each must agree with the same operation on the whole file.
 */
import { describe, expect, it } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { openLazyPdf, type ByteSource } from './lazyPdf.js'
import { sheetSizes, sheetSizesOf } from './sheetEmbed.js'
import { readPageCutouts, readPdfCutouts } from './pdfCutouts.js'
import { writeMarkupsInto, writeMarkupsToPdf, type WritableMarkup } from './pdfMarkup.js'
import { incrementalTail, newRefsSince, updateBaseOf } from './pdfIncremental.js'
import { sheetsPdf, sheetsPdfFrom } from '../print.js'
import { exportMarkedPdf, type RangedMarkedPdf } from './markedPdf.js'

const source = (bytes: Uint8Array): ByteSource => ({ size: bytes.length, read: (a, b) => bytes.slice(a, b) })

/** Pages of different sizes; page 1 carries an area with cutouts, in an indirect /Annots. */
async function drawing(objectStreams: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < 4; i++) doc.addPage([2000 + i, 1000])
  const ctx = doc.context
  const area = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Polygon', NM: PDFString.of('HOLED'),
    Rect: [100, 100, 400, 300], Vertices: [100, 100, 400, 100, 400, 300, 100, 300],
    Cutouts: [[150, 150, 200, 150, 200, 200, 150, 200]],
  }))
  doc.getPage(1).node.set(PDFName.of('Annots'), ctx.register(ctx.obj([area])))
  return doc.save({ useObjectStreams: objectStreams })
}

const marks: WritableMarkup[] = [
  { id: 'm1', pageIndex: 1, kind: 'area', rings: [[{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }]], scopeLabel: 'ACT-1', color: '#2f7fd1' },
  { id: 'm2', pageIndex: 3, kind: 'polyline', rings: [[{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.6 }]], scopeLabel: 'ACT-1', color: '#2f7fd1' },
]

const names = (doc: PDFDocument, page: number): string[] => {
  const annots = doc.getPage(page).node.lookup(PDFName.of('Annots'))
  if (!(annots instanceof PDFArray)) return []
  return annots.asArray().map((_, i) => {
    const v = annots.lookup(i, PDFDict).lookup(PDFName.of('NM'))
    return v instanceof PDFString ? v.decodeText() : ''
  })
}

describe('a big drawing read by range', () => {
  for (const objectStreams of [false, true]) {
    const kind = objectStreams ? 'xref stream' : 'xref table'

    it(`measures every sheet like a whole read (${kind})`, async () => {
      const bytes = await drawing(objectStreams)
      expect(sheetSizesOf(openLazyPdf(source(bytes)).doc)).toEqual(await sheetSizes(bytes))
    })

    it(`reads a sheet's cutouts like a whole read (${kind})`, async () => {
      const bytes = await drawing(objectStreams)
      const lazy = readPageCutouts(openLazyPdf(source(bytes)).doc, 1)
      expect(lazy).toHaveLength(1)
      expect(lazy).toEqual(await readPdfCutouts(bytes, 1))
    })

    it(`writes markups as an update that keeps what the sheet had (${kind})`, async () => {
      const bytes = await drawing(objectStreams)
      const lazy = openLazyPdf(source(bytes))
      const before = lazy.doc.context.largestObjectNumber
      const changed = writeMarkupsInto(lazy.doc, marks, { pageScales: new Map([[1, 8 / 72]]) })
      const tail = incrementalTail(updateBaseOf(bytes), lazy.doc, [...changed, ...newRefsSince(lazy.doc, before)])
      const copy = new Uint8Array(bytes.length + tail.length)
      copy.set(bytes)
      copy.set(tail, bytes.length)
      const out = await PDFDocument.load(copy)
      expect(names(out, 1)).toEqual(['HOLED', 'm1'])
      expect(names(out, 3)).toEqual(['m2'])
      // The same markups as a whole rewrite.
      const whole = await PDFDocument.load(await writeMarkupsToPdf(bytes, marks))
      expect(names(whole, 1)).toEqual(names(out, 1))
      // Only a few kilobytes: the drawing itself is not written again.
      expect(tail.length).toBeLessThan(8000)
    })

    it(`cuts out sheets to print like a whole read (${kind})`, async () => {
      const bytes = await drawing(objectStreams)
      const lazy = await PDFDocument.load(await sheetsPdfFrom(openLazyPdf(source(bytes)).doc, [3, 1]))
      const whole = await PDFDocument.load(await sheetsPdf(bytes, [3, 1]))
      expect(lazy.getPages().map((p) => p.getWidth())).toEqual([2003, 2001])
      expect(whole.getPages().map((p) => p.getWidth())).toEqual([2003, 2001])
    })
  }

  it('a marked-up export of a big drawing never reads it whole', async () => {
    let read = false
    let saved: { name: string, tail: Uint8Array } | null = null
    let released = false
    const ranged: RangedMarkedPdf = {
      markedTail: async () => new Uint8Array([1, 2, 3]),
      saveCopy: async (name, tail) => { saved = { name, tail } },
      release: () => { released = true },
    }
    const problem = await exportMarkedPdf({
      documentId: 'd1', documentName: 'Set.pdf',
      markups: [{ id: 'm1', documentId: 'd1', pageId: 'd1-p0', kind: 'area', scopeId: 's1', rings: [[{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }]] }] as never,
      scopes: [{ id: 's1', label: 'ACT-1', color: '#2f7fd1' }],
      calibrations: new Map(), pageBoxes: new Map(),
      readBytes: async () => { read = true; return new Uint8Array() },
      save: () => { throw new Error('not this way') },
      ranged: async () => ranged,
    })
    expect(problem).toBeNull()
    expect(read).toBe(false)
    expect(saved).toEqual({ name: 'Set (REDBEAM markups).pdf', tail: new Uint8Array([1, 2, 3]) })
    expect(released).toBe(true)
  })
})
