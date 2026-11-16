/**
 * The cutouts of a Bluebeam area measurement.
 *
 * Aaron, 2026-11-16: "I'm unable to convert markup area takeoff markups from
 * Bluebeam with cutouts into Redbeam markups with cutouts." Converting kept
 * the outer boundary only, so every opening came back as floor.
 *
 * Revu keeps an area's cutouts on the Polygon annotation itself, as a private
 * key next to /Vertices, in the same page space and the same flat x y form
 * (read off a Revu save of the CAT Walnut Hill RCP, page 3):
 *
 *   /Subtype /Polygon  /IT /PolygonDimension  /Subj (Area Measurement)
 *   /Vertices [1119.767 858.5793 1119.642 858.3295 ...]
 *   /Cutouts [[532.6799 1455.24 532.6799 1093.797 1075.32 1093.797 1075.32 1455.24]
 *             [1116.84 1454.76 ...] [2335.797 1454.52 ...]]
 *
 * One array per opening. /Contents ("4,668.74 sf") is already the NET area.
 *
 * PDFium can say the key is there (FPDFAnnot_HasKey) but has no call that
 * reads an array out of an annotation dictionary, so the file is read here
 * with pdf-lib, and only when some annotation being converted has cutouts.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib'

export interface NormPoint {
  x: number
  y: number
}

/** Which annotation: its index in the page's /Annots and its /NM. */
export interface CutoutTarget {
  index: number
  name: string
}

/** A page box in PDF user space, y up. */
export interface UserBox {
  left: number
  bottom: number
  right: number
  top: number
}

const numbersOf = (v: unknown): number[] | null => {
  if (!(v instanceof PDFArray)) return null
  const out: number[] = []
  for (let i = 0; i < v.size(); i++) {
    const n = v.lookup(i)
    if (!(n instanceof PDFNumber)) return null
    out.push(n.asNumber())
  }
  return out
}

/**
 * /Cutouts as rings of page-space points. A ring with fewer than three points,
 * an odd number of coordinates or anything that is not a number is dropped:
 * one bad opening must not lose the others.
 */
export function cutoutRingsOf(annot: PDFDict): Array<Array<{ x: number; y: number }>> {
  const list = annot.lookup(PDFName.of('Cutouts'))
  if (!(list instanceof PDFArray)) return []
  const out: Array<Array<{ x: number; y: number }>> = []
  for (let i = 0; i < list.size(); i++) {
    const flat = numbersOf(list.lookup(i))
    if (flat === null || flat.length % 2 !== 0 || flat.length < 6) continue
    if (!flat.every(Number.isFinite)) continue
    const ring: Array<{ x: number; y: number }> = []
    for (let k = 0; k < flat.length; k += 2) ring.push({ x: flat[k]!, y: flat[k + 1]! })
    out.push(ring)
  }
  return out
}

/**
 * Page space to the viewer's normalized space: [0,1] across the page box,
 * y down. The same mapping annots.ts applies to /Vertices, so an opening
 * lands exactly where it was drawn relative to its area.
 */
export function normalizeToBox(p: { x: number; y: number }, box: UserBox): NormPoint {
  const w = box.right - box.left
  const h = box.top - box.bottom
  if (!(w > 0) || !(h > 0)) return { x: 0, y: 0 }
  return { x: (p.x - box.left) / w, y: (box.top - p.y) / h }
}

const textOf = (a: PDFDict, key: string): string => {
  const v = a.lookup(PDFName.of(key))
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : ''
}

/**
 * The box PDFium normalizes against: the crop box clipped to the media box
 * (FPDF_GetPageBoundingBox). pdf-lib's crop box falls back to the media box.
 */
function viewerBox(page: ReturnType<PDFDocument['getPage']>): UserBox {
  const crop = page.getCropBox()
  const media = page.getMediaBox()
  const left = Math.max(crop.x, media.x)
  const bottom = Math.max(crop.y, media.y)
  const right = Math.min(crop.x + crop.width, media.x + media.width)
  const top = Math.min(crop.y + crop.height, media.y + media.height)
  return right > left && top > bottom
    ? { left, bottom, right, top }
    : { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height }
}

/**
 * The normalized cutout rings of the given annotations on one page, keyed by
 * annotation index. Annotations without cutouts are absent from the map.
 *
 * An annotation is found by its /NM when it has one, since that is what
 * identifies a Bluebeam markup, and by its index in /Annots otherwise. Never
 * throws for a file pdf-lib can parse; an unparseable file throws, and the
 * caller converts without cutouts and says so.
 */
export async function readAnnotCutouts(
  bytes: Uint8Array,
  pageIndex: number,
  targets: readonly CutoutTarget[],
): Promise<Map<number, NormPoint[][]>> {
  const out = new Map<number, NormPoint[][]>()
  if (targets.length === 0) return out
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false })
  if (pageIndex < 0 || pageIndex >= doc.getPageCount()) return out
  const page = doc.getPage(pageIndex)
  const box = viewerBox(page)
  const arr = page.node.lookup(PDFName.of('Annots'))
  if (!(arr instanceof PDFArray)) return out

  const byName = new Map<string, PDFDict>()
  const byIndex: Array<PDFDict | null> = []
  for (let i = 0; i < arr.size(); i++) {
    const a = arr.lookup(i)
    const dict = a instanceof PDFDict ? a : null
    byIndex.push(dict)
    if (dict !== null) {
      const nm = textOf(dict, 'NM')
      if (nm !== '' && !byName.has(nm)) byName.set(nm, dict)
    }
  }

  for (const t of targets) {
    const named = t.name !== '' ? byName.get(t.name) : undefined
    const dict = named ?? byIndex[t.index] ?? null
    if (dict === null) continue
    const rings = cutoutRingsOf(dict).map((ring) => ring.map((p) => normalizeToBox(p, box)))
    if (rings.length > 0) out.set(t.index, rings)
  }
  return out
}
