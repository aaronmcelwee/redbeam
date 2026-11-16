import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFString, type PDFDict } from 'pdf-lib'
import { areaSquareFeet, type Markup } from '@redbeam/domain'
import { cutoutRingsOf, normalizeToBox, readAnnotCutouts } from './annotCutouts.js'

/*
 * An area measurement exactly as Revu saved it on the CAT Walnut Hill RCP,
 * page 3 (3456 x 2592 pt, 1/8" = 1'-0"): CLG-7, three openings, and Revu's
 * own net figure in /Contents, "4,668.74 sf".
 */
const VERTICES = [1119.767, 858.5793, 1119.642, 858.3295, 1750.44, 854.2808, 1750.44, 899.0399, 1349.88, 898.5601, 1120.2, 898.5601, 1120.2, 1025.4, 1343.04, 1028.04, 1828.32, 1028.762, 2335.797, 1028.762, 2335.797, 896.2798, 1926.48, 896.2798, 1926.48, 854.2808, 2378.616, 855.8411, 2378.616, 1511.929, 485.88, 1512.36, 485.88, 854.2808, 934.6801, 854.2808, 934.6801, 898.5601, 530.76, 898.5601, 530.76, 1028.76, 975.6, 1028.76, 975.5876, 1028.124, 1118.996, 1028.447, 1119.892, 870.2589]
const CUTOUTS = [
  [532.6799, 1455.24, 532.6799, 1093.797, 1075.32, 1093.797, 1075.32, 1455.24],
  [1116.84, 1454.76, 1116.84, 1093.797, 1570.56, 1093.797, 1570.56, 1454.76],
  [2335.797, 1454.52, 1611.12, 1454.52, 1611.12, 1107.839, 1612.44, 1093.8, 1639.2, 1093.8, 1639.2, 1107.839, 2146.661, 1107.839, 2146.661, 1094.399, 2337.126, 1094.399, 2337.126, 1120.799],
]
const W = 3456
const H = 2592
const BOX = { left: 0, bottom: 0, right: W, top: H }

async function revuSheet(): Promise<{ bytes: Uint8Array }> {
  const doc = await PDFDocument.create()
  doc.addPage([W, H])
  const page = doc.addPage([W, H])
  const ctx = doc.context
  const cloud = ctx.obj({ Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 50, 50], NM: PDFString.of('AAAAAAAAAAAAAAAA') })
  const area = ctx.obj({
    Type: 'Annot', Subtype: 'Polygon', IT: 'PolygonDimension',
    Subj: PDFString.of('Area Measurement'), Label: PDFString.of('CLG-7'),
    Contents: PDFString.of('CLG-7\r4,668.74 sf'), NM: PDFString.of('TFXKHCPSIURYRZRT'),
    Rect: [480.3797, 848.7808, 2384.116, 1517.86], Vertices: VERTICES, Cutouts: CUTOUTS,
  })
  const plain = ctx.obj({ Type: 'Annot', Subtype: 'Polygon', Rect: [0, 0, 10, 10], Vertices: [0, 0, 10, 0, 10, 10] })
  page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(cloud), ctx.register(area), ctx.register(plain)]))
  return { bytes: await doc.save() }
}

const pairs = (flat: number[]): Array<{ x: number; y: number }> => {
  const out = []
  for (let i = 0; i < flat.length; i += 2) out.push({ x: flat[i]!, y: flat[i + 1]! })
  return out
}

describe('Bluebeam area cutouts', () => {
  it('reads every opening, normalized the way the viewer normalizes /Vertices', async () => {
    const { bytes } = await revuSheet()
    const got = await readAnnotCutouts(bytes, 1, [{ index: 1, name: 'TFXKHCPSIURYRZRT' }, { index: 2, name: '' }])
    expect([...got.keys()]).toEqual([1])
    const rings = got.get(1)!
    expect(rings).toHaveLength(3)
    expect(rings.map((r) => r.length)).toEqual([4, 4, 10])
    expect(rings[0]![0]!.x).toBeCloseTo(532.6799 / W, 9)
    expect(rings[0]![0]!.y).toBeCloseTo((H - 1455.24) / H, 9)
  })

  it('finds the annotation by /NM when the index has moved', async () => {
    const { bytes } = await revuSheet()
    const got = await readAnnotCutouts(bytes, 1, [{ index: 0, name: 'TFXKHCPSIURYRZRT' }])
    expect(got.get(0)).toHaveLength(3)
  })

  it('returns nothing for a page or annotation without cutouts', async () => {
    const { bytes } = await revuSheet()
    expect((await readAnnotCutouts(bytes, 0, [{ index: 0, name: '' }])).size).toBe(0)
    expect((await readAnnotCutouts(bytes, 1, [{ index: 0, name: 'AAAAAAAAAAAAAAAA' }])).size).toBe(0)
    expect((await readAnnotCutouts(bytes, 9, [{ index: 1, name: '' }])).size).toBe(0)
  })

  it('drops a malformed opening and keeps the rest', async () => {
    const doc = await PDFDocument.create()
    const a = doc.context.obj({ Subtype: 'Polygon', Cutouts: [[1, 2, 3], [0, 0, 1, 0], [0, 0, 4, 0, 4, 4]] }) as PDFDict
    expect(cutoutRingsOf(a)).toEqual([[{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }]])
  })

  it('converted as an area plus cutout markups, nets to the figure Revu printed', () => {
    // 1/8" = 1'-0": one point is 1/9 ft.
    const cal = { feetPerPoint: 1 / 9, pageWidth: W, pageHeight: H }
    const norm = (flat: number[]) => pairs(flat).map((p) => normalizeToBox(p, BOX))
    const base = { scopeId: 's', documentId: 'd', pageId: 'p' }
    const markups: Markup[] = [
      { ...base, id: 'area', kind: 'area', rings: [norm(VERTICES)] },
      ...CUTOUTS.map((c, i): Markup => ({ ...base, id: `cut${i}`, kind: 'cutout', rings: [norm(c)] })),
    ]
    const net = areaSquareFeet(markups, cal)
    expect(net).toBeCloseTo(4668.74, 0)
    const gross = areaSquareFeet([markups[0]!], cal)
    expect(gross - net).toBeGreaterThan(5000)
  })

  it('maps an origin-centred page box like annots.ts does', () => {
    const box = { left: -1728, bottom: -1296, right: 1728, top: 1296 }
    expect(normalizeToBox({ x: 0, y: 0 }, box)).toEqual({ x: 0.5, y: 0.5 })
    expect(normalizeToBox({ x: 1728, y: 1296 }, box)).toEqual({ x: 1, y: 0 })
  })
})
