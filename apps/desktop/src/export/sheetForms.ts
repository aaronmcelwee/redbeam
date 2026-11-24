/**
 * A drawing's sheets, carried into another PDF as vectors.
 *
 * The export used to show each sheet as a picture: rendered to pixels,
 * cropped, saved as a PNG. Zoom into one and the linework turns to mush,
 * the text cannot be searched, and the file is heavy for what it shows.
 * Here each sheet that has takeoff on it is copied into the export ONCE as a
 * Form XObject — the sheet's own content stream and resources, the same
 * vectors and fonts the drawing has — and every snapshot of that sheet draws
 * the form through a clip. Nothing is rasterised, and a sheet with six areas
 * on it costs its content once, not six times.
 *
 * Only the page's CONTENT is taken. Annotations live beside it (/Annots), so
 * REDBEAM's own markups and anyone else's stay behind; the snapshot draws the
 * takeoff itself, in its own colours.
 *
 * A clip hides what lies outside a snapshot, but a viewer still reads every
 * operator of the sheet to draw it: six snapshots of a heavy sheet on one
 * page is six full sheets of work. So the content is read once here and
 * indexed by path, and each snapshot gets a form of its own holding only the
 * paths that reach its window (windowForm), with everything else the sheet
 * does — text, images, colour, layers, the graphics state — left as it was.
 */
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFObjectCopier, PDFRawStream, PDFRef, PDFStream,
  decodePDFRawStream, type PDFDocument, type PDFObject, type PDFPage,
} from 'pdf-lib'
import { cullContent, indexContent, type ContentIndex } from './contentIndex.js'
import type { NormBox, NormPoint } from './snapshotPlan.js'

export interface SheetForm {
  /** The whole sheet as one form, made on first use: a snapshot that shows most of it draws this. */
  whole: () => Promise<PDFRef>
  /** The page box (CropBox inside MediaBox) in the page's own user space. */
  box: { left: number; bottom: number; right: number; top: number }
  /** Clockwise quarter turns, as /Rotate shows the page. */
  turns: 0 | 1 | 2 | 3
  /** The page as displayed, points: width and height after the turn. */
  width: number
  height: number
  /** The decoded content, and where each path in it lies. */
  content: Uint8Array
  index: ContentIndex
  /** The dictionary every form of this sheet starts from: its resources and group, no BBox yet. */
  base: PDFDict
}

const name = (n: string) => PDFName.of(n)

/** The page box PDFium measures normalized coordinates against: the CropBox, inside the MediaBox. */
export function visibleBox(page: PDFPage): SheetForm['box'] {
  const media = page.getMediaBox()
  const crop = page.getCropBox()
  const left = Math.max(media.x, crop.x)
  const bottom = Math.max(media.y, crop.y)
  const right = Math.min(media.x + media.width, crop.x + crop.width)
  const top = Math.min(media.y + media.height, crop.y + crop.height)
  if (right - left > 0 && top - bottom > 0) return { left, bottom, right, top }
  return { left: media.x, bottom: media.y, right: media.x + media.width, top: media.y + media.height }
}

/** The page as displayed, points: its visible box, turned. What normalized coordinates are taken against. */
export function displayedSize(page: PDFPage): { width: number; height: number } {
  const b = visibleBox(page)
  const w = b.right - b.left
  const h = b.top - b.bottom
  return turnsOf(page) % 2 === 1 ? { width: h, height: w } : { width: w, height: h }
}

/** /Rotate as 0..3 clockwise quarter turns. */
export function turnsOf(page: PDFPage): 0 | 1 | 2 | 3 {
  const deg = page.getRotation().angle
  return ((((Math.round(deg / 90)) % 4) + 4) % 4) as 0 | 1 | 2 | 3
}

