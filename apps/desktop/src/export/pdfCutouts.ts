/**
 * Bluebeam's area cutouts, read from the PDF itself.
 *
 * Revu stores an Area measurement with holes as ONE /Polygon annotation: the
 * boundary in /Vertices, as usual, and every cutout in a private /Cutouts key,
 * an array of flat [x1 y1 x2 y2 …] vertex arrays in the same page space:
 *
 *   /Subtype /Polygon /IT /PolygonDimension /Subj (Area Measurement)
 *   /Vertices [ … ]
 *   /Cutouts [[469.92 962.28 344.28 962.28 344.28 907.5601 469.92 907.5601]]
 *
 * (Observed in Revu-saved sets, Producer "Bluebeam Brewery 5.0", 2026-11-16.)
 * The /Measure, /Contents and appearance already account for the holes; a
 * reader that takes only /Vertices measures the whole outline. Aaron,
 * 2026-11-16: converting Bluebeam areas with cutouts lost the cutouts.
 *
 * PDFium has no call that reads an arbitrary array, so the viewer only flags
 * which annotations carry the key (`PageAnnotation.hasCutouts`) and the rings
 * are read here, with pdf-lib, from the file's bytes. Each becomes a REDBEAM
 * cutout markup beside the converted area, which is how a hole is modelled
 * here (domain/scope.ts clips and subtracts it).
 */

import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib'
import type { PageAnnotation, PageBox } from '@redbeam/viewer'

export interface Point {
  x: number
  y: number
}

/** One annotation's cutouts as stored: page space, y up. */
export interface RawCutouts {
  /** Index in the page's /Annots array, which is PDFium's annotation index. */
  index: number
  /** /NM, '' when absent. */
  name: string
  rings: Point[][]
}

function textOf(d: PDFDict, key: string): string {
  const v = d.lookup(PDFName.of(key))
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : ''
}

/** A flat [x y x y …] array as points. Odd counts and non-numbers end it. */
function flatPoints(arr: PDFArray): Point[] {
  const nums: number[] = []
  for (let i = 0; i < arr.size(); i++) {
    const n = arr.lookup(i)
    if (!(n instanceof PDFNumber)) return []
    nums.push(n.asNumber())
  }
  const out: Point[] = []
  for (let i = 0; i + 1 < nums.length; i += 2) out.push({ x: nums[i]!, y: nums[i + 1]! })
  return out
}

/**
 * The /Cutouts value as rings. Revu nests one array per cutout; a single flat
 * array is accepted too, as one ring, so a writer that stored a lone cutout
 * without the outer array is not lost. Rings under three points are dropped.
 */
export function cutoutRingsOf(value: unknown): Point[][] {
  if (!(value instanceof PDFArray) || value.size() === 0) return []
  const first = value.lookup(0)
  if (first instanceof PDFNumber) {
    const ring = flatPoints(value)
    return ring.length >= 3 ? [ring] : []
  }
  const out: Point[][] = []
  for (let i = 0; i < value.size(); i++) {
    const inner = value.lookup(i)
    if (!(inner instanceof PDFArray)) continue
    const ring = flatPoints(inner)
    if (ring.length >= 3) out.push(ring)
  }
  return out
}

/** Every annotation on one page that carries /Cutouts. */
export function readPageCutouts(doc: PDFDocument, pageIndex: number): RawCutouts[] {
  if (pageIndex < 0 || pageIndex >= doc.getPageCount()) return []
  const arr = doc.getPage(pageIndex).node.lookup(PDFName.of('Annots'))
  if (!(arr instanceof PDFArray)) return []
  const out: RawCutouts[] = []
  for (let i = 0; i < arr.size(); i++) {
    const a = arr.lookup(i)
    if (!(a instanceof PDFDict)) continue
    const rings = cutoutRingsOf(a.lookup(PDFName.of('Cutouts')))
    if (rings.length > 0) out.push({ index: i, name: textOf(a, 'NM'), rings })
  }
  return out
}

export async function readPdfCutouts(bytes: Uint8Array, pageIndex: number): Promise<RawCutouts[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false, ignoreEncryption: true })
  return readPageCutouts(doc, pageIndex)
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Page-space points to the normalized, y-down frame every markup is stored in. */
export function normalizeRing(ring: readonly Point[], box: PageBox): Point[] {
  const w = box.right - box.left
  const h = box.top - box.bottom
  if (!(w > 0) || !(h > 0)) return []
  return ring.map((p) => ({ x: clamp01((p.x - box.left) / w), y: clamp01((box.top - p.y) / h) }))
}

/**
 * The cutout rings that belong to `a`, normalized like its vertices.
 *
 * Matched by annotation index, which PDFium and the /Annots array share; the
 * /NM is checked when both sides have one, and used to find the entry when
 * the index disagrees, so a list read from a different revision of the file
 * cannot hand one area another's holes.
 */
export function cutoutsFor(a: PageAnnotation, found: readonly RawCutouts[]): Point[][] {
  if (!a.hasCutouts) return []
  let hit = found.find((f) => f.index === a.index)
  if (a.name !== '' && (hit === undefined || (hit.name !== '' && hit.name !== a.name))) {
    hit = found.find((f) => f.name === a.name)
  }
  if (hit === undefined) return []
  return hit.rings.map((r) => normalizeRing(r, a.pageBox)).filter((r) => r.length >= 3)
}
