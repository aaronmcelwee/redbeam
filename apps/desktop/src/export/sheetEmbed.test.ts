import { describe, expect, it } from 'vitest'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib'
import {
  embedSheet, isRedbeamNm, readSheetEmbed, redbeamNm, quantityText,
  type EmbedInput, type EmbedMarkup,
} from './sheetEmbed.js'
import type { FileBookmark } from './sheetOutline.js'
import { isXrefTable, lastStartXref, trailerSize } from './pdfIncremental.js'

const FPP = 8 / 72 // 1/8" = 1'-0"

async function blank(objectStreams: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([2592, 1728])
  doc.addPage([2592, 1728])
  return doc.save({ useObjectStreams: objectStreams })
}

const area = (id: string, page = 0): EmbedMarkup => ({
  id, pageIndex: page, kind: 'area',
  rings: [[{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }, { x: 0.1, y: 0.3 }]],
  scopeLabel: 'ACT-1 Ceiling', color: '#2f7fd1', quantity: 2064.781,
})

const SECRET = 'baffle spacing 12in o.c. layout-component-9'

const input = (markups: EmbedMarkup[] = [area('m1')]): EmbedInput => ({
  documentId: 'doc-1',
  relativePath: 'A-101.pdf',
  displayName: 'A-101',
  appVersion: '0.3.6',
  tables: {
    markups: markups.map((m) => ({ id: m.id, kind: m.kind })),
    scopes: [{ id: 's1', label: 'ACT-1 Ceiling', specifications_json: JSON.stringify({ note: SECRET }) }],
    layout_components: [{ id: 'lc1', properties_json: SECRET }],
  },
  markups,
  pageScales: new Map([[0, FPP]]),
  now: () => new Date('2026-11-12T20:00:00Z'),
})

const str = (d: PDFDict, k: string): string => {
  const v = d.lookup(PDFName.of(k))
  return v instanceof PDFString ? v.decodeText() : ''
}

async function pageAnnots(bytes: Uint8Array, page = 0): Promise<PDFDict[]> {
  const doc = await PDFDocument.load(bytes)
  const arr = doc.getPages()[page]!.node.lookup(PDFName.of('Annots'))
  if (!(arr instanceof PDFArray)) return []
  return Array.from({ length: arr.size() }, (_, i) => arr.lookup(i, PDFDict))
}

/** What Revu does on save: a full rewrite, possibly with a markup added. */
async function resaveElsewhere(
  bytes: Uint8Array,
  edit: (doc: PDFDocument) => void = () => {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes)
  edit(doc)
  return doc.save()
}

describe('the REDBEAM name on an annotation', () => {
  it('looks like a Revu markup id and is recognisable', () => {
    const nm = redbeamNm('markup-123')
    expect(nm).toMatch(/^RB[A-Z]{14}$/)
    expect(isRedbeamNm(nm)).toBe(true)
    expect(redbeamNm('markup-123')).toBe(nm)
    expect(isRedbeamNm('NYNYRSSMBRGGLGZL')).toBe(false)
    expect(isRedbeamNm(nm.slice(0, 15) + (nm[15] === 'A' ? 'B' : 'A'))).toBe(false)
  })

  it('words quantities the way Revu does', () => {
    expect(quantityText('area', 2064.781)).toBe('2,064.78 sf')
    expect(quantityText('polyline', 80)).toBe('80.00 ft')
    expect(quantityText('area', null)).toBe('')
  })
})

