/**
 * Markups that say something rather than measure something: a text box, a
 * cloud, a cloud with a leader, an arrow, a line, a rectangle, an ellipse, a
 * polygon and a pen stroke (Kenneth, 2026-11-26: "I need a text box", "clouds
 * and clouds with leaders", "arrows", "just the basic shapes", "a pen").
 *
 * They are one markup kind, `note`, so they share one path through the app:
 * no scope, no quantity, drawn on the annotation layer, selected, moved,
 * copied and deleted like any other markup, and written into the PDF as the
 * annotation Bluebeam itself would write for each (sheetEmbed.ts), so Revu
 * opens them as its own clouds, text boxes and arrows and can edit them.
 *
 * This file is the part both the canvas and the PDF writer need: the stored
 * shape of a note and the geometry of a cloud's scallops and an arrowhead,
 * computed in whatever metric space the caller draws in (screen pixels or
 * PDF points). Nothing here touches the DOM.
 */

export type NoteShape =
  | 'text' | 'cloud' | 'callout' | 'arrow' | 'line'
  | 'rect' | 'ellipse' | 'polygon' | 'pen'

export const NOTE_SHAPES: readonly NoteShape[] = [
  'text', 'cloud', 'callout', 'arrow', 'line', 'rect', 'ellipse', 'polygon', 'pen',
]

/** How a line ends. `arrow` is filled, `open` is two strokes, `dot` a disc. */
export type LineEnd = 'none' | 'arrow' | 'open' | 'dot'

export const LINE_ENDS: readonly LineEnd[] = ['arrow', 'open', 'dot', 'none']

export interface NoteContent {
  shape: NoteShape
  /** Line (and text) colour, `#rrggbb`. */
  color: string
  /** Line width in PDF points. 0 draws no border (a text box without one). */
  width: number
  /** Fill colour, `#rrggbb`, or null for none. */
  fill: string | null
  /** Fill opacity, 0..1. */
  fillOpacity: number
  /**
   * Ends of a line, an arrow, or a callout's leader: [start, end]. The start
   * is the first point placed, which for an arrow is what it points at, the
   * way Revu's Arrow tool draws it.
   */
  ends: [LineEnd, LineEnd]
  /** The text of a text box, or at the tail of a leader or a cloud's leader. */
  text: string
  /** Font size of that text, in PDF points. */
  fontPt: number
}

/**
 * Where each shape keeps its geometry, all normalized page coordinates:
 *  - text, rect, ellipse: rings[0] is the box, four corners TL TR BR BL;
 *  - cloud, polygon: rings[0] is the outline;
 *  - arrow (a leader, Revu's Callout): rings[0] is [head, tail], the head
 *    being what it points at, and rings[1] the text box at the tail;
 *  - callout (Revu's Cloud+): rings[0] the cloud, rings[1] the leader
 *    [head on the cloud, tail], rings[2] the text box at the tail;
 *  - line: rings[0] is [start, end];
 *  - pen: rings[0] is the stroke.
 * Every ring moves with the markup, so the generic move works on all of them.
 */
export interface NoteMarkupLike {
  id: string
  kind: string
  rings: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>
  content?: unknown
}

/** The colours offered first: Revu's red, blue, green, black, orange, magenta. */
export const NOTE_COLORS = ['#e5322d', '#1f6fd6', '#1e9e4a', '#1b1d21', '#f08a00', '#c2185b'] as const

export const NOTE_WIDTHS = [0.5, 1, 1.5, 2, 3, 5] as const

export const NOTE_FONT_SIZES = [8, 10, 12, 14, 18, 24] as const

/** The defaults a fresh tool starts from, per shape. */
export function defaultNoteContent(shape: NoteShape): NoteContent {
  return {
    shape,
    color: NOTE_COLORS[0],
    width: shape === 'text' ? 1 : 1.5,
    fill: shape === 'text' ? '#ffffff' : null,
    fillOpacity: shape === 'text' ? 1 : 0.25,
    ends: shape === 'arrow' || shape === 'callout' ? ['arrow', 'none'] : ['none', 'none'],
    text: '',
    fontPt: 12,
  }
}

const HEX = /^#[0-9a-f]{6}$/i

/**
 * A stored note's content, checked. Anything missing or malformed takes the
 * shape's default, so one bad row never takes the painter down (the lesson
 * of the dimension that threw inside the paint loop).
 */