/** A normalized point turned clockwise by quarter turns (as viewer/rotation.ts). */
function turn(p: NormPoint, turns: number): NormPoint {
  switch (((turns % 4) + 4) % 4) {
    case 1: return { x: 1 - p.y, y: p.x }
    case 2: return { x: 1 - p.x, y: 1 - p.y }
    case 3: return { x: p.y, y: 1 - p.x }
    default: return p
  }
}

/** Page user space to the page as displayed, normalized [0,1], y down. */
export function userToNormalized(form: Pick<SheetForm, 'box' | 'turns'>, x: number, y: number): NormPoint {
  const { left, bottom, right, top } = form.box
  return turn({ x: (x - left) / (right - left), y: (top - y) / (top - bottom) }, form.turns)
}

/** The page as displayed, normalized, back to page user space. */
export function normalizedToUser(form: Pick<SheetForm, 'box' | 'turns'>, p: NormPoint): { x: number; y: number } {
  const n = turn(p, 4 - form.turns)
  const { left, bottom, right, top } = form.box
  return { x: left + n.x * (right - left), y: top - n.y * (top - bottom) }
}

/**
 * The matrix that draws the sheet's user space so that `window` (normalized,
 * as displayed) fills `rect` on the export page (points, y up).
 */
export function windowMatrix(
  form: Pick<SheetForm, 'box' | 'turns'>,
  window: NormBox,
  rect: { x: number; y: number; width: number; height: number },
): [number, number, number, number, number, number] {
  const ww = window.x1 - window.x0
  const wh = window.y1 - window.y0
  const at = (ux: number, uy: number) => {
    const n = userToNormalized(form, ux, uy)
    return {
      x: rect.x + ((n.x - window.x0) / ww) * rect.width,
      y: rect.y + rect.height - ((n.y - window.y0) / wh) * rect.height,
    }
  }
  // The map is affine, so three points pin it down.
  const o = at(0, 0)
  const ex = at(1, 0)
  const ey = at(0, 1)
  return [ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y, o.x, o.y]
}

/** Every content stream of a page, as one decoded run of operators. */
function decodedContents(page: PDFPage): Uint8Array {
  const contents = page.node.lookup(name('Contents'))
  const streams: PDFObject[] = contents instanceof PDFArray
    ? contents.asArray().map((o) => (o instanceof PDFRef ? page.doc.context.lookup(o) : o)).filter((o): o is PDFObject => o !== undefined)
    : contents === undefined ? [] : [contents]
  const parts: Uint8Array[] = []
  for (const s of streams) {
    if (s instanceof PDFRawStream) parts.push(decodePDFRawStream(s).decode())
    else if (s instanceof PDFStream) parts.push(s.getContents())
  }
  // Streams in an array are one content stream cut at token boundaries;
  // joined, a newline keeps the last token of one off the first of the next.
  const size = parts.reduce((n, p) => n + p.length + 1, 0)
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length; out[at++] = 0x0a }
  return out
}

/** zlib-wrapped deflate, which is what /FlateDecode reads. Native when the runtime has it. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== 'function') return null
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** A form XObject in `target` from a content run and the sheet's base dictionary. */
async function formOf(target: PDFDocument, base: PDFDict, bbox: readonly number[], raw: Uint8Array): Promise<PDFRef> {
  const dict = base.clone(target.context)
  dict.set(name('BBox'), target.context.obj([...bbox]))
  const packed = await deflate(raw)
  let stream: PDFStream
  if (packed !== null) {
    dict.set(name('Filter'), name('FlateDecode'))
    dict.set(name('Length'), PDFNumber.of(packed.length))
    stream = PDFRawStream.of(dict, packed)
  } else {
    stream = target.context.flateStream(raw, {})
    for (const [k, v] of dict.entries()) stream.dict.set(k, v)
  }
  return target.context.register(stream)
}

/**
 * Copy the sheets `pageIndexes` of `source` into `target`, ready to be drawn.
 *
 * One copier per source document, so a font or a hatch pattern shared by
 * five sheets is copied once. Layers (optional content) come along with the
 * catalog entry that says which are switched off, so a layer hidden in the
 * drawing stays hidden in the export.
 */
