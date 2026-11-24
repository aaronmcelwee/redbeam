import { describe, expect, it } from 'vitest'
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream, type PDFPage } from 'pdf-lib'
import { documentNames, renderEstimatePdf, runningTitle } from './estimatePdf.js'
import type { EstimateExport } from './estimateExport.js'

const estimate: EstimateExport = {
  projectName: 'Barclays: Toronto',
  estimateName: '260529 - Initial Bid',
  subtitle: 'Issued for pricing',
  documents: ['AE6 CEILING SET.pdf'],
  generatedAt: new Date('2026-09-04T12:00:00Z'),
  scopes: [
    {
      id: 's1', label: 'C-MT-01', product: 'Panels', color: '#ff4d4d', note: 'Alt 2 excludes the lobby.',
      quantities: [{ label: 'Area', quantity: 4128.83, unit: 'SF' }],
      components: [
        { label: 'Panels', quantity: 662, unit: 'EA', confidence: 'verified', note: null },
        { label: 'Rails', quantity: 54, unit: 'EA', confidence: 'unverified', note: 'no golden fixture' },
      ],
      markupCount: 3, sheets: ['A-101', 'A-104'],
    },
    {
      id: 's2', label: 'WP-12', product: 'Planks', color: '#39a2ff', note: '',
      quantities: [], components: [], markupCount: 0, sheets: [],
    },
  ],
}

/** Kenneth's file, 2026-11-24, which the cover set twice and ran off the page. */
const FILE = 'A-351B-FLOOR-01---SECTOR-B-EXTERIOR-REFLECTED-CEILING-PLAN-REV.3  M2-M5 BULL009 FO-VT 5-02-26'

/** Every piece of text a page sets: where it starts, how large, and what it says. */
function textOn(page: PDFPage): Array<{ text: string; x: number; size: number }> {
  const contents = page.node.lookup(PDFName.of('Contents'))
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => page.doc.context.lookup(r as PDFRef)) : [contents]
  const src = streams.map((s) => new TextDecoder('latin1').decode(decodePDFRawStream(s as PDFRawStream).decode())).join('\n')
  const out: Array<{ text: string; x: number; size: number }> = []
  for (const m of src.matchAll(/\/\S+ ([\d.]+) Tf[\s\S]*?(-?[\d.]+) (-?[\d.]+) Tm\s*<([0-9A-Fa-f]*)> Tj/g)) {
    const hex = m[4]!
    const codes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < codes.length; i++) codes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
    // The standard fonts set WinAnsi: an em dash is 0x97, an ellipsis 0x85.
    out.push({ text: new TextDecoder('windows-1252').decode(codes), x: Number(m[2]), size: Number(m[1]) })
  }
  return out
}

describe('documentNames', () => {
  it('sets a name once when the estimate is named after the file', () => {
    expect(documentNames({ projectName: FILE, estimateName: FILE })).toEqual({ title: FILE.replace(/\s+/g, ' '), second: '' })
    expect(documentNames({ projectName: 'Scottsdale', estimateName: 'scottsdale' })).toEqual({ title: 'Scottsdale', second: '' })
  })

  it('keeps the longer of two names when one holds the other', () => {
    expect(documentNames({ projectName: 'Scottsdale', estimateName: 'Scottsdale round 2' })).toEqual({ title: 'Scottsdale round 2', second: '' })
    expect(documentNames({ projectName: FILE, estimateName: 'A-351B-FLOOR-01' })).toEqual({ title: FILE.replace(/\s+/g, ' '), second: '' })
  })

  it('sets both when they say different things, and something when both are empty', () => {
    expect(documentNames({ projectName: 'CrowdStrike Scottsdale', estimateName: 'Level 03 ceilings' }))
      .toEqual({ title: 'CrowdStrike Scottsdale', second: 'Level 03 ceilings' })
    expect(documentNames({ projectName: '  ', estimateName: '' }).title).toBe('Takeoff')
    expect(runningTitle({ projectName: 'A', estimateName: 'B' })).toBe('A · B')
  })
})

describe('renderEstimatePdf', () => {
  it('makes a cover, the quantities and the notes, on Letter landscape', async () => {
    const bytes = await renderEstimatePdf({ estimate, notes: ['One sheet could not be read.'] })
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-')
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(3)
    expect(doc.getTitle()).toBe('Barclays: Toronto · 260529 - Initial Bid')
    expect(doc.getAuthor()).toBe('Maxxit')
    for (const page of doc.getPages()) {
      expect(page.getWidth()).toBe(792)
      expect(page.getHeight()).toBe(612)
    }
  })

  it('needs no pictures and no notes to make a document', async () => {
    const doc = await PDFDocument.load(await renderEstimatePdf({ estimate }))
    expect(doc.getPageCount()).toBe(2)
  })

  it('keeps a long file name on the page, said once', async () => {
    const long = { ...estimate, projectName: FILE, estimateName: FILE, documents: [`${FILE}.pdf`] }
    const doc = await PDFDocument.load(await renderEstimatePdf({ estimate: long }))
    expect(doc.getTitle()).toBe(FILE.replace(/\s+/g, ' '))
    const bold = await doc.embedFont(StandardFonts.HelveticaBold)
    for (const page of doc.getPages()) {
      for (const t of textOn(page)) {
        // Measured in the wider of the two faces: nothing reaches past the right margin.
        expect(t.x + bold.widthOfTextAtSize(t.text, t.size)).toBeLessThanOrEqual(792 - 46 + 0.5)
      }
    }
    const cover = textOn(doc.getPage(0)).map((t) => t.text).join('\n')
    // The name is on the cover once, broken after its hyphens, not twice.
    expect(cover.match(/A-351B-FLOOR-01/g)).toHaveLength(2) // the title, and the drawing it came from
    expect(cover).toContain('A-351B-FLOOR-01---SECTOR-B-')
  })

  it('says which takeoff is in no quantity because its sheet has no scale', async () => {
    const unscaled: EstimateExport = {
      ...estimate,
      scopes: [{ ...estimate.scopes[1]!, markupCount: 2, sheets: ['A3.100'], unscaledSheets: ['A3.100'] }],
    }
    const doc = await PDFDocument.load(await renderEstimatePdf({ estimate: unscaled }))
    const quantities = textOn(doc.getPage(1)).map((t) => t.text).join(' ')
    expect(quantities).toContain('Not measured: A3.100')
    expect(quantities).toContain('No scale')
    expect(quantities).not.toContain('No takeoff yet')
    expect(textOn(doc.getPage(0)).map((t) => t.text).join(' ')).toContain('No scale')
  })

  it('paginates a long round instead of drawing off the page', async () => {
    const long: EstimateExport = {
      ...estimate,
      scopes: Array.from({ length: 40 }, (_, i) => ({ ...estimate.scopes[0]!, id: `s${i}`, label: `SCOPE-${i}`, note: '' })),
    }
    const doc = await PDFDocument.load(await renderEstimatePdf({ estimate: long }))
    expect(doc.getPageCount()).toBeGreaterThan(3)
  })
})