export function parseNoteContent(raw: unknown): NoteContent | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const shape = r['shape']
  if (typeof shape !== 'string' || !(NOTE_SHAPES as readonly string[]).includes(shape)) return null
  const d = defaultNoteContent(shape as NoteShape)
  const end = (v: unknown, fb: LineEnd): LineEnd =>
    typeof v === 'string' && (LINE_ENDS as readonly string[]).includes(v) ? v as LineEnd : fb
  const ends = Array.isArray(r['ends']) ? r['ends'] : []
  const num = (v: unknown, fb: number, lo: number, hi: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb
  return {
    shape: shape as NoteShape,
    color: typeof r['color'] === 'string' && HEX.test(r['color']) ? r['color'] : d.color,
    width: num(r['width'], d.width, 0, 24),
    fill: r['fill'] === null ? null : typeof r['fill'] === 'string' && HEX.test(r['fill']) ? r['fill'] : d.fill,
    fillOpacity: num(r['fillOpacity'], d.fillOpacity, 0, 1),
    ends: [end(ends[0], d.ends[0]), end(ends[1], d.ends[1])],
    text: typeof r['text'] === 'string' ? r['text'] : '',
    fontPt: num(r['fontPt'], d.fontPt, 4, 144),
  }
}

/** A note's content, or null when the markup is not a note. */
export function noteContentOf(m: NoteMarkupLike): NoteContent | null {
  return m.kind === 'note' ? parseNoteContent(m.content) : null
}

/** Whether the shape is closed, so can be filled and grabbed inside. */
export function isClosedShape(shape: NoteShape): boolean {
  return shape !== 'arrow' && shape !== 'line' && shape !== 'pen'
}

/** Whether the shape is stored as an axis-aligned box. */
export function isBoxShape(shape: NoteShape): boolean {
  return shape === 'text' || shape === 'rect' || shape === 'ellipse'
}

/** Which shapes carry line ends. */
export function hasEnds(shape: NoteShape): boolean {
  return shape === 'arrow' || shape === 'line' || shape === 'callout'
}

/**
 * Which shapes carry text: the text box, and the two leaders, whose text
 * sits at the tail the way a comment on a drawing does (Aaron, 2026-11-27:
 * "this is for commenting, not just for random sketches").
 */
export function hasText(shape: NoteShape): boolean {
  return shape === 'text' || shape === 'arrow' || shape === 'callout'
}

/** Which ring holds the shape's text box, or -1. */
export function textRingIndex(shape: NoteShape): number {
  return shape === 'text' ? 0 : shape === 'arrow' ? 1 : shape === 'callout' ? 2 : -1
}

/** Which ring holds a leader [head, tail], or -1. */
export function leaderRingIndex(shape: NoteShape): number {
  return shape === 'arrow' ? 0 : shape === 'callout' ? 1 : -1
}

// ------------------------------------------------------------ geometry ----

type P = { x: number; y: number }

/** Four corners TL TR BR BL of the box spanned by two points. */
export function boxRing(a: P, b: P): P[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x)
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y)
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
}

/** The bounds of some points. */
export function boundsOf(pts: ReadonlyArray<P>): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pts) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  return { x0, y0, x1, y1 }
}

function signedArea(ring: ReadonlyArray<P>): number {
  let s = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

/**
 * The scalloped outline of a cloud around a closed ring, as a polyline.
 *
 * Each edge is cut into equal steps of about twice `radius`, and each step
 * gets a half-circle bulging outward. `y` may point up or down: the bulge
 * follows the ring's own winding, so the scallops face out either way.
 * `perArc` points are emitted per scallop (the first point of each scallop
 * is the last of the one before, so it is emitted once).
 */
export function cloudOutline(ring: ReadonlyArray<P>, radius: number, perArc = 8): P[] {
  if (ring.length < 3 || !(radius > 0)) return ring.map((p) => ({ ...p }))
  // The sign of the area says which way the ring winds, and so which side
  // of each edge is outside it.
  const ccw = signedArea(ring) > 0
  const out: P[] = []
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len === 0) continue
    const n = Math.max(1, Math.round(len / (2 * radius)))
    for (let k = 0; k < n; k++) {
      const s = { x: a.x + (b.x - a.x) * (k / n), y: a.y + (b.y - a.y) * (k / n) }
      const e = { x: a.x + (b.x - a.x) * ((k + 1) / n), y: a.y + (b.y - a.y) * ((k + 1) / n) }
      const c = { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 }
      const r = Math.hypot(e.x - s.x, e.y - s.y) / 2
      const a0 = Math.atan2(s.y - c.y, s.x - c.x)
      // Sweep half a turn from s to e through the outward side.
      const dir = ccw ? 1 : -1
      for (let j = out.length === 0 ? 0 : 1; j <= perArc; j++) {
        const t = a0 + dir * Math.PI * (j / perArc)
        out.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) })
      }
    }
  }
  return out
}

