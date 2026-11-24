import { describe, expect, it } from 'vitest'
import { PDFDocument, lineTo, moveTo, popGraphicsState, pushGraphicsState, stroke } from 'pdf-lib'
import type { EstimateExport } from './estimateExport.js'
import { buildEstimatePdf, takeoffFor, type EstimatePdfRequest } from './estimatePackage.js'

/** A drawing: one 1000 x 700 sheet of linework. */
async function drawing(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([1000, 700])
  const ops = []
  for (let i = 0; i < 40; i++) ops.push(pushGraphicsState(), moveTo(i * 25, 0), lineTo(i * 25, 700), stroke(), popGraphicsState())
  page.pushOperators(...ops)
  return doc.save()
}

const estimate: EstimateExport = {
  projectName: 'Scottsdale', estimateName: 'Level 03', subtitle: '', documents: ['Set.pdf'],
  generatedAt: new Date('2026-11-24T12:00:00Z'),
  scopes: [{
    id: 's1', label: 'CL03', product: 'Panels', color: '#2B6CB0', note: '',
    quantities: [{ label: 'Area', quantity: 600, unit: 'SF' }], components: [], markupCount: 1, sheets: ['A1.203'],
  }],
}

const request = (over: Partial<EstimatePdfRequest>, bytes: Uint8Array | null): EstimatePdfRequest => ({
  estimate,
  snapshots: true,
  scopes: [{ id: 's1', label: 'CL03', color: '#2B6CB0' }],
  markups: [{
    id: 'm1', scopeId: 's1', documentId: 'd1', pageId: 'd1-p0', kind: 'area',
    rings: [[{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }, { x: 0.4, y: 0.3 }, { x: 0.1, y: 0.3 }]],
  }],
  pieces: [],
  sheets: [['d1-p0', { width: 1000, height: 700, feetPerPoint: 1 / 9 }]],
  labels: [['d1-p0', 'A1.203']],
  drawings: [{ documentId: 'd1', name: 'Set.pdf', bytes, rotations: [] }],
  notes: [],
  ...over,
})

const pages = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount()

describe('buildEstimatePdf', () => {
  it('makes the cover, the quantities and a page of snapshots from plain data', async () => {
    expect(await pages(await buildEstimatePdf(request({}, await drawing())))).toBe(3)
  })

  it('makes the quantities alone when asked for no snapshots', async () => {
    expect(await pages(await buildEstimatePdf(request({ snapshots: false }, await drawing())))).toBe(2)
  })

  it('pictures the takeoff without its sheet when the drawing cannot be read, and says so', async () => {
    expect(await pages(await buildEstimatePdf(request({}, null)))).toBe(4)
    expect(await pages(await buildEstimatePdf(request({}, new Uint8Array([1, 2, 3]))))).toBe(4)
  })

  it('measures a sheet from its drawing, turned as the window shows it, when the window did not', async () => {
    const turned = request({
      sheets: [['d1-p0', { width: 0, height: 0, feetPerPoint: 1 / 9 }]],
      drawings: [{ documentId: 'd1', name: 'Set.pdf', bytes: await drawing(), rotations: [[0, 90]] }],
    }, null)
    expect(await pages(await buildEstimatePdf(turned))).toBe(3)
  })

  it('notes takeoff on a sheet nothing can size, rather than leave it out quietly', async () => {
    const lost = request({ sheets: [['d1-p0', { width: 0, height: 0, feetPerPoint: 1 / 9 }]] }, null)
    // The cover, the quantities and the note: no picture can be made.
    expect(await pages(await buildEstimatePdf(lost))).toBe(3)
  })
})

describe('takeoffFor', () => {
  it('keeps the takeoff of the export scopes, and nothing else', () => {
    const m = (scopeId: string | null, kind: string) => ({ id: `${scopeId}-${kind}`, scopeId, documentId: 'd', pageId: 'd-p0', kind, rings: [] })
    const kept = takeoffFor([m('s1', 'area'), m('s1', 'cutout'), m('s1', 'polyline'), m('s1', 'count'), m('s1', 'dimension'), m('s2', 'area'), m(null, 'area')], new Set(['s1']))
    expect(kept.map((k) => k.kind)).toEqual(['area', 'cutout', 'polyline', 'count'])
  })
})
