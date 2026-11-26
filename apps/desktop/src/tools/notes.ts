/**
 * The note tools on the canvas: how each one is drawn while it is being
 * placed, how a finished one is painted, and what is under the pointer.
 *
 * The stored shape and the shared geometry are in noteGeometry.ts, which the
 * PDF writer reads too. Geometry is NORMALIZED page coordinates; drawing and
 * hit-testing work in SCREEN pixels, as hit.ts does, with one PDF point
 * being `view.zoom` pixels.
 */
import { distanceToSegment, pointInPolygon } from '@redbeam/domain'
import type { Viewport } from '@redbeam/viewer'
import { normalizedToScreen } from '../draw.js'
import { EDGE_GRAB_PX, VERTEX_GRAB_PX, type Hit } from '../hit.js'
import {
  TEXT_LEADING, TEXT_PAD_PT, arrowBarbs, boxRing, cloudOutline, cloudRadiusPt, dotRadius,
  isBoxShape, isClosedShape, nearestOnRing, parseNoteContent, simplifyStroke, wrapLines,
  type LineEnd, type NoteContent, type NoteShape,
} from './noteGeometry.js'

export * from './noteGeometry.js'

type P = { x: number; y: number }
type Ctx = CanvasRenderingContext2D

/** The tools that place notes. Each is named for the shape it makes. */
export type NoteTool = NoteShape

export function isNoteTool(t: string): t is NoteTool {
  return t === 'text' || t === 'cloud' || t === 'callout' || t === 'arrow' || t === 'line'
    || t === 'rect' || t === 'ellipse' || t === 'polygon' || t === 'pen'
}

// -------------------------------------------------------------- draft ------

export interface NoteDraft {
  shape: NoteShape
  /** Clicks placed so far: a polygon's corners, a line's first end. */
  points: P[]
  /** The pointer, for the rubber band. */
  cursor: P | null
  /** Where the button went down, while it is held. */
  down: P | null
  /** A pen stroke in progress. */
  stroke: P[]
  /** A callout whose cloud is finished, waiting for where its leader points. */
  cloud: P[] | null
}

export const emptyNoteDraft = (shape: NoteShape): NoteDraft => ({
  shape, points: [], cursor: null, down: null, stroke: [], cloud: null,
})

/** Whether anything has been placed, so Escape has something to drop. */
export function noteDraftStarted(d: NoteDraft): boolean {
  return d.points.length > 0 || d.down !== null || d.stroke.length > 0 || d.cloud !== null
}

/** What a step of the draft produced: the draft to carry on with, and rings to commit. */
export interface NoteStep { draft: NoteDraft; rings: P[][] | null }

const keep = (draft: NoteDraft): NoteStep => ({ draft, rings: null })
const done = (d: NoteDraft, rings: P[][]): NoteStep => ({ draft: emptyNoteDraft(d.shape), rings })

/** Button down at `p`. */
export function noteDown(d: NoteDraft, p: P): NoteDraft {
  if (d.shape === 'pen') return { ...d, down: p, stroke: [p], cursor: p }
  return { ...d, down: p, cursor: p }
}

/** Pointer moved to `p`. `minStep` is the shortest pen segment, normalized. */
export function noteMove(d: NoteDraft, p: P, minStep = 0): NoteDraft {
  if (d.shape === 'pen' && d.down !== null) {
    const last = d.stroke[d.stroke.length - 1]
    if (last !== undefined && Math.hypot(p.x - last.x, p.y - last.y) < minStep) return { ...d, cursor: p }
    return { ...d, cursor: p, stroke: [...d.stroke, p] }
  }
  return { ...d, cursor: p }
}

/**
 * Options for a release, from the caller who knows the screen:
 *  - `dragged`: the pointer travelled far enough from where it went down to
 *    be a drag rather than a click;
 *  - `closes`: the release landed on the first corner, closing the outline;
 *  - `textBox`: the size of a text box placed with a click, normalized;
 *  - `simplify`: how far a pen sample may sit off its stroke and be dropped.
 */
export interface UpOptions {
  dragged: boolean
  closes?: boolean
  textBox?: { w: number; h: number }
  simplify?: number
}

