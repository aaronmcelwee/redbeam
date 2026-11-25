import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { embedSheet, readSheetEmbed, sliceText, type EmbedInput } from './sheetEmbed.js'

// The Hyundai set's scope names: an em dash, and a finish with an accent.
const NAME = 'C-5 Akustus Cargo equiv. — Café 658 — ALT'
const SPECS = { productType: 'baffle', finish: 'Sandstone SP12 “matte”', mark: 'C-5' }

async function blank(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([2592, 1728])
  return doc.save()
}

const input = (): EmbedInput => ({
  documentId: 'doc-1',
  relativePath: 'A-101.pdf',
  displayName: 'A-101',
  appVersion: '0.3.82',
  tables: {
    markups: [{ id: 'm1', kind: 'area' }],
    scopes: [{ id: 's1', label: NAME, specifications_json: JSON.stringify(SPECS) }],
  },
  markups: [{
    id: 'm1', pageIndex: 0, kind: 'area',
    rings: [[{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }, { x: 0.3, y: 0.3 }, { x: 0.1, y: 0.3 }]],
    scopeLabel: NAME, color: '#2f7fd1', quantity: 120,
  }],
  pageScales: new Map([[0, 8 / 72]]),
  now: () => new Date('2026-11-25T15:00:00Z'),
})

/** What builds before 0.3.82 put in the stream: each character's low byte. */
const lowBytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff)

describe('non-ASCII text in the takeoff', () => {
  it('survives a save: the slice keeps product details and the label keeps its dash', async () => {
    const { bytes } = await embedSheet(await blank(), input())
    const reading = await readSheetEmbed(bytes!)
    expect(reading.privateDataLost).toBe(false)
    const scope = reading.slice!.tables.scopes![0] as { label: string, specifications_json: string }
    expect(scope.label).toBe(NAME)
    expect(JSON.parse(scope.specifications_json)).toEqual(SPECS)
    expect(reading.redbeamAnnots[0]!.label).toBe(NAME)
  })

  it('reads a slice the old writer cut to low bytes', () => {
    const json = JSON.stringify({ label: NAME, specs: SPECS, dash: '–', quote: '‘x’' })
    expect(JSON.parse(sliceText(lowBytes(json)))).toEqual(JSON.parse(json))
    // Dashes only, no accent: the bytes are valid UTF-8 but carry control bytes.
    const dashes = JSON.stringify({ label: 'Cafe 658 — ALT' })
    expect(JSON.parse(sliceText(lowBytes(dashes)))).toEqual(JSON.parse(dashes))
  })

  it('leaves a slice written as UTF-8 exactly as it was', () => {
    const json = JSON.stringify({ label: NAME, line: 'a\nb', emoji: '📐' })
    expect(sliceText(new TextEncoder().encode(json))).toBe(json)
  })
})
