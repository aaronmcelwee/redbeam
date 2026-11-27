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
 *   leader        FreeText /IT /FreeTextCallout: the text box, with the
 *                 leader as /CL [head tail], its head as /LE and the box
 *                 inset from /Rect by /RD; Revu's Callout. Without text it
 *                 is a Line, an arrow and nothing more.
 *   cloud+leader  the cloud, and its callout grouped to it (/IRT, /RT /Group),
 *                 as Revu's Cloud+ is a cloud and a callout grouped
 *   cloud         Polygon, /IT /PolygonCloud, /BE << /S /C /I 1 >>
 *   line          Line, /L and /LE (ClosedArrow, OpenArrow, Circle, None)
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
  TEXT_LEADING, TEXT_PAD_PT, arrowBarbs, cloudOutline, cloudRadiusPt, dotRadius, leaderRingIndex,
  textRingIndex, wrapLines,
  type LineEnd, type NoteContent,
} from '../tools/noteGeometry.js'
import { pdfText, toPdfColor, toUserSpace, type PageBox } from './pdfMarkup.js'

type P = { x: number; y: number }

/** What Bluebeam's Markups List shows as the Subject of each. */
export const NOTE_SUBJECT: Record<NoteContent['shape'], string> = {
  text: 'Text Box', cloud: 'Cloud', callout: 'Cloud+', arrow: 'Callout', line: 'Line',
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
  /** Suffix for the annotation's /NM: '' for the note itself, ':callout' for a cloud+'s callout. */
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
    Subj: pdfText(part === '' ? NOTE_SUBJECT[c.shape] : 'Callout'),
    T: PDFString.of('REDBEAM'),
    NM: pdfText(nm(part)),
    M: PDFString.of(when),
    CreationDate: PDFString.of(when),
  })
  const withFill = fill === null ? {} : { IC: toPdfColor(fill), FillOpacity: c.fillOpacity }

  /*
   * A box of text, drawn upright in its own frame, 0..dw across and 0..dh
   * up: fill, border, and the lines wrapped to its width, clipped to it.
   * The same as the sheet draws it (notes.ts drawTextBox).
   */
  const textBlock = (dw: number, dh: number, fillHex: string | null): string[] => {
    const fe = font()
    const lines = wrapLines(c.text, Math.max(1, dw - 2 * TEXT_PAD_PT + 1), (s) => fe.widthOfTextAtSize(winAnsi(s), c.fontPt)).map(winAnsi)
    const inset = w / 2
    const textOps = lines.flatMap((l, i) => {
      const y = dh - TEXT_PAD_PT - c.fontPt * (0.87 + i * TEXT_LEADING)
      return l === '' ? [] : [`1 0 0 1 ${f(TEXT_PAD_PT)} ${f(y)} Tm`, `${fe.encodeText(l).toString()} Tj`]
    })
    return [
      ...(fillHex === null ? [] : ['q', '/FILL gs', `${rgb(fillHex)} rg`, `0 0 ${f(dw)} ${f(dh)} re`, 'f', 'Q']),
      ...(w > 0 ? [`${rgb(c.color)} RG`, `${f(w)} w`, `${f(inset)} ${f(inset)} ${f(Math.max(0, dw - w))} ${f(Math.max(0, dh - w))} re`, 'S'] : []),
      'q', `0 0 ${f(dw)} ${f(dh)} re`, 'W', 'n',
      'BT', `/Helv ${f(c.fontPt)} Tf`, `${rgb(c.color)} rg`, ...textOps, 'ET', 'Q',
    ]
  }
  const textResources = (fillOpacity: number) => ctx.obj({
    ExtGState: ctx.obj({ GS: ctx.obj({ Type: 'ExtGState', CA: 1, ca: 1 }), FILL: ctx.obj({ Type: 'ExtGState', ca: fillOpacity }) }),
    Font: ctx.obj({ Helv: ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }) }),
  })
  /** What Revu reads back to edit a FreeText's text: the text, its font and its rich text. */
  const freeTextEntries = () => {
    const css = `font: Helvetica ${f(c.fontPt)}pt; text-align:left; color:${c.color.toUpperCase()}`
    const rc = '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" '
      + `xfa:APIVersion="Acrobat:11.0.0" xfa:spec="2.0.2" style="font-size:${f(c.fontPt)}pt;text-align:left;color:${c.color.toUpperCase()};font-family:Helvetica">`
      + c.text.split(/\r?\n/).map((l) => `<p>${xmlEscape(l) || '&#160;'}</p>`).join('') + '</body>'
    return {
      Contents: pdfText(c.text),
      DA: PDFString.of(`${rgb(c.color)} rg /Helv ${f(c.fontPt)} Tf`),
      DS: PDFString.of(css),
      RC: pdfText(rc),
      Q: 0,
      ...(rotation === 0 ? {} : { Rotate: rotation }),
    }
  }
  /**
   * A leader with its text, as Revu's Callout: a FreeText whose /CL is the
   * leader from its head to the box, /LE the head, and /RD how far the box
   * sits inside /Rect. The appearance draws the leader in page space and the
   * box upright in the sheet's display frame, placed there by a `cm`.
   * Without text it is a plain Line with the arrowhead.
   */
  const leaderAnnot = (part: string): Built | null => {
    const leader = rings[leaderRingIndex(c.shape)]
    if (leader === undefined || leader.length < 2) return null
    const [head, tail] = placed(leader, box, rotation) as [P, P]
    const boxRing = rings[textRingIndex(c.shape)]
    if (c.text === '' || boxRing === undefined || boxRing.length < 4) {
      const rect = boundsOf([head, tail], endPad(c))
      const ap = appearance(rect, [...pathOps([tail, head], false), 'S', ...endOps(head, tail, c.ends[0], w)])
      return {
        part,
        dict: ctx.obj({
          ...common('Line', rect, part), Subj: pdfText(part === '' ? 'Arrow' : 'Leader'),
          L: [head.x, head.y, tail.x, tail.y],
          LE: [PDFName.of(LE[c.ends[0]]), PDFName.of('None')],
          AP: ctx.obj({ N: ap }),
        }) as PDFDict,
      }
    }
    // The box's corners TL TR BR BL as drawn, in page space.
    const [tl, tr, , bl] = placed(boxRing, box, rotation) as [P, P, P, P]
    const dw = Math.hypot(tr.x - tl.x, tr.y - tl.y), dh = Math.hypot(tl.x - bl.x, tl.y - bl.y)
    if (!(dw > 0 && dh > 0)) return null
    const u = { x: (tr.x - tl.x) / dw, y: (tr.y - tl.y) / dw }
    const v = { x: (tl.x - bl.x) / dh, y: (tl.y - bl.y) / dh }
    const boxPts = placed(boxRing, box, rotation)
    const rect = boundsOf([...boxPts, head, tail], endPad(c))
    const tb = boundsOf(boxPts, 0)
    const ap = ctx.register(ctx.flateStream(
      [
        'q', '/GS gs', `${rgb(c.color)} RG`, `${rgb(c.color)} rg`, `${f(w)} w`, '1 J', '1 j',
        ...pathOps([tail, head], false), 'S', ...endOps(head, tail, c.ends[0], w),
        'q', `${f(u.x)} ${f(u.y)} ${f(v.x)} ${f(v.y)} ${f(bl.x)} ${f(bl.y)} cm`, ...textBlock(dw, dh, '#ffffff'), 'Q',
        'Q',
      ].join('\n'),
      { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: rect, Resources: textResources(1) },
    ))
    return {
      part,
      dict: ctx.obj({
        ...common('FreeText', rect, part),
        Subj: pdfText('Callout'),
        IT: PDFName.of('FreeTextCallout'),
        CL: [head.x, head.y, tail.x, tail.y],
        LE: PDFName.of(LE[c.ends[0]]),
        RD: [tb[0]! - rect[0]!, tb[1]! - rect[1]!, rect[2]! - tb[2]!, rect[3]! - tb[3]!],
        IC: toPdfColor('#ffffff'),
        ...freeTextEntries(),
        AP: ctx.obj({ N: ap }),
      }) as PDFDict,
    }
  }

  switch (c.shape) {
    case 'text': {
      const rect = boundsOf(pts, 0)
      const turned = rotation === 90 || rotation === 270
      const dw = turned ? rect[3]! - rect[1]! : rect[2]! - rect[0]!
      const dh = turned ? rect[2]! - rect[0]! : rect[3]! - rect[1]!
      const matrix = rotation === 90 ? [0, 1, -1, 0, 0, 0] : rotation === 180 ? [-1, 0, 0, -1, 0, 0] : rotation === 270 ? [0, -1, 1, 0, 0, 0] : [1, 0, 0, 1, 0, 0]
      const ap = ctx.register(ctx.flateStream(
        ['q', '/GS gs', `${rgb(c.color)} RG`, `${f(w)} w`, ...textBlock(dw, dh, fill), 'Q'].join('\n'),
        { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, dw, dh], Matrix: matrix, Resources: textResources(c.fillOpacity) },
      ))
      return [{
        part: '',
        dict: ctx.obj({ ...common('FreeText', rect), ...withFill, ...freeTextEntries(), AP: ctx.obj({ N: ap }) }) as PDFDict,
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
      if (c.shape === 'callout') {
        const callout = leaderAnnot(':callout')
        if (callout !== null) out.push(callout)
      }
      return out
    }
    case 'arrow': {
      const built = leaderAnnot('')
      return built === null ? null : [built]
    }
    case 'line': {
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