describe.each([
  ['a classic xref table', false],
  ['a cross-reference stream', true],
])('embedding into a PDF with %s', (_name, objectStreams) => {
  it('appends rather than rewrites, and reads back', async () => {
    const source = await blank(objectStreams)
    const { bytes } = await embedSheet(source, input())
    expect(bytes).not.toBeNull()
    // Every original byte is still where it was.
    expect(Buffer.from(bytes!.subarray(0, source.length)).equals(Buffer.from(source))).toBe(true)
    expect(isXrefTable(bytes!, lastStartXref(bytes!))).toBe(!objectStreams)
    // No object of the original may be redefined by a NEW object: with object
    // streams pdf-lib does not count the stream objects themselves, and reusing
    // one of their numbers deletes everything inside (Revu refused the file).
    const appended = new TextDecoder('latin1').decode(bytes!.subarray(source.length))
    const size = trailerSize(source)
    const redefined = [...appended.matchAll(/(\d+) 0 obj/g)].map((m) => Number(m[1]))
      .filter((n) => n < size)
    const doc = await PDFDocument.load(source)
    const pageRefs = new Set(doc.getPages().map((p) => p.ref.objectNumber))
    const rootRef = (doc.context.trailerInfo.Root as unknown as { objectNumber: number }).objectNumber
    for (const n of redefined) expect(pageRefs.has(n) || n === rootRef, `object ${n} redefined`).toBe(true)

    const reading = await readSheetEmbed(bytes!)
    expect(reading.source).toBe('catalog')
    expect(reading.slice?.documentId).toBe('doc-1')
    expect(reading.slice?.tables.layout_components).toHaveLength(1)
    expect(reading.redbeamAnnots).toHaveLength(1)
    expect(reading.redbeamAnnots[0]!.markupId).toBe('m1')
    expect(reading.privateDataLost).toBe(false)
  })

  it('writes the area the way Revu writes an area measurement', async () => {
    const { bytes } = await embedSheet(await blank(objectStreams), input())
    const [a] = await pageAnnots(bytes!)
    expect(a!.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Polygon'))
    expect(a!.lookup(PDFName.of('IT'))).toBe(PDFName.of('PolygonDimension'))
    expect(str(a!, 'Subj')).toBe('ACT-1 Ceiling')
    expect(str(a!, 'Label')).toBe('ACT-1 Ceiling')
    expect(str(a!, 'Contents')).toBe('2,064.78 sf')
    expect((a!.lookup(PDFName.of('MeasurementTypes')) as PDFNumber).asNumber()).toBe(129)
    const m = a!.lookup(PDFName.of('Measure'), PDFDict)
    expect(str(m, 'R')).toBe('1 in = 8 ft')
    expect((m.lookup(PDFName.of('TargetUnitConversion')) as PDFNumber).asNumber()).toBeCloseTo(1 / 864)
    const x = (m.lookup(PDFName.of('X'), PDFArray)).lookup(0, PDFDict)
    expect((x.lookup(PDFName.of('C')) as PDFNumber).asNumber()).toBeCloseTo(FPP)
    const areaUnit = (m.lookup(PDFName.of('A'), PDFArray)).lookup(0, PDFDict)
    expect(str(areaUnit, 'U')).toBe('sf')

    const doc = await PDFDocument.load(bytes!)
    const vp = doc.getPages()[0]!.node.lookup(PDFName.of('VP'), PDFArray)
    expect(vp.size()).toBe(1)
    expect(str(vp.lookup(0, PDFDict), 'Name')).toBe('REDBEAM page scale')
  })

  it('shows Bluebeam the label and quantity only, never the scope detail', async () => {
    const { bytes } = await embedSheet(await blank(objectStreams), input())
    for (const a of await pageAnnots(bytes!)) {
      for (const [k, v] of a.entries()) {
        if (v instanceof PDFString) expect(v.decodeText(), k.decodeText()).not.toContain('baffle')
      }
    }
    // Not even as stray plain text anywhere in the file: the slice is compressed.
    expect(Buffer.from(bytes!).includes(Buffer.from(SECRET))).toBe(false)
  })
})

describe('a save after the drawing has been through Bluebeam', () => {
  it('writes nothing when nothing changed', async () => {
    const first = await embedSheet(await blank(true), input())
    const second = await embedSheet(first.bytes!, input())
    expect(second.bytes).toBeNull()
  })

  it('keeps markups another app added, and replaces only its own', async () => {
    const first = await embedSheet(await blank(true), input())
    const revu = await resaveElsewhere(first.bytes!, (doc) => {
      const page = doc.getPages()[0]!
      const cloud = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 100, 100],
        NM: PDFString.of('NYNYRSSMBRGGLGZL'), Subj: PDFString.of('Cloud'),
      }))
      page.node.lookup(PDFName.of('Annots'), PDFArray).push(cloud)
    })

    const changed = input([area('m1'), area('m2')])
    const second = await embedSheet(revu, changed)
    expect(second.bytes).not.toBeNull()
    expect(second.foreignKept).toBe(1)

    const annots = await pageAnnots(second.bytes!)
    expect(annots.map((a) => str(a, 'NM')).sort()).toEqual(
      ['NYNYRSSMBRGGLGZL', redbeamNm('m1'), redbeamNm('m2')].sort(),
    )
    const reading = await readSheetEmbed(second.bytes!)
    expect(reading.foreignAnnots).toBe(1)
    expect(reading.redbeamAnnots.map((r) => r.markupId).sort()).toEqual(['m1', 'm2'])
  })

  it('leaves a REDBEAM markup that was moved in Bluebeam as it was saved', async () => {
    const first = await embedSheet(await blank(true), input())
    const revu = await resaveElsewhere(first.bytes!, (doc) => {
      const a = doc.getPages()[0]!.node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict)
      a.set(PDFName.of('Vertices'), doc.context.obj([300, 300, 600, 300, 600, 600, 300, 600]))
    })
    const second = await embedSheet(revu, input([{ ...area('m1'), quantity: 1 }]))
    expect(second.editedElsewhere).toEqual(['m1'])
    const annots = await pageAnnots(second.bytes!)
    expect(annots).toHaveLength(1)
    expect((annots[0]!.lookup(PDFName.of('Vertices'), PDFArray).lookup(0) as PDFNumber).asNumber()).toBe(300)

    // And it is settled: a third save with nothing new does not re-report it.
    const third = await embedSheet(second.bytes!, input([{ ...area('m1'), quantity: 1 }]))
    expect(third.bytes).toBeNull()
  })

  it('finds the slice on the annotations when the catalog copy was dropped', async () => {
    const first = await embedSheet(await blank(false), input())
    const stripped = await resaveElsewhere(first.bytes!, (doc) => {
      doc.catalog.delete(PDFName.of('PieceInfo'))
    })
    const reading = await readSheetEmbed(stripped)
    expect(reading.source).toBe('annotation')
    expect(reading.slice?.documentId).toBe('doc-1')
  })

  it('says so when every copy of the private data was dropped', async () => {
    const first = await embedSheet(await blank(false), input())
    const stripped = await resaveElsewhere(first.bytes!, (doc) => {
      doc.catalog.delete(PDFName.of('PieceInfo'))
      const a = doc.getPages()[0]!.node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict)
      a.delete(PDFName.of('REDBEAM'))
    })
    const reading = await readSheetEmbed(stripped)
    expect(reading.slice).toBeNull()
    expect(reading.privateDataLost).toBe(true)
    expect(reading.redbeamAnnots).toHaveLength(1)

    // Writing again recovers cleanly: no duplicate of the markup.
    const again = await embedSheet(stripped, input())
    expect(await pageAnnots(again.bytes!)).toHaveLength(1)
  })

  it('keeps another app\'s PieceInfo and viewports', async () => {
    const source = await resaveElsewhere(await blank(false), (doc) => {
      doc.catalog.set(PDFName.of('PieceInfo'), doc.context.obj({ Other: doc.context.obj({ X: 1 }) }))
      doc.getPages()[0]!.node.set(PDFName.of('VP'), doc.context.obj([
        doc.context.obj({ Type: 'Viewport', BBox: [0, 0, 100, 100], Name: PDFString.of('Detail 3') }),
      ]))
    })
    const { bytes } = await embedSheet(source, input())
    const doc = await PDFDocument.load(bytes!)
    const pi = doc.catalog.lookup(PDFName.of('PieceInfo'), PDFDict)
    expect(pi.has(PDFName.of('Other'))).toBe(true)
    expect(pi.has(PDFName.of('REDBEAM'))).toBe(true)
    const vp = doc.getPages()[0]!.node.lookup(PDFName.of('VP'), PDFArray)
    expect(vp.size()).toBe(2)
    expect(str(vp.lookup(0, PDFDict), 'Name')).toBe('Detail 3')
  })
})

