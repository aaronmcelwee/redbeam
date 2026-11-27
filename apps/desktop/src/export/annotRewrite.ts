/**
 * Another app's annotation, rewritten in place: moved, recoloured, or put
 * back after a delete was undone.
 *
 * Kenneth, 2026-11-26: Bluebeam's dimensions, clouds, text and arrows could
 * not be deleted or moved in REDBEAM. They are adopted as `annot` markups
 * (adopt.ts) that hold only where the annotation sits and its colour; this
 * is what the save does with one that changed. The annotation keeps its /NM,
 * its subject, its appearance and everything private Bluebeam keeps on it,
 * so Revu opens the same markup it saved, only moved or recoloured.
 *
 * - MOVED: every geometry key is shifted by the same amount (/Rect,
 *   /Vertices, /L, /QuadPoints, /InkList, /CL, /Cutouts) and so is its note
 *   popup. The appearance is drawn into /Rect, so it moves with it.
 * - RECOLOURED: /C, /IC, a text box's /DA, /DS and /RC, and every operator in
 *   the appearance, wherever they set the annotation's old colour.
 *
 * Every rewrite is ABSOLUTE: it says where the annotation should be and what
 * colour, and this works out the change from the file as it stands, so the
 * same rewrite applied twice moves nothing the second time.
 */
import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString,
  decodePDFRawStream,
  type PDFContext,
} from 'pdf-lib'
import {
  daColor, hexToRgb, recolorContent, recolorCss, recolorDa, sameColor, type Rgb,
} from '@redbeam/viewer/annotEdit'
import { pdfText, toUserSpace, type PageBox } from './pdfMarkup.js'

/** One `annot` markup as the save should leave its annotation. */
export interface AnnotRewrite {
  pageIndex: number
  nm: string
  /** Where it should sit: normalized to the page as displayed, y down. */
  rect: { x0: number, y0: number, x1: number, y1: number }
  /** Its colour, #rrggbb; null keeps the file's. */
  color: string | null
  /**
   * The objects a save took off the sheet when it was deleted (the
   * annotation, then its popup), to put back: the delete was undone after it
   * had been saved. An incremental save never frees them.
   */
  restore?: readonly string[]
}

const num = (v: unknown): number => (v instanceof PDFNumber ? v.asNumber() : NaN)

function nums(d: PDFDict, key: string): number[] {
  const v = d.lookup(PDFName.of(key))
  if (!(v instanceof PDFArray)) return []
  const out: number[] = []
  for (let i = 0; i < v.size(); i++) out.push(num(v.lookup(i)))
  return out
}

function text(d: PDFDict, key: string): string {
  const v = d.lookup(PDFName.of(key))
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : ''
}

