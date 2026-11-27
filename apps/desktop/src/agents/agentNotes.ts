/**
 * Comment markups (kind `note`: text box, cloud, Cloud+ with leader, leader
 * with text, line, rectangle, ellipse, polygon, pen) from an agent's call:
 * the same rings and content the note tools commit (tools/noteGeometry.ts),
 * built from a description an agent can write without knowing how each shape
 * keeps its rings.
 *
 * Coordinates are normalized [0,1], y down, like every agent call. Sizes in
 * points (line width, font) need the page's size in points to become boxes.
 */
import {
  NOTE_SHAPES, boxAtTail, boxRing, defaultNoteContent, hasText, leaderTextSize, nearestOnRing, parseNoteContent,
  type LineEnd, type NoteContent, type NoteShape,
} from '../tools/noteGeometry.js'

type P = { x: number; y: number }
type Rings = P[][]

/** Names an agent may use for a colour, as Revu's palette names them. */
export const NOTE_COLOR_NAMES: Readonly<Record<string, string>> = {
  red: '#e5322d', blue: '#1f6fd6', green: '#1e9e4a', black: '#1b1d21', orange: '#f08a00', magenta: '#c2185b',
  yellow: '#e6c700', purple: '#8000ff', white: '#ffffff',
}

/** A rough width for text, when no canvas is at hand to measure it. */
export function roughMeasure(fontPt: number): (s: string) => number {
  return (s) => s.length * fontPt * 0.52
}

function colour(v: unknown, what: string): string | null | { error: string } {
  if (v === undefined) return null
  if (v === null || v === 'none') return 'none'
  const s = String(v).trim().toLowerCase()
  const hex = NOTE_COLOR_NAMES[s] ?? s
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : { error: `${what} must be #rrggbb or one of ${Object.keys(NOTE_COLOR_NAMES).join(', ')}` }
}

function point(v: unknown): P | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const x = Number(o['x']), y = Number(o['y'])
  return Number.isFinite(x) && Number.isFinite(y) && x >= -0.05 && x <= 1.05 && y >= -0.05 && y <= 1.05 ? { x, y } : null
}

function points(v: unknown): P[] | null {
  let raw = v
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { return null } }
  if (!Array.isArray(raw)) return null
  const out = raw.map(point)
  return out.every((p) => p !== null) ? out as P[] : null
}

function rect(v: unknown): { x0: number; y0: number; x1: number; y1: number } | null {
  let raw = v
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { return null } }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const r = { x0: Number(o['x0']), y0: Number(o['y0']), x1: Number(o['x1']), y1: Number(o['y1']) }
  if (![r.x0, r.y0, r.x1, r.y1].every((n) => Number.isFinite(n) && n >= -0.05 && n <= 1.05)) return null
  if (r.x0 === r.x1 || r.y0 === r.y1) return null
  return r
}

/** The style fields of a call, over `base`. */
export function noteStyle(spec: Record<string, unknown>, base: NoteContent): NoteContent | { error: string } {
  const out: NoteContent = { ...base, ends: [...base.ends] as [LineEnd, LineEnd] }
  const c = colour(spec['color'], 'color')
  if (c !== null && typeof c === 'object') return c
  if (c === 'none') return { error: 'color cannot be none' }
  if (c !== null) out.color = c
  const f = colour(spec['fill'], 'fill')
  if (f !== null && typeof f === 'object') return f
  if (f !== null) out.fill = f === 'none' ? null : f
  const num = (k: string, lo: number, hi: number): number | undefined | { error: string } => {
    if (spec[k] === undefined) return undefined
    const n = Number(spec[k])
    return Number.isFinite(n) && n >= lo && n <= hi ? n : { error: `${k} must be a number from ${lo} to ${hi}` }
  }
  for (const [k, lo, hi] of [['width', 0, 24], ['fillOpacity', 0, 1], ['fontPt', 4, 144]] as const) {
    const n = num(k, lo, hi)
    if (typeof n === 'object') return n
    if (n !== undefined) out[k] = n
  }
  if (spec['ends'] !== undefined) {
    const e = Array.isArray(spec['ends']) ? spec['ends'] : []
    const ok = ['none', 'arrow', 'open', 'dot']
    if (e.length !== 2 || !e.every((x) => ok.includes(String(x)))) return { error: 'ends must be [start, end], each none, arrow, open or dot; the start is what a leader points at' }
    out.ends = [String(e[0]) as LineEnd, String(e[1]) as LineEnd]
  }
  if (spec['text'] !== undefined) out.text = String(spec['text']).replace(/\s+$/, '')
  return parseNoteContent(out) ?? out
}

