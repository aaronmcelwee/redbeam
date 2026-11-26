/**
 * Notes as the annotations Bluebeam itself writes.
 *
 * Kenneth, 2026-11-26: the text boxes, clouds, leaders and shapes he draws
 * here have to be there when the PDF is opened in Revu, and editable there.
 * So each is written as the standard annotation for what it is, with its own
 * appearance stream (no reader is left to synthesise one) and the properties
 * Revu reads back when someone edits it:
 *
 *   text box      FreeText, /DA /DS /RC with the text, fill as /IC
 *   cloud         Polygon, /IT /PolygonCloud, /BE << /S /C /I 1 >>
 *   cloud+leader  the cloud, and a Line from the tip grouped to it (/IRT, /RT /Group)
 *   arrow, line   Line, /L and /LE (ClosedArrow, OpenArrow, Circle, None)
 *   rectangle     Square;  ellipse  Circle;  polygon  Polygon
 *   pen           Ink, /InkList
 *
 * Geometry arrives normalized in the page's DISPLAY frame and is placed
 * through the page's rotation (toUserSpace), so a note on a turned sheet sits
 * where it was drawn. A text box's appearance is drawn upright in that frame
 * and turned by its /Matrix, so its text reads the way it did on screen.
 */
import { PDFDict, PDFName, PDFString, StandardFontEmbedder, StandardFonts, type PDFContext, type PDFPage } from 'pdf-lib'
import {
  TEXT_LEADING, TEXT_PAD_PT, arrowBarbs, cloudOutline, cloudRadiusPt, dotRadius, wrapLines,
  type LineEnd, type NoteContent,
} from '../tools/noteGeometry.js'
import { pdfText, toPdfColor, toUserSpace, type PageBox } from './pdfMarkup.js'

type P = { x: number; y: number }

/** What Bluebeam's Markups List shows as the Subject of each. */
export const NOTE_SUBJECT: Record<NoteContent['shape'], string> = {
  text: 'Text Box', cloud: 'Cloud', callout: 'Cloud', arrow: 'Arrow', line: 'Line',
  rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', pen: 'Pen',
}

/** PDF's line-ending names. */
const LE: Record<LineEnd, string> = { none: 'None', arrow: 'ClosedArrow', open: 'OpenArrow', dot: 'Circle' }

const f = (n: number): string => (Math.round(n * 1000) / 1000).toString()
const rgb = (hex: string) => toPdfColor(hex).map(f).join(' ')

let helvetica: StandardFontEmbedder | null = null
function font(): StandardFontEmbedder {
  helvetica ??= StandardFontEmbedder.for(StandardFonts.Helvetica as unknown as Parameters<typeof StandardFontEmbedder.for>[0])
  return helvetica
}

/** Text as WinAnsi can carry it: a character Helvetica has no glyph for becomes "?". */
export function winAnsi(text: string): string {
  const fe = font()
  let out = ''
  for (const ch of text) {
    try { fe.encodeText(ch); out += ch } catch { out += '?' }
  }
  return out
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A ring's points in user space, with its bounds. */
function placed(ring: ReadonlyArray<P>, box: PageBox, rotation: number): P[] {
  return ring.map((p) => toUserSpace(p, box, rotation))
}

function boundsOf(pts: ReadonlyArray<P>, pad: number): number[] {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]
}

function pathOps(pts: ReadonlyArray<P>, close: boolean): string[] {
  const out = pts.map((p, i) => `${f(p.x)} ${f(p.y)} ${i === 0 ? 'm' : 'l'}`)
  if (close) out.push('h')
  return out
}

/** An ellipse inscribed in a box, as four Bézier quarters. */
function ellipseOps(x0: number, y0: number, x1: number, y1: number): string[] {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2
  const k = 0.5523
  return [
    `${f(cx + rx)} ${f(cy)} m`,
    `${f(cx + rx)} ${f(cy + k * ry)} ${f(cx + k * rx)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c`,
    `${f(cx - k * rx)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + k * ry)} ${f(cx - rx)} ${f(cy)} c`,
    `${f(cx - rx)} ${f(cy - k * ry)} ${f(cx - k * rx)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c`,
    `${f(cx + k * rx)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - k * ry)} ${f(cx + rx)} ${f(cy)} c`,
    'h',
  ]
}

function endOps(tip: P, from: P, end: LineEnd, width: number): string[] {
  if (end === 'none') return []
  if (end === 'dot') {
    const r = dotRadius(width)
    return [...ellipseOps(tip.x - r, tip.y - r, tip.x + r, tip.y + r), 'f']
  }
  const [b1, b2] = arrowBarbs(tip, from, width)
  return end === 'arrow'
    ? [...pathOps([tip, b1, b2], true), 'f']
    : [...pathOps([b1, tip, b2], false), 'S']
}

/** The ring a stroke's ends reach past its points, for the annotation's /Rect. */
function endPad(c: NoteContent): number {
  return Math.max(8, c.width * 4) + c.width
}

