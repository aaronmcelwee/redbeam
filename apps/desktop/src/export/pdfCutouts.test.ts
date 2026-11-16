import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFString } from 'pdf-lib'
import type { PageAnnotation } from '@redbeam/viewer'
import { cutoutRingsOf, cutoutsFor, normalizeRing, readPdfCutouts } from './pdfCutouts.js'

/** A one-page PDF whose /Annots hold what Revu writes for an area with cutouts. */
async function revuArea(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([1000, 500])
  const ctx = doc.context
  const area = (nm: string, cutouts?: number[][]) => ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Polygon', IT: 'PolygonDimension',
    Subj: PDFString.of('Area Measurement'), NM: PDFString.of(nm),
    Rect: [100, 100, 400, 300],
    Vertices: [100, 100, 400, 100, 400, 300, 100, 300],
    ...(cutouts === undefined ? {} : { Cutouts: cutouts }),
  }))
  const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10] }))
  page.node.set(PDFName.of('Annots'), ctx.obj([
    link,
    area('PLAINAREAAAAAAAA'),
    area('HOLEDAREAAAAAAAA', [[150, 150, 200, 150, 200, 200, 150, 200], [300, 250, 350, 250, 325, 280]]),
  ]))
  return doc.save({ useObjectStreams: true })
}

function annot(over: Partial<PageAnnotation>): PageAnnotation {
  return {
    index: 0, subtype: 7, subtypeName: 'Polygon', shape: 'polygon',
    rect: { x0: 0, y0: 0, x1: 1, y1: 1 }, vertices: [], ink: [],
    subject: 'Area Measurement', contents: '', author: '', name: '', color: null,
    hasCutouts: true, pageBox: { left: 0, bottom: 0, right: 1000, top: 500 },
    ...over,
  }
}

describe('Bluebeam area cutouts', () => {
  it('reads every cutout ring of the annotation that has them, by /Annots index', async () => {
    const found = await readPdfCutouts(await revuArea(), 0)
    expect(found).toHaveLength(1)
    expect(found[0]!.index).toBe(2)
    expect(found[0]!.name).toBe('HOLEDAREAAAAAAAA')
    expect(found[0]!.rings).toEqual([
      [{ x: 150, y: 150 }, { x: 200, y: 150 }, { x: 200, y: 200 }, { x: 150, y: 200 }],
      [{ x: 300, y: 250 }, { x: 350, y: 250 }, { x: 325, y: 280 }],
    ])
  })

  it('normalizes the rings like the annotation vertices: page box, y down', async () => {
    const found = await readPdfCutouts(await revuArea(), 0)
    const holes = cutoutsFor(annot({ index: 2, name: 'HOLEDAREAAAAAAAA' }), found)
    expect(holes).toHaveLength(2)
    expect(holes[0]![0]).toEqual({ x: 0.15, y: 0.7 })
    expect(holes[1]![2]).toEqual({ x: 0.325, y: 0.44 })
  })

  it('finds the right entry by /NM when the index disagrees, and none for a stranger', async () => {
    const found = await readPdfCutouts(await revuArea(), 0)
    expect(cutoutsFor(annot({ index: 1, name: 'HOLEDAREAAAAAAAA' }), found)).toHaveLength(2)
    expect(cutoutsFor(annot({ index: 2, name: 'SOMEONEELSEAAAAA' }), found)).toEqual([])
  })

  it('gives nothing for an annotation PDFium did not flag', async () => {
    const found = await readPdfCutouts(await revuArea(), 0)
    expect(cutoutsFor(annot({ index: 2, name: 'HOLEDAREAAAAAAAA', hasCutouts: false }), found)).toEqual([])
  })

  it('accepts a single flat ring and drops rings under three points', async () => {
    const doc = await PDFDocument.create()
    const ctx = doc.context
    expect(cutoutRingsOf(ctx.obj([0, 0, 10, 0, 10, 10]))).toHaveLength(1)
    expect(cutoutRingsOf(ctx.obj([[0, 0, 10, 0], [0, 0, 1, 0, 1, 1]]))).toHaveLength(1)
    expect(cutoutRingsOf(ctx.obj([]))).toEqual([])
    expect(cutoutRingsOf(undefined)).toEqual([])
  })

  it('normalizes against an origin-centred box', () => {
    expect(normalizeRing([{ x: 0, y: 0 }], { left: -500, bottom: -250, right: 500, top: 250 }))
      .toEqual([{ x: 0.5, y: 0.5 }])
  })
})