/**
 * A note from an agent's description. Geometry by shape:
 *  - text, rect, ellipse: `rect`;
 *  - cloud: `rect` or `points` (the outline);
 *  - polygon, pen: `points`;
 *  - line: `points` [start, end];
 *  - arrow (a leader): `points` [head, tail], the text box sits at the tail;
 *  - callout (Cloud+): the cloud as `rect` or `points`, and `tail`, where its
 *    text sits; the leader runs from the nearest point on the cloud.
 */
export function noteFromAgent(
  spec: Record<string, unknown>,
  page: { width: number; height: number },
  measure: (fontPt: number) => (s: string) => number = roughMeasure,
): { rings: Rings; content: NoteContent } | { error: string } {
  const shape = String(spec['shape'] ?? '') as NoteShape
  if (!NOTE_SHAPES.includes(shape)) return { error: `shape must be one of ${NOTE_SHAPES.join(', ')}` }
  const content = noteStyle(spec, defaultNoteContent(shape))
  if ('error' in content) return content
  if (!hasText(shape) && content.text !== '') return { error: `a ${shape} carries no text; use text, arrow (a leader) or callout (Cloud+)` }
  if (shape === 'text' && content.text === '') return { error: 'a text box needs `text`' }
  const box = spec['rect'] === undefined ? undefined : rect(spec['rect'])
  if (box === null) return { error: 'rect must be {x0,y0,x1,y1}, normalized [0,1], with some width and height' }
  const pts = spec['points'] === undefined ? undefined : points(spec['points'])
  if (pts === null) return { error: 'points must be [{x,y}, …], normalized [0,1], y down' }
  const pw = page.width > 0 ? page.width : 1
  const ph = page.height > 0 ? page.height : 1
  const textBox = (head: P, tail: P): P[] => {
    const size = leaderTextSize(content.text === '' ? ' ' : content.text, content.fontPt, measure(content.fontPt))
    return boxAtTail(head, tail, size.w / pw, size.h / ph)
  }
  switch (shape) {
    case 'text': case 'rect': case 'ellipse':
      if (box === undefined) return { error: `a ${shape} needs rect {x0,y0,x1,y1}` }
      return { rings: [boxRing({ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y1 })], content }
    case 'polygon': case 'pen':
      if (pts === undefined || pts.length < (shape === 'pen' ? 2 : 3)) return { error: `a ${shape} needs points, at least ${shape === 'pen' ? 2 : 3}` }
      return { rings: [pts], content }
    case 'line':
      if (pts === undefined || pts.length !== 2) return { error: 'a line needs points [start, end]' }
      return { rings: [pts], content }
    case 'arrow': {
      if (pts === undefined || pts.length !== 2) return { error: 'an arrow (leader) needs points [head, tail]: the head is what it points at, the text sits at the tail' }
      return { rings: [pts, textBox(pts[0]!, pts[1]!)], content }
    }
    case 'cloud': case 'callout': {
      const outline = box !== undefined ? boxRing({ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y1 }) : pts
      if (outline === undefined || outline.length < 3) return { error: `a ${shape} needs the cloud as rect {x0,y0,x1,y1} or points (at least 3)` }
      if (shape === 'cloud') return { rings: [outline], content }
      const tail = point(spec['tail'])
      if (tail === null) return { error: 'a callout (Cloud+) needs tail {x,y}: where its text sits, outside the cloud' }
      const head = nearestOnRing(outline, tail)
      return { rings: [outline, [head, tail], textBox(head, tail)], content }
    }
  }
}

/**
 * A note's text box refitted after its text changed: a leader's box at the
 * tail, sized to the text. Text boxes keep the box they were given.
 */
export function refitLeaderText(
  rings: Rings, content: NoteContent, page: { width: number; height: number },
  measure: (fontPt: number) => (s: string) => number = roughMeasure,
): Rings {
  const leader = content.shape === 'arrow' ? 0 : content.shape === 'callout' ? 1 : -1
  const at = content.shape === 'arrow' ? 1 : content.shape === 'callout' ? 2 : -1
  const line = leader < 0 ? undefined : rings[leader]
  if (line === undefined || line.length < 2) return rings
  const size = leaderTextSize(content.text === '' ? ' ' : content.text, content.fontPt, measure(content.fontPt))
  const out = rings.map((r) => r.map((p) => ({ ...p })))
  out[at] = boxAtTail(line[0]!, line[1]!, size.w / (page.width || 1), size.h / (page.height || 1))
  return out
}