/**
 * The text box at a leader's tail, `w` by `h`: the tail sits halfway down
 * the box's near side and the box runs on away from the head, as Revu lays
 * out a callout. Four corners TL TR BR BL, in the caller's units (y down).
 */
export function boxAtTail(head: P, tail: P, w: number, h: number): P[] {
  const x0 = tail.x >= head.x ? tail.x : tail.x - w
  const y0 = tail.y - h / 2
  return [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }]
}

/** The point on a closed ring's edges nearest `p`: where a leader meets the cloud. */
export function nearestOnRing(ring: ReadonlyArray<P>, p: P): P {
  let best = ring[0] ?? p
  let bestD = Infinity
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!
    const dx = b.x - a.x, dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
    const q = { x: a.x + t * dx, y: a.y + t * dy }
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d < bestD) { bestD = d; best = q }
  }
  return best
}

/**
 * The arrowhead at `tip`, pointing away from `from`: its two barbs. Length
 * grows with the line so a heavy line keeps a head that reads.
 */
export function arrowBarbs(tip: P, from: P, width: number, unit = 1): [P, P] {
  const len = Math.max(8 * unit, width * 4 * unit)
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x)
  const spread = Math.PI / 7
  return [
    { x: tip.x - len * Math.cos(ang - spread), y: tip.y - len * Math.sin(ang - spread) },
    { x: tip.x - len * Math.cos(ang + spread), y: tip.y - len * Math.sin(ang + spread) },
  ]
}

/** Radius of a dot end. */
export function dotRadius(width: number, unit = 1): number {
  return Math.max(2.5 * unit, width * 1.6 * unit)
}

/**
 * Lay text into lines no wider than `maxWidth`, breaking at spaces and at
 * the user's own line breaks; a word wider than the box gets a line of its
 * own rather than being cut. `measure` is the caller's text width.
 */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = []
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/ +/)
    let line = ''
    for (const w of words) {
      const next = line === '' ? w : `${line} ${w}`
      if (line !== '' && measure(next) > maxWidth) { out.push(line); line = w }
      else line = next
    }
    out.push(line)
  }
  return out
}

/** Inner padding of a text box, in points. */
export const TEXT_PAD_PT = 4

/** Line height as a multiple of the font size. */
export const TEXT_LEADING = 1.2

/** The widest a leader's text box grows before its text wraps, in points. */
export const LEADER_TEXT_MAX_PT = 180

/**
 * The size, in points, of the box that holds a leader's text: as wide as its
 * longest line up to LEADER_TEXT_MAX_PT, as tall as its lines. `measure`
 * gives a string's width at the font size.
 */
export function leaderTextSize(text: string, fontPt: number, measure: (s: string) => number): { w: number; h: number } {
  const lines = wrapLines(text, LEADER_TEXT_MAX_PT - 2 * TEXT_PAD_PT, measure)
  const widest = Math.max(0, ...lines.map(measure))
  return {
    w: Math.max(fontPt * 2, Math.ceil(widest) + 2 * TEXT_PAD_PT + 1),
    h: Math.max(1, lines.length) * fontPt * TEXT_LEADING + 2 * TEXT_PAD_PT,
  }
}

/** Scallop radius of a cloud in points, from its line width. */
export function cloudRadiusPt(width: number): number {
  return Math.max(6, 4 + width * 3)
}

/**
 * Drop points of a pen stroke that sit within `tol` of the line through
 * their neighbours (Douglas-Peucker), so a stroke keeps its shape without
 * every pointer sample.
 */
export function simplifyStroke(pts: ReadonlyArray<P>, tol: number): P[] {
  if (pts.length <= 2) return pts.map((p) => ({ ...p }))
  const keep = new Array<boolean>(pts.length).fill(false)
  keep[0] = true
  keep[pts.length - 1] = true
  const stack: Array<[number, number]> = [[0, pts.length - 1]]
  while (stack.length > 0) {
    const [i, j] = stack.pop()!
    const a = pts[i]!, b = pts[j]!
    const dx = b.x - a.x, dy = b.y - a.y
    const l = Math.hypot(dx, dy)
    let worst = -1, at = -1
    for (let k = i + 1; k < j; k++) {
      const p = pts[k]!
      const d = l === 0 ? Math.hypot(p.x - a.x, p.y - a.y) : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / l
      if (d > worst) { worst = d; at = k }
    }
    if (worst > tol && at > 0) {
      keep[at] = true
      stack.push([i, at], [at, j])
    }
  }
  return pts.filter((_, k) => keep[k]).map((p) => ({ ...p }))
}
