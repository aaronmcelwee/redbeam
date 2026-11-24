import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { openLazyPdf, type ByteSource } from './lazyPdf.js'
import { embedSheet, embedSheetTail, readSheetEmbed, readSheetEmbedFrom, type EmbedInput, type EmbedMarkup } from './sheetEmbed.js'
import { updateBaseOf } from './pdfIncremental.js'

const source = (bytes: Uint8Array): ByteSource & { reads: number } => {
  const s = { size: bytes.length, reads: 0, read: (a: number, b: number) => { s.reads++; return bytes.slice(a, b) } }
  return s
}

async function blank(objectStreams: boolean, pages = 3): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([2592 + i, 1728])
    p.drawText(`Sheet ${i + 1}`, { x: 50, y: 50, size: 40 })
  }
  return doc.save({ useObjectStreams: objectStreams })
}

const area = (id: string, page = 0): EmbedMarkup => ({
  id, pageIndex: page, kind: 'area',
  rings: [[{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }, { x: 0.1, y: 0.3 }]],
  scopeLabel: 'ACT-1 Ceiling', color: '#2f7fd1', quantity: 2064.781,
})

const input = (markups: EmbedMarkup[]): EmbedInput => ({
  documentId: 'doc-1', relativePath: 'A-101.pdf', displayName: 'A-101', appVersion: '0.3.74',
  tables: { markups: markups.map((m) => ({ id: m.id, kind: m.kind })), scopes: [{ id: 's1', label: 'ACT-1 Ceiling' }] },
  markups, pageScales: new Map([[0, 8 / 72]]), now: () => new Date('2026-11-24T20:00:00Z'),
})

describe('openLazyPdf', () => {
  for (const objectStreams of [false, true]) {
    it(`reads the same takeoff as a full load (${objectStreams ? 'xref stream' : 'xref table'})`, async () => {
      const first = (await embedSheet(await blank(objectStreams), input([area('m1')]))).bytes!
      // A second save appends another update: the lazy reader follows /Prev.
      const bytes = (await embedSheet(first, input([area('m1'), area('m2', 2)]))).bytes!
      const full = await readSheetEmbed(bytes)
      const lazy = openLazyPdf(source(bytes))
      expect(lazy.doc.getPageCount()).toBe(3)
      expect(lazy.doc.getPages()[1]!.getWidth()).toBe(2593)
      expect(readSheetEmbedFrom(lazy.doc)).toEqual(full)
    })
  }

  it('leaves page content alone', async () => {
    const bytes = await blank(false, 40)
    const src = source(bytes)
    const lazy = openLazyPdf(src)
    lazy.doc.getPages().forEach((p) => p.getMediaBox())
    // Catalog, page tree, 40 pages: no content streams or fonts.
    expect(lazy.stats.objects).toBeLessThanOrEqual(42)
  })

  it('opens the UI sweep drawing set like a full load', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('../../../../fixtures/ui/sweep.pdf', import.meta.url)))
    const lazy = openLazyPdf(source(bytes))
    const full = await PDFDocument.load(bytes, { updateMetadata: false })
    expect(lazy.doc.getPageCount()).toBe(full.getPageCount())
    expect(readSheetEmbedFrom(lazy.doc)).toEqual(await readSheetEmbed(bytes))
  })

  for (const name of ['predictor-xref-stream.pdf', 'reused-object-stream-number.pdf']) {
    it(`reads ${name} like a full load`, async () => {
      const bytes = new Uint8Array(readFileSync(new URL(`../../../../fixtures/pdf/${name}`, import.meta.url)))
      const lazy = openLazyPdf(source(bytes))
      expect(JSON.parse(JSON.stringify(readSheetEmbedFrom(lazy.doc)))).toEqual(JSON.parse(JSON.stringify(await readSheetEmbed(bytes))))
    })
  }

  for (const objectStreams of [false, true]) {
    it(`writes the same update from a lazy document as from a full one (${objectStreams ? 'xref stream' : 'xref table'})`, async () => {
      const first = (await embedSheet(await blank(objectStreams), input([area('m1')]))).bytes!
      const next = input([area('m1'), area('m2', 1)])
      const full = (await embedSheet(first, next)).bytes!
      const lazy = openLazyPdf(source(first))
      const { tail } = embedSheetTail(lazy.doc, updateBaseOf(first), next)
      const joined = new Uint8Array(first.length + tail!.length)
      joined.set(first, 0)
      joined.set(tail!, first.length)
      expect(await readSheetEmbed(joined)).toEqual(await readSheetEmbed(full))
      // And the lazy reader reads its own update back.
      expect(readSheetEmbedFrom(openLazyPdf(source(joined)).doc)).toEqual(await readSheetEmbed(full))
    })
  }
})