describe('a sheet turned in REDBEAM', () => {
  it('writes /Rotate onto the page and places the takeoff through it', async () => {
    const turned = { ...input(), pageRotations: new Map([[0, 90]]) }
    const { bytes } = await embedSheet(await blank(false), turned)
    expect(bytes).not.toBeNull()
    const doc = await PDFDocument.load(bytes!)
    expect(doc.getPages()[0]!.getRotation().angle).toBe(90)
    expect(doc.getPages()[1]!.getRotation().angle).toBe(0)
    // Read back through the page's rotation, the area is where it was drawn.
    const back = await readSheetEmbed(bytes!)
    const ring = back.redbeamAnnots.find((a) => a.markupId === 'm1')!.rings[0]!
    for (const p of area('m1').rings[0]!) {
      expect(ring.some((q) => Math.abs(q.x - p.x) < 1e-3 && Math.abs(q.y - p.y) < 1e-3)).toBe(true)
    }
  })

  it('writes again when only the rotation changed, and not once it matches', async () => {
    const first = await embedSheet(await blank(false), input())
    const same = await embedSheet(first.bytes!, input())
    expect(same.bytes).toBeNull()
    const turned = await embedSheet(first.bytes!, { ...input(), pageRotations: new Map([[0, 270]]) })
    expect(turned.bytes).not.toBeNull()
    const again = await embedSheet(turned.bytes!, { ...input(), pageRotations: new Map([[0, 270]]) })
    expect(again.bytes).toBeNull()
  })
})