/** Button up at `p`. */
export function noteUp(d: NoteDraft, p: P, o: UpOptions): NoteStep {
  const down = d.down
  const base = { ...d, down: null, cursor: p }
  if (down === null) return keep(base)
  switch (d.shape) {
    case 'pen': {
      const stroke = [...d.stroke, p]
      if (!o.dragged || stroke.length < 2) return keep({ ...base, stroke: [] })
      return done(d, [simplifyStroke(stroke, o.simplify ?? 0)])
    }
    case 'text': case 'rect': case 'ellipse': {
      if (o.dragged) return done(d, [boxRing(down, p)])
      if (d.shape === 'text' && o.textBox !== undefined) {
        return done(d, [boxRing(p, { x: p.x + o.textBox.w, y: p.y + o.textBox.h })])
      }
      return keep(base)
    }
    case 'arrow': case 'line': {
      if (o.dragged && d.points.length === 0) return done(d, [[down, p]])
      if (d.points.length === 0) return keep({ ...base, points: [p] })
      return done(d, [[d.points[0]!, p]])
    }
    case 'cloud': case 'polygon': case 'callout': {
      if (d.cloud !== null) {
        // The callout's leader: from where it points to the nearest edge.
        return done(d, [d.cloud, [p, nearestOnRing(d.cloud, p)]])
      }
      if (d.points.length === 0 && o.dragged) return outlineDone(base, boxRing(down, p))
      if (o.closes === true && d.points.length >= 3) return outlineDone(base, d.points)
      return keep({ ...base, points: [...d.points, p] })
    }
  }
}

function outlineDone(d: NoteDraft, ring: P[]): NoteStep {
  if (d.shape === 'callout') return keep({ ...emptyNoteDraft(d.shape), cloud: ring, cursor: d.cursor })
  return done(d, [ring])
}

/** Enter, or a double-click: finish an outline that has its corners. */
export function noteFinish(d: NoteDraft): NoteStep {
  if (d.shape !== 'cloud' && d.shape !== 'polygon' && d.shape !== 'callout') return keep(d)
  if (d.cloud !== null) return keep(d)
  // A double-click lands two clicks on one spot; the second is not a corner.
  const pts = d.points.filter((p, i) => i === 0 || p.x !== d.points[i - 1]!.x || p.y !== d.points[i - 1]!.y)
  if (pts.length < 3) return keep(d)
  return outlineDone({ ...d, points: [] }, pts)
}

/** Backspace: take back the last thing placed. */
export function noteBack(d: NoteDraft): NoteDraft {
  if (d.cloud !== null) return { ...d, cloud: null, points: d.cloud.slice(0, -1) }
  if (d.points.length > 0) return { ...d, points: d.points.slice(0, -1) }
  return d
}

/** What the draft would commit if it ended now, for the rubber band. */
export function draftPreview(d: NoteDraft): { rings: P[][]; open: boolean } | null {
  const c = d.cursor
  switch (d.shape) {
    case 'pen':
      return d.stroke.length >= 2 ? { rings: [d.stroke], open: false } : null
    case 'text': case 'rect': case 'ellipse':
      return d.down !== null && c !== null ? { rings: [boxRing(d.down, c)], open: false } : null
    case 'arrow': case 'line': {
      const a = d.points[0] ?? d.down
      return a !== null && a !== undefined && c !== null ? { rings: [[a, c]], open: false } : null
    }
    default: {
      if (d.cloud !== null) {
        return { rings: c === null ? [d.cloud] : [d.cloud, [c, nearestOnRing(d.cloud, c)]], open: false }
      }
      if (d.points.length === 0) {
        return d.down !== null && c !== null ? { rings: [boxRing(d.down, c)], open: false } : null
      }
      return { rings: [c === null ? d.points : [...d.points, c]], open: true }
    }
  }
}

// ------------------------------------------------------------ painting ----

const toScreen = (ring: ReadonlyArray<P>, v: Viewport, w: number, h: number): P[] =>
  ring.map((p) => normalizedToScreen(p.x, p.y, v, w, h))

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

function trace(ctx: Ctx, pts: ReadonlyArray<P>, close: boolean): void {
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  if (close) ctx.closePath()
}