function rgbOf(n: number[]): Rgb | null {
  if (n.length === 3 && n.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return [n[0]!, n[1]!, n[2]!]
  if (n.length === 1 && Number.isFinite(n[0]) && n[0]! >= 0 && n[0]! <= 1) return [n[0]!, n[0]!, n[0]!]
  return null
}

function subtype(a: PDFDict): string {
  const s = a.lookup(PDFName.of('Subtype'))
  return s instanceof PDFName ? s.decodeText() : ''
}

/** The annotation's colour as REDBEAM shows it: a text box's text colour, otherwise /C. */
export function annotColor(a: PDFDict): Rgb | null {
  if (subtype(a) === 'FreeText') {
    const da = daColor(text(a, 'DA'))
    if (da !== null) return da
  }
  return rgbOf(nums(a, 'C'))
}

/** /Rect as [x0 y0 x1 y1], lower then upper; null when unreadable. */
export function rectOf(a: PDFDict): [number, number, number, number] | null {
  const r = nums(a, 'Rect')
  if (r.length !== 4 || !r.every(Number.isFinite)) return null
  return [Math.min(r[0]!, r[2]!), Math.min(r[1]!, r[3]!), Math.max(r[0]!, r[2]!), Math.max(r[1]!, r[3]!)]
}

function normalStream(a: PDFDict): PDFStream | null {
  const ap = a.lookup(PDFName.of('AP'))
  if (!(ap instanceof PDFDict)) return null
  const n = ap.lookup(PDFName.of('N'))
  if (n instanceof PDFStream) return n
  if (n instanceof PDFDict) {
    const as = a.lookup(PDFName.of('AS'))
    const pick = as instanceof PDFName ? n.lookup(as) : null
    if (pick instanceof PDFStream) return pick
  }
  return null
}

/**
 * What the viewer needs to redraw a recoloured copy on screen: the
 * appearance's box and matrix, and how see-through its fill is (Bluebeam's
 * clouds and boxes fill at about a third).
 */
export function appearanceInfo(a: PDFDict): { bbox: number[], matrix: number[] | null, alpha: number } | null {
  const s = normalStream(a)
  if (s === null) return null
  const bbox = nums(s.dict, 'BBox')
  if (bbox.length !== 4 || !bbox.every(Number.isFinite)) return null
  const m = nums(s.dict, 'Matrix')
  let alpha = 1
  const res = s.dict.lookup(PDFName.of('Resources'))
  const gss = res instanceof PDFDict ? res.lookup(PDFName.of('ExtGState')) : null
  if (gss instanceof PDFDict) {
    for (const [, v] of gss.entries()) {
      const g = v instanceof PDFRef ? gss.context.lookup(v) : v
      if (!(g instanceof PDFDict)) continue
      const ca = num(g.lookup(PDFName.of('ca')))
      if (Number.isFinite(ca) && ca >= 0 && ca < alpha) alpha = ca
    }
  }
  if (alpha === 1) {
    const fo = num(a.lookup(PDFName.of('FillOpacity')))
    if (Number.isFinite(fo) && fo >= 0 && fo < 1) alpha = fo
  }
  return { bbox, matrix: m.length === 6 && m.every(Number.isFinite) ? m : null, alpha }
}

/** Where `rewrite` puts the annotation, in the page's user space. */
export function targetRect(rewrite: Pick<AnnotRewrite, 'rect'>, box: PageBox, rotation: number): [number, number, number, number] {
  const a = toUserSpace({ x: rewrite.rect.x0, y: rewrite.rect.y0 }, box, rotation)
  const b = toUserSpace({ x: rewrite.rect.x1, y: rewrite.rect.y1 }, box, rotation)
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)]
}

/** A move smaller than this (in points) is a rounding difference, not a move. */
const MOVE_EPS = 0.05

/** What `rewrite` would change on `a`; nothing when the file already shows it. */
export function rewriteNeeds(a: PDFDict, rewrite: AnnotRewrite, box: PageBox, rotation: number): { dx: number, dy: number, from: Rgb | null, to: Rgb | null } {
  const r = rectOf(a)
  const t = targetRect(rewrite, box, rotation)
  let dx = r === null ? 0 : t[0] - r[0]
  let dy = r === null ? 0 : t[1] - r[1]
  if (Math.abs(dx) < MOVE_EPS && Math.abs(dy) < MOVE_EPS) { dx = 0; dy = 0 }
  const to = hexToRgb(rewrite.color)
  const from = annotColor(a)
  const recolour = to !== null && from !== null && !sameColor(from, to)
  return { dx, dy, from: recolour ? from : null, to: recolour ? to : null }
}

function shiftFlat(ctx: PDFContext, d: PDFDict, key: string, dx: number, dy: number): void {
  const v = d.lookup(PDFName.of(key))
  if (!(v instanceof PDFArray)) return
  const out: number[] = []
  for (let i = 0; i < v.size(); i++) {
    const n = num(v.lookup(i))
    if (!Number.isFinite(n)) return
    out.push(i % 2 === 0 ? n + dx : n + dy)
  }
  d.set(PDFName.of(key), ctx.obj(out))
}

function shiftNested(ctx: PDFContext, d: PDFDict, key: string, dx: number, dy: number): void {
  const v = d.lookup(PDFName.of(key))
  if (!(v instanceof PDFArray)) return
  const rings: number[][] = []
  for (let i = 0; i < v.size(); i++) {
    const inner = v.lookup(i)
    if (!(inner instanceof PDFArray)) return
    const ring: number[] = []
    for (let k = 0; k < inner.size(); k++) {
      const n = num(inner.lookup(k))
      if (!Number.isFinite(n)) return
      ring.push(k % 2 === 0 ? n + dx : n + dy)
    }
    rings.push(ring)
  }
  d.set(PDFName.of(key), ctx.obj(rings))
}

/**
 * Shift the annotation by (dx, dy) points. Returns the popup's reference
 * when it moved too, so the save writes it.
 */