interface Built {
  /** Suffix for the annotation's /NM: '' for the note itself, ':leader' for a callout's leader. */
  part: string
  dict: PDFDict
}

/**
 * The annotations for one note: one, or two for a cloud with a leader (the
 * caller groups the second to the first). Null when its geometry is unusable.
 */
export function buildNoteAnnots(
  ctx: PDFContext, page: PDFPage, rings: ReadonlyArray<ReadonlyArray<P>>, c: NoteContent,
  nm: (part: string) => string, when: string,
): Built[] | null {
  const box = page.getCropBox() as PageBox
  const rotation = (((Math.round(page.getRotation().angle / 90) * 90) % 360) + 360) % 360
  const ring = rings[0]
  if (ring === undefined || ring.length === 0) return null
  const pts = placed(ring, box, rotation)
  const color = toPdfColor(c.color)
  const fill = c.fill !== null && c.fillOpacity > 0 ? c.fill : null
  const w = c.width

  const appearance = (rect: number[], ops: string[], extra: Record<string, unknown> = {}) => ctx.register(ctx.flateStream(
    ['q', '/GS gs', `${rgb(c.color)} RG`, `${rgb(c.color)} rg`, `${f(w)} w`, '1 J', '1 j', ...ops, 'Q'].join('\n'),
    {
      Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: rect,
      Resources: ctx.obj({ ExtGState: ctx.obj({ GS: ctx.obj({ Type: 'ExtGState', CA: 1, ca: 1 }), FILL: ctx.obj({ Type: 'ExtGState', ca: c.fillOpacity }) }), ...extra }),
    },
  ))
  /** Fill the current path at the fill's own opacity, then stroke it. */
  const fillThenStroke = (path: string[]): string[] => [
    ...(fill === null ? [] : ['q', '/FILL gs', `${rgb(fill)} rg`, ...path, 'f', 'Q']),
    ...(w > 0 ? [...path, 'S'] : []),
  ]

  const common = (subtype: string, rect: number[], part = '') => ({
    Type: 'Annot',
    Subtype: subtype,
    Rect: rect,
    C: color,
    CA: 1,
    F: 4,
    BS: ctx.obj({ Type: 'Border', W: w, S: PDFName.of('S') }),
    Subj: pdfText(part === ':leader' ? 'Leader' : NOTE_SUBJECT[c.shape]),
    T: PDFString.of('REDBEAM'),
    NM: pdfText(nm(part)),
    M: PDFString.of(when),
    CreationDate: PDFString.of(when),
  })
  const withFill = fill === null ? {} : { IC: toPdfColor(fill), FillOpacity: c.fillOpacity }

  switch (c.shape) {
    case 'text': {
      const rect = boundsOf(pts, 0)
      const turned = rotation === 90 || rotation === 270
      const dw = turned ? rect[3]! - rect[1]! : rect[2]! - rect[0]!
      const dh = turned ? rect[2]! - rect[0]! : rect[3]! - rect[1]!
      const fe = font()
      const lines = wrapLines(c.text, Math.max(1, dw - 2 * TEXT_PAD_PT), (s) => fe.widthOfTextAtSize(winAnsi(s), c.fontPt)).map(winAnsi)
      const matrix = rotation === 90 ? [0, 1, -1, 0, 0, 0] : rotation === 180 ? [-1, 0, 0, -1, 0, 0] : rotation === 270 ? [0, -1, 1, 0, 0, 0] : [1, 0, 0, 1, 0, 0]
      const frame = [0, 0, dw, dh]
      const inset = w / 2
      const border = [`${f(inset)} ${f(inset)} ${f(Math.max(0, dw - w))} ${f(Math.max(0, dh - w))} re`]
      const textOps = lines.flatMap((l, i) => {
        const y = dh - TEXT_PAD_PT - c.fontPt * (0.87 + i * TEXT_LEADING)
        return l === '' ? [] : [`1 0 0 1 ${f(TEXT_PAD_PT)} ${f(y)} Tm`, `${fe.encodeText(l).toString()} Tj`]
      })
      const ops = [
        ...(fill === null ? [] : ['q', '/FILL gs', `${rgb(fill)} rg`, `0 0 ${f(dw)} ${f(dh)} re`, 'f', 'Q']),
        ...(w > 0 ? [...border, 'S'] : []),
        // Clipped to the box, the way the sheet shows it.
        'q', `0 0 ${f(dw)} ${f(dh)} re`, 'W', 'n',
        'BT', `/Helv ${f(c.fontPt)} Tf`, `${rgb(c.color)} rg`, ...textOps, 'ET', 'Q',
      ]
      const helv = ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' })
      const ap = ctx.register(ctx.flateStream(
        ['q', '/GS gs', `${rgb(c.color)} RG`, `${f(w)} w`, ...ops, 'Q'].join('\n'),
        {
          Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: frame, Matrix: matrix,
          Resources: ctx.obj({
            ExtGState: ctx.obj({ GS: ctx.obj({ Type: 'ExtGState', CA: 1, ca: 1 }), FILL: ctx.obj({ Type: 'ExtGState', ca: c.fillOpacity }) }),
            Font: ctx.obj({ Helv: helv }),
          }),
        },
      ))
      const css = `font: Helvetica ${f(c.fontPt)}pt; text-align:left; color:${c.color.toUpperCase()}`
      const rc = '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" '
        + `xfa:APIVersion="Acrobat:11.0.0" xfa:spec="2.0.2" style="font-size:${f(c.fontPt)}pt;text-align:left;color:${c.color.toUpperCase()};font-family:Helvetica">`
        + c.text.split(/\r?\n/).map((l) => `<p>${xmlEscape(l) || '&#160;'}</p>`).join('') + '</body>'
      return [{
        part: '',
        dict: ctx.obj({
          ...common('FreeText', rect),
          ...withFill,
          Contents: pdfText(c.text),
          DA: PDFString.of(`${rgb(c.color)} rg /Helv ${f(c.fontPt)} Tf`),
          DS: PDFString.of(css),
          RC: pdfText(rc),
          Q: 0,
          ...(rotation === 0 ? {} : { Rotate: rotation }),
          AP: ctx.obj({ N: ap }),
        }) as PDFDict,
      }]
    }
    case 'rect': case 'ellipse': {
      const rect = boundsOf(pts, w)
      const [x0, y0, x1, y1] = boundsOf(pts, 0) as [number, number, number, number]
      const path = c.shape === 'rect' ? [`${f(x0)} ${f(y0)} ${f(x1 - x0)} ${f(y1 - y0)} re`] : ellipseOps(x0, y0, x1, y1)
      const ap = appearance(rect, fillThenStroke(path))
      return [{
        part: '',
        dict: ctx.obj({
          ...common(c.shape === 'rect' ? 'Square' : 'Circle', rect),
          ...withFill,
          RD: [w / 2, w / 2, w / 2, w / 2],
          AP: ctx.obj({ N: ap }),
        }) as PDFDict,
      }]
    }
    case 'polygon': case 'cloud': case 'callout': {
      if (pts.length < 3) return null
      const cloud = c.shape !== 'polygon'
      const r = cloudRadiusPt(w)
      const outline = cloud ? cloudOutline(pts, r) : pts
      const rect = boundsOf(outline, w + 1)
      const ap = appearance(rect, fillThenStroke(pathOps(outline, true)))
      const out: Built[] = [{
        part: '',
        dict: ctx.obj({
          ...common('Polygon', rect),
          ...withFill,
          Vertices: pts.flatMap((p) => [p.x, p.y]),
          ...(cloud ? { IT: PDFName.of('PolygonCloud'), BE: ctx.obj({ S: PDFName.of('C'), I: 1 }) } : {}),
          AP: ctx.obj({ N: ap }),
        }) as PDFDict,
      }]
      const leader = rings[1]
      if (c.shape === 'callout' && leader !== undefined && leader.length >= 2) {
        const [tip, foot] = placed(leader, box, rotation) as [P, P]
        const lrect = boundsOf([tip, foot], endPad(c))
        const lap = appearance(lrect, [...pathOps([foot, tip], false), 'S', ...endOps(tip, foot, c.ends[0], w)])
        out.push({
          part: ':leader',
          dict: ctx.obj({
            ...common('Line', lrect, ':leader'),
            L: [tip.x, tip.y, foot.x, foot.y],
            LE: [PDFName.of(LE[c.ends[0]]), PDFName.of('None')],
            AP: ctx.obj({ N: lap }),
          }) as PDFDict,
        })
      }
      return out
    }
    case 'arrow': case 'line': {
      if (pts.length < 2) return null
      const [a, b] = pts as [P, P]
      const rect = boundsOf([a, b], endPad(c))
      const ap = appearance(rect, [
        ...pathOps([a, b], false), 'S',
        ...endOps(a, b, c.ends[0], w), ...endOps(b, a, c.ends[1], w),
      ])
      return [{
        part: '',
        dict: ctx.obj({
          ...common('Line', rect),
          L: [a.x, a.y, b.x, b.y],
          LE: [PDFName.of(LE[c.ends[0]]), PDFName.of(LE[c.ends[1]])],
          AP: ctx.obj({ N: ap }),
        }) as PDFDict,
      }]
    }
    case 'pen': {
      if (pts.length < 2) return null
      const rect = boundsOf(pts, w)
      const ap = appearance(rect, [...pathOps(pts, false), 'S'])
      return [{
        part: '',
        dict: ctx.obj({
          ...common('Ink', rect),
          InkList: [pts.flatMap((p) => [p.x, p.y])],
          AP: ctx.obj({ N: ap }),
        }) as PDFDict,
      }]
    }
  }
}