function drawEnd(ctx: Ctx, tip: P, from: P, end: LineEnd, widthPx: number, unit: number, color: string): void {
  if (end === 'none') return
  if (end === 'dot') {
    ctx.beginPath()
    ctx.arc(tip.x, tip.y, dotRadius(widthPx / unit, unit), 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    return
  }
  const [b1, b2] = arrowBarbs(tip, from, widthPx / unit, unit)
  ctx.beginPath()
  if (end === 'arrow') {
    ctx.moveTo(tip.x, tip.y); ctx.lineTo(b1.x, b1.y); ctx.lineTo(b2.x, b2.y); ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  } else {
    ctx.moveTo(b1.x, b1.y); ctx.lineTo(tip.x, tip.y); ctx.lineTo(b2.x, b2.y)
    ctx.stroke()
  }
}

/** Measure text in a font, for wrapping on the canvas. */
export function canvasMeasure(ctx: Ctx, fontPx: number): (s: string) => number {
  ctx.font = `${fontPx}px Helvetica, Arial, sans-serif`
  return (s) => ctx.measureText(s).width
}

export interface NotePaint {
  /** Leave the text out: it is being edited in a box over it. */
  hideText?: boolean
  /** The outline is not closed yet. */
  open?: boolean
}

/** Paint one note. */
export function drawNote(
  ctx: Ctx, rings: ReadonlyArray<ReadonlyArray<P>>, c: NoteContent,
  view: Viewport, pageW: number, pageH: number, o: NotePaint = {},
): void {
  const unit = view.zoom
  const ring = toScreen(rings[0] ?? [], view, pageW, pageH)
  if (ring.length === 0) return
  const widthPx = c.width * unit
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.strokeStyle = c.color
  ctx.lineWidth = Math.max(1, widthPx)
  ctx.setLineDash([])
  const fill = () => {
    if (c.fill === null || c.fillOpacity <= 0) return
    ctx.fillStyle = rgba(c.fill, c.fillOpacity)
    ctx.fill()
  }
  const stroke = () => { if (c.width > 0) ctx.stroke() }

  switch (c.shape) {
    case 'text': {
      const x0 = Math.min(...ring.map((p) => p.x)), x1 = Math.max(...ring.map((p) => p.x))
      const y0 = Math.min(...ring.map((p) => p.y)), y1 = Math.max(...ring.map((p) => p.y))
      ctx.beginPath()
      ctx.rect(x0, y0, x1 - x0, y1 - y0)
      fill()
      stroke()
      if (o.hideText !== true && c.text !== '') {
        const fontPx = c.fontPt * unit
        const pad = TEXT_PAD_PT * unit
        const measure = canvasMeasure(ctx, fontPx)
        const lines = wrapLines(c.text, Math.max(1, x1 - x0 - 2 * pad), measure)
        ctx.fillStyle = c.color
        ctx.textBaseline = 'top'
        ctx.save()
        ctx.beginPath()
        ctx.rect(x0, y0, x1 - x0, y1 - y0)
        ctx.clip()
        lines.forEach((l, i) => ctx.fillText(l, x0 + pad, y0 + pad + i * fontPx * TEXT_LEADING + fontPx * 0.1))
        ctx.restore()
      }
      break
    }
    case 'rect': case 'polygon':
      ctx.beginPath()
      trace(ctx, ring, o.open !== true)
      if (o.open !== true) fill()
      stroke()
      break
    case 'ellipse': {
      const x0 = Math.min(...ring.map((p) => p.x)), x1 = Math.max(...ring.map((p) => p.x))
      const y0 = Math.min(...ring.map((p) => p.y)), y1 = Math.max(...ring.map((p) => p.y))
      ctx.beginPath()
      ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2)
      fill()
      stroke()
      break
    }
    case 'cloud': case 'callout': {
      ctx.beginPath()
      if (o.open === true) trace(ctx, ring, false)
      else {
        trace(ctx, cloudOutline(ring, cloudRadiusPt(c.width) * unit), true)
        fill()
      }
      stroke()
      const leader = rings[1]
      if (c.shape === 'callout' && leader !== undefined && leader.length >= 2) {
        const [tip, foot] = toScreen(leader, view, pageW, pageH) as [P, P]
        ctx.beginPath()
        ctx.moveTo(foot.x, foot.y)
        ctx.lineTo(tip.x, tip.y)
        stroke()
        drawEnd(ctx, tip, foot, c.ends[0], ctx.lineWidth, unit, c.color)
      }
      break
    }
    case 'arrow': case 'line': {
      if (ring.length < 2) break
      const [a, b] = ring as [P, P]
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
      drawEnd(ctx, a, b, c.ends[0], ctx.lineWidth, unit, c.color)
      drawEnd(ctx, b, a, c.ends[1], ctx.lineWidth, unit, c.color)
      break
    }
    case 'pen':
      ctx.beginPath()
      trace(ctx, ring, false)
      ctx.stroke()
      break
  }
  ctx.restore()
}