export function translateAnnot(ctx: PDFContext, a: PDFDict, dx: number, dy: number): PDFRef[] {
  if (dx === 0 && dy === 0) return []
  for (const key of ['Rect', 'Vertices', 'L', 'QuadPoints', 'CL']) shiftFlat(ctx, a, key, dx, dy)
  for (const key of ['InkList', 'Cutouts']) shiftNested(ctx, a, key, dx, dy)
  const popupRef = a.get(PDFName.of('Popup'))
  const popup = a.lookup(PDFName.of('Popup'))
  if (popup instanceof PDFDict) {
    shiftFlat(ctx, popup, 'Rect', dx, dy)
    if (popupRef instanceof PDFRef) return [popupRef]
  }
  return []
}

const latin1 = (bytes: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return s
}

const bytesOf = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255
  return out
}

/** Filters this can read and write back; anything else leaves the drawing as it is. */
function readable(s: PDFStream): boolean {
  const f = s.dict.lookup(PDFName.of('Filter'))
  if (f === undefined) return true
  if (f instanceof PDFName) return f.decodeText() === 'FlateDecode'
  if (f instanceof PDFArray) return f.size() === 1 && f.lookup(0) instanceof PDFName && (f.lookup(0) as PDFName).decodeText() === 'FlateDecode'
  return false
}

function recolorStream(ctx: PDFContext, s: PDFStream, from: Rgb[], to: Rgb): PDFRef | null {
  if (!readable(s)) return null
  let content: string
  try {
    const bytes = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents()
    content = latin1(bytes)
  } catch {
    return null
  }
  const out = recolorContent(content, from, to)
  if (out === null || out.changed === 0) return null
  const fresh = ctx.flateStream(bytesOf(out.text))
  for (const [k, v] of s.dict.entries()) {
    const name = k.decodeText()
    if (name === 'Length' || name === 'Filter' || name === 'DecodeParms') continue
    fresh.dict.set(k, v)
  }
  return ctx.register(fresh)
}

function setString(ctx: PDFContext, d: PDFDict, key: string, value: string): void {
  d.set(PDFName.of(key), pdfText(value))
  void ctx
}

/** Recolour the annotation from `from` to `to`. True when anything changed. */
export function recolorAnnot(ctx: PDFContext, a: PDFDict, from: Rgb, to: Rgb): boolean {
  let changed = false
  const froms: Rgb[] = [from]
  for (const key of ['C', 'IC']) {
    const c = rgbOf(nums(a, key))
    if (c !== null && sameColor(c, from)) {
      a.set(PDFName.of(key), ctx.obj([...to]))
      changed = true
    }
  }
  const da = text(a, 'DA')
  if (da !== '') {
    const dc = daColor(da)
    if (dc !== null && sameColor(dc, from)) {
      setString(ctx, a, 'DA', recolorDa(da, to))
      changed = true
    }
  }
  for (const key of ['DS', 'RC']) {
    const v = text(a, key)
    if (v === '') continue
    const next = recolorCss(v, froms, to)
    if (next !== v) { setString(ctx, a, key, next); changed = true }
  }
  const ap = a.lookup(PDFName.of('AP'))
  if (ap instanceof PDFDict) {
    const fresh = ctx.obj({}) as PDFDict
    let apChanged = false
    for (const [k, v] of ap.entries()) {
      const target = v instanceof PDFRef ? ctx.lookup(v) : v
      if (target instanceof PDFStream) {
        const ref = recolorStream(ctx, target, froms, to)
        fresh.set(k, ref ?? v)
        if (ref !== null) apChanged = true
      } else if (target instanceof PDFDict) {
        const states = ctx.obj({}) as PDFDict
        for (const [sk, sv] of target.entries()) {
          const st = sv instanceof PDFRef ? ctx.lookup(sv) : sv
          const ref = st instanceof PDFStream ? recolorStream(ctx, st, froms, to) : null
          states.set(sk, ref ?? sv)
          if (ref !== null) apChanged = true
        }
        fresh.set(k, states)
      } else {
        fresh.set(k, v)
      }
    }
    // A fresh, direct /AP on the annotation: the old one stays in the file
    // untouched, as any other app's object does.
    if (apChanged) { a.set(PDFName.of('AP'), fresh); changed = true }
  }
  return changed
}
