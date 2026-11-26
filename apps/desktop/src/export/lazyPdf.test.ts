import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFInvalidObject, PDFName, PDFString } from 'pdf-lib'
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

describe('a set with hundreds of thousands of objects', () => {
  // A spec book: few pages, a huge object count. Spreading every object
  // number into Math.max overflowed the call stack and the save failed
  // with "Maximum call stack size exceeded" (0.3.90).
  it('opens by range and saves a takeoff into it', async () => {
    const doc = await PDFDocument.create()
    for (let i = 0; i < 3; i++) doc.addPage([612, 792])
    for (let i = 0; i < 250_000; i++) doc.context.register(doc.context.obj({ N: i }))
    const bytes = await doc.save({ useObjectStreams: true })
    const lazy = openLazyPdf(source(bytes))
    expect(lazy.doc.getPageCount()).toBe(3)
    expect(lazy.doc.context.largestObjectNumber).toBeGreaterThan(250_000)
    const { tail } = embedSheetTail(lazy.doc, updateBaseOf(bytes), input([area('m1')]))
    const joined = new Uint8Array(bytes.length + tail!.length)
    joined.set(bytes, 0)
    joined.set(tail!, bytes.length)
    expect(readSheetEmbedFrom(openLazyPdf(source(joined)).doc).slice?.tables.markups?.map((m) => m.id)).toEqual(['m1'])
  }, 120_000)
})

describe('sheet names with parentheses and backslashes', () => {
  const named = (labels: string[]): EmbedInput => {
    const base = input([area('m1')])
    return { ...base, tables: { ...base.tables, redbeam_meta: [{ key: 'sheet_labels', value: JSON.stringify(labels) }] } as never }
  }
  const labelsOf = async (bytes: Uint8Array): Promise<string[]> => {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    const nums = (doc.catalog.lookup(PDFName.of('PageLabels'), PDFDict).lookup(PDFName.of('Nums'), PDFArray)).asArray()
    const out: string[] = []
    for (let i = 1; i < nums.length; i += 2) {
      const p = (doc.context.lookup(nums[i]) as PDFDict).lookup(PDFName.of('P'))
      if (p instanceof PDFString || p instanceof PDFHexString) out.push(p.decodeText())
    }
    return out
  }
  const odd = ['A-101 PLAN B)', 'A-102 (PART', 'A-103 \\ ROOF\\']

  it('writes them so the PDF parses and they read back as written', async () => {
    const bytes = (await embedSheet(await blank(false), named(odd))).bytes!
    expect(await labelsOf(bytes)).toEqual(odd)
    // And a second save into it works, whole and by range.
    const more = { ...named(odd), markups: [area('m1'), area('m2', 1)] }
    expect(await labelsOf((await embedSheet(bytes, more)).bytes!)).toEqual(odd)
    expect(embedSheetTail(openLazyPdf(source(bytes)).doc, updateBaseOf(bytes), more).tail).not.toBeNull()
  })

  it('saves over a file an older REDBEAM left an unparseable sheet name in', async () => {
    for (const objectStreams of [false, true]) {
      const good = (await embedSheet(await blank(objectStreams), named(['A-101 PLAN B)', null as never, null as never]))).bytes!
      // What 0.3.99 and earlier wrote: the ")" unescaped. Same length, so every offset holds.
      const text = new TextDecoder('latin1').decode(good)
      const broken = good.slice()
      let hits = 0
      for (let at = text.indexOf('B\\)'); at >= 0; at = text.indexOf('B\\)', at + 1)) { broken[at + 1] = 0x20; hits++ }
      expect(hits).toBeGreaterThan(1) // the page label and the bookmark
      const before = await PDFDocument.load(broken, { updateMetadata: false, throwOnInvalidObject: false }).catch(() => null)
      expect(before === null || [...before.context.enumerateIndirectObjects()].some(([, o]) => o instanceof PDFInvalidObject)).toBe(true)

      const whole = (await embedSheet(broken, named(odd))).bytes!
      expect(await labelsOf(whole)).toEqual(odd)
      const { tail } = embedSheetTail(openLazyPdf(source(broken)).doc, updateBaseOf(broken), named(odd))
      const joined = new Uint8Array(broken.length + tail!.length)
      joined.set(broken, 0)
      joined.set(tail!, broken.length)
      expect(await labelsOf(joined)).toEqual(odd)
      expect(readSheetEmbedFrom(openLazyPdf(source(joined)).doc).slice?.tables.markups?.map((m) => m.id)).toEqual(['m1'])
    }
  })
})