/** Paint the draft in the style it will be committed in. */
export function drawNoteDraft(
  ctx: Ctx, d: NoteDraft, c: NoteContent, view: Viewport, pageW: number, pageH: number,
): void {
  const pre = draftPreview(d)
  if (pre === null) {
    // One corner placed: mark it so the click was seen.
    const first = d.points[0]
    if (first === undefined) return
    const s = normalizedToScreen(first.x, first.y, view, pageW, pageH)
    ctx.save()
    ctx.fillStyle = c.color
    ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
    return
  }
  drawNote(ctx, pre.rings, { ...c, shape: d.shape }, view, pageW, pageH, { open: pre.open })
  // The first corner of an open outline is where a click closes it.
  if (pre.open && d.points.length >= 3) {
    const s = normalizedToScreen(d.points[0]!.x, d.points[0]!.y, view, pageW, pageH)
    ctx.save()
    ctx.strokeStyle = c.color
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(s.x, s.y, VERTEX_GRAB_PX, 0, Math.PI * 2); ctx.stroke()
    ctx.restore()
  }
}

// --------------------------------------------------------- hit-testing ----

export interface NoteLike {
  id: string
  rings: ReadonlyArray<ReadonlyArray<P>>
  content: NoteContent
}

/** The notes among some markups, with their content checked. */
export function notesOf(markups: ReadonlyArray<{ id: string; kind: string; rings: ReadonlyArray<ReadonlyArray<P>>; content?: unknown }>): NoteLike[] {
  const out: NoteLike[] = []
  for (const m of markups) {
    if (m.kind !== 'note') continue
    const content = parseNoteContent(m.content)
    if (content !== null && (m.rings[0]?.length ?? 0) > 0) out.push({ id: m.id, rings: m.rings, content })
  }
  return out
}

function nearPath(p: P, pts: ReadonlyArray<P>, close: boolean, tol: number): number {
  for (let i = 0; i + 1 < pts.length + (close ? 1 : 0); i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!
    if (distanceToSegment(p, a, b) <= tol) return i
  }
  return -1
}

/**
 * The note under a screen point, newest first, in the shape `hitTest`
 * answers so the select tool treats a note like any markup:
 *  - a corner of a polygon or cloud, or an end of a line: `vertex`;
 *  - the edge of a box (text, rectangle, ellipse): `edge`, which resizes it;
 *  - on its line or inside a closed shape: `inside`, which moves it.
 */
export function hitTestNote(
  sx: number, sy: number, notes: ReadonlyArray<NoteLike>, view: Viewport, pageW: number, pageH: number,
): Hit | null {
  const p = { x: sx, y: sy }
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i]!
    const shape = n.content.shape
    const ring = toScreen(n.rings[0] ?? [], view, pageW, pageH)
    const lineTol = Math.max(EDGE_GRAB_PX, n.content.width * view.zoom / 2 + 2)
    if (!isBoxShape(shape) && shape !== 'pen') {
      for (let vi = 0; vi < ring.length; vi++) {
        if (Math.hypot(ring[vi]!.x - sx, ring[vi]!.y - sy) <= VERTEX_GRAB_PX) return { markupId: n.id, part: 'vertex', index: vi }
      }
    }
    if (isBoxShape(shape)) {
      const e = nearPath(p, ring, true, EDGE_GRAB_PX)
      if (e >= 0) return { markupId: n.id, part: 'edge', index: e }
    }
    if (nearPath(p, ring, isClosedShape(shape), lineTol) >= 0) return { markupId: n.id, part: 'inside', index: -1 }
    for (const extra of n.rings.slice(1)) {
      if (nearPath(p, toScreen(extra, view, pageW, pageH), false, lineTol) >= 0) return { markupId: n.id, part: 'inside', index: -1 }
    }
    if (isClosedShape(shape) && ring.length >= 3) {
      if (shape === 'ellipse') {
        const xs = ring.map((q) => q.x), ys = ring.map((q) => q.y)
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2
        const rx = (Math.max(...xs) - Math.min(...xs)) / 2, ry = (Math.max(...ys) - Math.min(...ys)) / 2
        if (rx > 0 && ry > 0 && ((sx - cx) / rx) ** 2 + ((sy - cy) / ry) ** 2 <= 1) return { markupId: n.id, part: 'inside', index: -1 }
      } else if (pointInPolygon(p, ring)) return { markupId: n.id, part: 'inside', index: -1 }
    }
  }
  return null
}

/**
 * The height a text box needs for its text, in normalized units: at least
 * the box it was drawn as, grown downward so no line is cut off.
 */
export function textBoxHeightFor(
  c: NoteContent, widthPt: number, measureAtPt: (s: string) => number,
): number {
  const lines = wrapLines(c.text, Math.max(1, widthPt - 2 * TEXT_PAD_PT), measureAtPt)
  return lines.length * c.fontPt * TEXT_LEADING + 2 * TEXT_PAD_PT
}
