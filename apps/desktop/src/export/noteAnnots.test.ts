import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream, PDFString } from 'pdf-lib'
import { embedSheet, isRedbeamNm, readSheetEmbed, type EmbedInput, type EmbedMarkup } from './sheetEmbed.js'
import { defaultNoteContent, type NoteContent, type NoteShape } from '../tools/noteGeometry.js'
import { winAnsi } from './noteAnnots.js'

async function blank(rotate = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([1224, 792])
  if (rotate !== 0) page.setRotation({ type: 'degrees', angle: rotate } as never)
  return doc.save()
}

const note = (id: string, shape: NoteShape, rings: EmbedMarkup['rings'], over: Partial<NoteContent> = {}): EmbedMarkup => {
  const c = { ...defaultNoteContent(shape), ...over }
  return { id, pageIndex: 0, kind: 'note', rings, scopeLabel: '', color: c.color, noteContent: c, rev: 'r1' }
}
const box = (x0: number, y0: number, x1: number, y1: number) =>
  [[{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]]

const ALL: EmbedMarkup[] = [
  note('n-text', 'text', box(0.05, 0.05, 0.3, 0.16), { text: 'VERIFY CEILING HEIGHT\nwith architect before order' }),
  note('n-cloud', 'cloud', box(0.4, 0.05, 0.6, 0.25)),
  note('n-callout', 'callout', [...box(0.65, 0.05, 0.85, 0.2), [{ x: 0.95, y: 0.35 }, { x: 0.85, y: 0.2 }]]),
  note('n-arrow', 'arrow', [[{ x: 0.1, y: 0.4 }, { x: 0.3, y: 0.55 }]]),
  note('n-line', 'line', [[{ x: 0.1, y: 0.65 }, { x: 0.3, y: 0.65 }]], { ends: ['dot', 'open'] }),
  note('n-rect', 'rect', box(0.4, 0.4, 0.55, 0.55), { fill: '#1f6fd6', color: '#1f6fd6' }),
  note('n-ellipse', 'ellipse', box(0.6, 0.4, 0.75, 0.55)),
  note('n-poly', 'polygon', [[{ x: 0.8, y: 0.4 }, { x: 0.95, y: 0.45 }, { x: 0.9, y: 0.6 }]]),
  note('n-pen', 'pen', [[{ x: 0.4, y: 0.7 }, { x: 0.45, y: 0.8 }, { x: 0.5, y: 0.72 }, { x: 0.6, y: 0.85 }]]),
]

const input = (markups: EmbedMarkup[]): EmbedInput => ({
  documentId: 'doc-1', relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: '0.3.115',
  tables: { markups: markups.map((m) => ({ id: m.id, kind: m.kind })) },
  markups, pageScales: new Map(), now: () => new Date('2026-11-26T20:00:00Z'),
})

async function annots(bytes: Uint8Array): Promise<PDFDict[]> {
  const doc = await PDFDocument.load(bytes)
  const arr = doc.getPages()[0]!.node.lookup(PDFName.of('Annots'))
  if (!(arr instanceof PDFArray)) return []
  return Array.from({ length: arr.size() }, (_, i) => arr.lookup(i, PDFDict))
}
const name = (d: PDFDict, k: string) => (d.lookup(PDFName.of(k)) as PDFName | undefined)?.decodeText()
const text = (d: PDFDict, k: string) => {
  const v = d.lookup(PDFName.of(k))
  return v instanceof PDFString ? v.decodeText() : (v as { decodeText?: () => string } | undefined)?.decodeText?.() ?? ''
}

describe('notes in the PDF', () => {
  it('writes each as the annotation Revu writes for it', async () => {
    const out = await embedSheet(await blank(), input(ALL))
    expect(out.bytes).not.toBeNull()
    if (process.env['NOTE_PDF_OUT']) writeFileSync(process.env['NOTE_PDF_OUT'], out.bytes!)
    const list = await annots(out.bytes!)
    const subj = list.map((a) => `${name(a, 'Subtype')}:${text(a, 'Subj')}`)
    expect(subj).toEqual([
      'FreeText:Text Box', 'Polygon:Cloud', 'Polygon:Cloud', 'Line:Leader', 'Line:Arrow', 'Line:Line',
      'Square:Rectangle', 'Circle:Ellipse', 'Polygon:Polygon', 'Ink:Pen',
    ])
    for (const a of list) {
      expect(isRedbeamNm(text(a, 'NM'))).toBe(true)
      expect((a.lookup(PDFName.of('AP')) as PDFDict).lookup(PDFName.of('N'))).toBeInstanceOf(PDFStream)
    }
    const [freeText, cloud, , leader, arrow, line] = list as [PDFDict, PDFDict, PDFDict, PDFDict, PDFDict, PDFDict]
    expect(text(freeText, 'Contents')).toBe('VERIFY CEILING HEIGHT\nwith architect before order')
    expect(text(freeText, 'DA')).toContain('/Helv 12 Tf')
    expect(text(freeText, 'RC')).toContain('<p>VERIFY CEILING HEIGHT</p>')
    expect(name(cloud, 'IT')).toBe('PolygonCloud')
    expect(leader.get(PDFName.of('IRT'))).toBeDefined()
    expect((arrow.lookup(PDFName.of('LE')) as PDFArray).asArray().map((n) => (n as PDFName).decodeText())).toEqual(['ClosedArrow', 'None'])
    expect((line.lookup(PDFName.of('LE')) as PDFArray).asArray().map((n) => (n as PDFName).decodeText())).toEqual(['Circle', 'OpenArrow'])
  })

  it('replaces its own notes on the next save, never doubling them', async () => {
    const first = await embedSheet(await blank(), input(ALL))
    const moved = ALL.map((m) => m.id === 'n-rect' ? { ...m, rings: box(0.42, 0.42, 0.57, 0.57), rev: 'r2' } : m)
    const second = await embedSheet(first.bytes!, input(moved))
    expect(await annots(second.bytes!)).toHaveLength(10)
    const reading = await readSheetEmbed(second.bytes!)
    expect(reading.foreignAnnots).toBe(0)
  })

  it('turns a text box with its sheet', async () => {
    const out = await embedSheet(await blank(90), input([ALL[0]!]))
    const [a] = await annots(out.bytes!)
    const ap = (a!.lookup(PDFName.of('AP')) as PDFDict).lookup(PDFName.of('N')) as PDFStream
    expect(ap.dict.lookup(PDFName.of('Matrix'))?.toString()).toBe('[ 0 1 -1 0 0 0 ]')
  })

  it('writes what Helvetica cannot draw as a question mark', () => {
    expect(winAnsi('2’-6” ±5 mm ✓')).toBe('2’-6” ±5 mm ?')
  })
})