describe('a working copy without the other markups (round 3 #13)', () => {
  it('takes every other app\'s markup off and keeps links and REDBEAM\'s own', async () => {
    const first = await embedSheet(await blank(true), input())
    const revu = await resaveElsewhere(first.bytes!, (doc) => {
      const page = doc.getPages()[0]!
      const arr = page.node.lookup(PDFName.of('Annots'), PDFArray)
      arr.push(doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 100, 100], NM: PDFString.of('DAVE1') })))
      arr.push(doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [10, 10, 100, 100], NM: PDFString.of('DAVE2') })))
      arr.push(doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 100], NM: PDFString.of('LINK') })))
    })
    const copy = await embedSheet(revu, { ...input(), retireForeign: true })
    expect(copy.bytes).not.toBeNull()
    const nms = (await pageAnnots(copy.bytes!)).map((a) => str(a, 'NM')).sort()
    expect(nms).toEqual(['LINK', redbeamNm('m1')].sort())
    // And a plain save keeps them.
    const plain = await embedSheet(revu, input([area('m1'), area('m2')]))
    expect((await pageAnnots(plain.bytes!)).map((a) => str(a, 'NM'))).toContain('DAVE1')
  })
})

describe('sheet names read off the title block', () => {
  const withLabels = (labels: Array<string | null>): EmbedInput => {
    const base = input()
    return { ...base, tables: { ...base.tables, redbeam_meta: [{ key: 'sheet_labels', value: JSON.stringify(labels) }] } }
  }
  const labelsIn = async (bytes: Uint8Array): Promise<unknown[]> => {
    const doc = await PDFDocument.load(bytes)
    const tree = doc.catalog.lookup(PDFName.of('PageLabels'), PDFDict)
    const nums = tree.lookup(PDFName.of('Nums'), PDFArray)
    return Array.from({ length: nums.size() }, (_, i) => {
      const v = nums.lookup(i)
      if (v instanceof PDFNumber) return v.asNumber()
      const d = v as PDFDict
      const p = d.lookup(PDFName.of('P'))
      if (p !== undefined) return { P: (p as PDFString).decodeText() }
      return { S: (d.lookup(PDFName.of('S')) as PDFName).decodeText(), St: (d.lookup(PDFName.of('St')) as PDFNumber).asNumber() }
    })
  }

  it('go into the PDF as page labels, so Bluebeam names the pages too', async () => {
    const out = await embedSheet(await blank(false), withLabels(['IX0510 - INDEX OF DRAWINGS', 'A3001 - OVERALL SITE PLAN']))
    expect(await labelsIn(out.bytes!)).toEqual([0, { P: 'IX0510 - INDEX OF DRAWINGS' }, 1, { P: 'A3001 - OVERALL SITE PLAN' }])
    // And they survive another app's full rewrite.
    expect(await labelsIn(await resaveElsewhere(out.bytes!))).toEqual([0, { P: 'IX0510 - INDEX OF DRAWINGS' }, 1, { P: 'A3001 - OVERALL SITE PLAN' }])
  })

  it('number a page the boxes could not read by its position', async () => {
    const out = await embedSheet(await blank(true), withLabels([null, 'A3001 - OVERALL SITE PLAN']))
    expect(await labelsIn(out.bytes!)).toEqual([0, { S: 'D', St: 1 }, 1, { P: 'A3001 - OVERALL SITE PLAN' }])
  })

  it('keep a name with an en dash or accent intact', async () => {
    const out = await embedSheet(await blank(false), withLabels(['A–101 – CAFÉ PLAN', null]))
    const doc = await PDFDocument.load(out.bytes!)
    const nums = doc.catalog.lookup(PDFName.of('PageLabels'), PDFDict).lookup(PDFName.of('Nums'), PDFArray)
    const p = (nums.lookup(1) as PDFDict).lookup(PDFName.of('P')) as unknown as { decodeText(): string }
    expect(p.decodeText()).toBe('A–101 – CAFÉ PLAN')
  })

  const bookmarks = async (bytes: Uint8Array): Promise<unknown[]> => {
    const doc = await PDFDocument.load(bytes)
    const pageOf = new Map(doc.getPages().map((p, i) => [p.ref.toString(), i]))
    const root = doc.catalog.lookup(PDFName.of('Outlines'))
    const walk = (holder: PDFDict): unknown[] => {
      const out: unknown[] = []
      let ref = holder.get(PDFName.of('First'))
      while (ref !== undefined) {
        const d = doc.context.lookup(ref) as PDFDict
        const t = (d.lookup(PDFName.of('Title')) as unknown as { decodeText(): string }).decodeText()
        const dest = d.lookup(PDFName.of('Dest'))
        const page = dest instanceof PDFArray ? pageOf.get(dest.get(0).toString()) ?? null : null
        const kids = walk(d)
        out.push(kids.length > 0 ? { t, kids } : `${page}:${t}`)
        ref = d.get(PDFName.of('Next'))
      }
      return out
    }
    return root instanceof PDFDict ? walk(root) : []
  }
  const userBookmark = (doc: PDFDocument, title: string, page: number): void => {
    const ctx = doc.context
    const root = ctx.obj({ Type: 'Outlines' }) as PDFDict
    const rootRef = ctx.register(root)
    const item = ctx.register(ctx.obj({ Title: PDFString.of(title), Parent: rootRef, Dest: [doc.getPages()[page]!.ref, PDFName.of('Fit')] }))
    root.set(PDFName.of('First'), item)
    root.set(PDFName.of('Last'), item)
    root.set(PDFName.of('Count'), PDFNumber.of(1))
    doc.catalog.set(PDFName.of('Outlines'), rootRef)
  }

  it('become bookmarks too, one per named sheet in page order, which Bluebeam lists', async () => {
    const out = await embedSheet(await blank(false), withLabels(['IX0510 - INDEX', 'A3001 - SITE PLAN']))
    expect(await bookmarks(out.bytes!)).toEqual(['0:IX0510 - INDEX', '1:A3001 - SITE PLAN'])
    const doc = await PDFDocument.load(out.bytes!)
    expect((doc.catalog.lookup(PDFName.of('Outlines'), PDFDict).lookup(PDFName.of('Count')) as PDFNumber).asNumber()).toBe(2)
  })

  it('replace their own bookmarks when the names change, never doubling them', async () => {
    const first = await embedSheet(await blank(false), withLabels(['A1 - OLD', 'A2 - PLAN']))
    const second = await embedSheet(first.bytes!, { ...withLabels(['A1 - NEW', null]), now: () => new Date('2026-11-13T20:00:00Z') })
    expect(await bookmarks(second.bytes!)).toEqual(['0:A1 - NEW'])
  })

  it('recognise their bookmarks after another app rewrote the file and dropped the mark', async () => {
    const first = await embedSheet(await blank(false), withLabels(['A1 - PLAN', 'A2 - RCP']))
    const revu = await resaveElsewhere(first.bytes!, (doc) => {
      const root = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict)
      let ref = root.get(PDFName.of('First'))
      while (ref !== undefined) {
        const d = doc.context.lookup(ref) as PDFDict
        d.delete(PDFName.of('RedbeamSheet'))
        ref = d.get(PDFName.of('Next'))
      }
    })
    const again = await embedSheet(revu, { ...withLabels(['A1 - PLAN', 'A2 - CEILING PLAN']), now: () => new Date('2026-11-13T20:00:00Z') })
    expect(await bookmarks(again.bytes!)).toEqual(['0:A1 - PLAN', '1:A2 - CEILING PLAN'])
  })

  it('keep the bookmarks someone else made, with the sheets in their own folder', async () => {
    const src = await resaveElsewhere(await blank(false), (doc) => userBookmark(doc, 'Check this detail', 1))
    const out = await embedSheet(src, withLabels(['A1 - PLAN', 'A2 - RCP']))
    expect(await bookmarks(out.bytes!)).toEqual([{ t: 'Sheets', kids: ['0:A1 - PLAN', '1:A2 - RCP'] }, '1:Check this detail'])
    const again = await embedSheet(out.bytes!, { ...withLabels(['A1 - PLAN', 'A2 - RCP 2']), now: () => new Date('2026-11-13T20:00:00Z') })
    expect(await bookmarks(again.bytes!)).toEqual([{ t: 'Sheets', kids: ['0:A1 - PLAN', '1:A2 - RCP 2'] }, '1:Check this detail'])
  })

  it('are written into a file saved before bookmarks, even with nothing else changed', async () => {
    const first = await embedSheet(await blank(false), withLabels(['A1 - PLAN', null]))
    const stripped = await resaveElsewhere(first.bytes!, (doc) => doc.catalog.delete(PDFName.of('Outlines')))
    const again = await embedSheet(stripped, withLabels(['A1 - PLAN', null]))
    expect(again.bytes).not.toBeNull()
    expect(await bookmarks(again.bytes!)).toEqual(['0:A1 - PLAN'])
    // And once they are there, an unchanged save writes nothing.
    expect((await embedSheet(again.bytes!, withLabels(['A1 - PLAN', null]))).bytes).toBeNull()
  })

  it('write the bookmarks edited in Contents, coloured, after the Sheets folder, and read them back', async () => {
    const src = await resaveElsewhere(await blank(false), (doc) => userBookmark(doc, 'Check this detail', 1))
    const first = await embedSheet(src, withLabels(['A1 - PLAN', 'A2 - RCP']))
    const read = (await readSheetEmbed(first.bytes!)).bookmarks!
    expect(read.map((b) => [b.title, b.page, b.color])).toEqual([['Check this detail', 1, null]])
    // Recoloured, renamed and bolded, with a folder and a view bookmark added.
    const edited: FileBookmark[] = [
      { ...read[0]!, title: 'Check this detail!', color: '#d13438', bold: true },
      {
        id: 'new-1', title: 'Ceilings', page: null, view: null, color: '#0f6cbd', bold: false, italic: true, src: null,
        children: [{ id: 'new-2', title: 'Corridor', page: 0, view: { x: 100, y: 200, zoom: 1.5 }, color: null, bold: false, italic: false, src: null, children: [] }],
      },
    ]
    const out = await embedSheet(first.bytes!, { ...withLabels(['A1 - PLAN', 'A2 - RCP']), bookmarks: edited, now: () => new Date('2026-11-13T20:00:00Z') })
    expect(out.bytes).not.toBeNull()
    expect(await bookmarks(out.bytes!)).toEqual([
      { t: 'Sheets', kids: ['0:A1 - PLAN', '1:A2 - RCP'] }, '1:Check this detail!', { t: 'Ceilings', kids: ['0:Corridor'] },
    ])
    const back = (await readSheetEmbed(out.bytes!)).bookmarks!
    expect(back.map((b) => [b.title, b.color, b.bold, b.italic])).toEqual([
      ['Check this detail!', '#d13438', true, false], ['Ceilings', '#0f6cbd', false, true],
    ])
    expect(back[1]!.children[0]).toMatchObject({ title: 'Corridor', page: 0, view: { x: 100, y: 200, zoom: 1.5 } })
    // The publisher's own object was reused, not copied.
    expect(back[0]!.src).toBe(read[0]!.src)
    // Saved again with the same list: nothing to write.
    expect((await embedSheet(out.bytes!, { ...withLabels(['A1 - PLAN', 'A2 - RCP']), bookmarks: back })).bytes).toBeNull()
    // And it survives another app's full rewrite.
    const revu = (await readSheetEmbed(await resaveElsewhere(out.bytes!))).bookmarks!
    expect(revu.map((b) => b.title)).toEqual(['Check this detail!', 'Ceilings'])
  })

  it('write edited bookmarks into a file with no sheet names, keeping a publisher bookmark that matches a label', async () => {
    const src = await resaveElsewhere(await blank(false), (doc) => userBookmark(doc, 'Plan', 0))
    const read = (await readSheetEmbed(src)).bookmarks!
    expect(read.map((b) => b.title)).toEqual(['Plan'])
    const out = await embedSheet(src, { ...input(), bookmarks: [...read, { ...read[0]!, id: 'new-9', src: null, title: 'Also', page: 1 }] })
    expect(await bookmarks(out.bytes!)).toEqual(['0:Plan', '1:Also'])
    // Every bookmark deleted: the outline is emptied, not left as it was.
    const none = await embedSheet(out.bytes!, { ...input(), bookmarks: [], now: () => new Date('2026-11-13T20:00:00Z') })
    expect(await bookmarks(none.bytes!)).toEqual([])
  })

  it('leave the file’s labels alone when nothing was read', async () => {
    const out = await embedSheet(await blank(false), input())
    const doc = await PDFDocument.load(out.bytes!)
    expect(doc.catalog.lookup(PDFName.of('PageLabels'))).toBeUndefined()
  })
})