export async function embedSheets(
  target: PDFDocument,
  source: PDFDocument,
  pageIndexes: readonly number[],
): Promise<Map<number, SheetForm>> {
  const copier = PDFObjectCopier.for(source.context, target.context)
  const out = new Map<number, SheetForm>()
  for (const index of [...new Set(pageIndexes)].sort((a, b) => a - b)) {
    if (index < 0 || index >= source.getPageCount()) continue
    const page = source.getPage(index)
    const box = visibleBox(page)
    const turns = turnsOf(page)
    const resources = page.node.Resources()
    // Every form of this sheet shares one copy of its resources.
    const base = target.context.obj({ Type: 'XObject', Subtype: 'Form', FormType: 1 }) as PDFDict
    base.set(name('Resources'), target.context.register(resources === undefined ? target.context.obj({}) : copier.copy(resources)))
    // A page that is itself a transparency group composites as one.
    const group = page.node.lookup(name('Group'))
    if (group instanceof PDFDict) base.set(name('Group'), target.context.register(copier.copy(group)))

    const content = decodedContents(page)
    const turned = turns % 2 === 1
    const w = box.right - box.left, h = box.top - box.bottom
    let whole: Promise<PDFRef> | null = null
    out.set(index, {
      whole: () => (whole ??= formOf(target, base, [box.left, box.bottom, box.right, box.top], content)),
      box, turns, width: turned ? h : w, height: turned ? w : h,
      content,
      index: indexContent(content),
      base,
    })
  }
  mergeLayers(target, source, copier)
  return out
}

/**
 * The form a snapshot draws: the sheet's content less every path that lies
 * wholly outside `window` (normalized, as displayed). When the window takes
 * in most of the sheet there is nothing worth leaving out, and the whole
 * sheet's form is shared instead.
 */
export async function windowForm(target: PDFDocument, form: SheetForm, window: NormBox): Promise<PDFRef> {
  const corners = [
    normalizedToUser(form, { x: window.x0, y: window.y0 }),
    normalizedToUser(form, { x: window.x1, y: window.y0 }),
    normalizedToUser(form, { x: window.x0, y: window.y1 }),
    normalizedToUser(form, { x: window.x1, y: window.y1 }),
  ]
  const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y)
  const pad = Math.max(6, 0.02 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)))
  const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad
  const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad
  const raw = cullContent(form.content, form.index, { x0, y0, x1, y1 })
  if (raw === null) return form.whole()
  const { left, bottom, right, top } = form.box
  return formOf(target, form.base, [
    Math.max(left, x0), Math.max(bottom, y0), Math.min(right, x1), Math.min(top, y1),
  ], raw)
}

/** Bring the source's optional-content groups and their default state across. */
function mergeLayers(target: PDFDocument, source: PDFDocument, copier: PDFObjectCopier): void {
  const props = source.catalog.lookup(name('OCProperties'))
  if (!(props instanceof PDFDict)) return
  const copied = copier.copy(props) as PDFDict
  const mine = target.catalog.lookup(name('OCProperties'))
  if (!(mine instanceof PDFDict)) {
    target.catalog.set(name('OCProperties'), target.context.register(copied))
    return
  }
  const join = (into: PDFDict, from: PDFDict, key: string) => {
    const a = into.lookup(name(key))
    const b = from.lookup(name(key))
    if (!(b instanceof PDFArray)) return
    if (a instanceof PDFArray) for (const o of b.asArray()) a.push(o)
    else into.set(name(key), b)
  }
  join(mine, copied, 'OCGs')
  const md = mine.lookup(name('D'))
  const cd = copied.lookup(name('D'))
  if (md instanceof PDFDict && cd instanceof PDFDict) {
    join(md, cd, 'OFF')
    join(md, cd, 'Order')
  }
}
