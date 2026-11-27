/**
 * Arcs and circles in the Area, Cutout and Linear tools (Kenneth, 2026-11-26:
 * "Can we do arcs?").
 *
 * A markup's ring is a list of vertices, so a curve is stored the way the
 * agent's curves already are (agent/arcs.ts): as a dense polyline whose
 * chords stay within a twentieth of a point of the true curve. Areas,
 * lengths, cutting and patterns then follow the curve with no new geometry
 * anywhere else in the app.
 *
 * What a person does:
 *  - Arc: press A (or pick Arc under the sheet) while tracing. The next click
 *    is a point the curve passes through, the click after it is where the arc
 *    ends. That is the three-point arc every CAD user knows, and it needs no
 *    radius typed. Then the trace goes back to straight lines.
 *  - Circle: pick Circle (or Shift+C). Click the centre, then a point on the
 *    edge. The circle is finished on the second click. It stays armed, so a
 *    row of round pendants is two clicks each.
 *
 * Geometry is NORMALIZED page coordinates, worked in page points so a curve
 * is round on the sheet and not in [0,1].
 */
import { arcPoints, circleRing } from '../agent/arcs.js'
import type { DraftState } from '../draw.js'

type P = { x: number; y: number }
type Page = { width: number; height: number }

/** How the next click joins the trace. */
export type SegmentMode = 'line' | 'arc' | 'circle'

/** The tools that draw curves. */
export const CURVE_TOOLS: ReadonlySet<string> = new Set(['area', 'cutout', 'polyline'])

/**
 * How far a chord may stray from the true curve, in points: a hundredth.
 * A chord always cuts inside the curve, so a polygon measures a little less
 * than its circle: about 4/3 of this over the radius. At a hundredth that is
 * 0.013% on a 100 pt radius and under 0.1% down to a 15 pt one.
 */
const TOLERANCE = 0.01

/**
 * The bulge (tan of a quarter of the sweep, positive counter-clockwise with y
 * up, as agent/arcs.ts takes it) of the arc that leaves `a`, passes through
 * `m` and ends at `b`. Null when the three are in a line: no arc fits.
 */
export function bulgeThrough(a: P, m: P, b: P, page: Page): number | null {
  // Page points, y up.
  const ax = a.x * page.width, ay = -a.y * page.height
  const mx = m.x * page.width, my = -m.y * page.height
  const bx = b.x * page.width, by = -b.y * page.height
  const d = 2 * (ax * (my - by) + mx * (by - ay) + bx * (ay - my))
  const scale = Math.max(Math.hypot(bx - ax, by - ay), Math.hypot(mx - ax, my - ay), 1e-9)
  if (Math.abs(d) < 1e-9 * scale * scale) return null
  const a2 = ax * ax + ay * ay, m2 = mx * mx + my * my, b2 = bx * bx + by * by
  const cx = (a2 * (my - by) + m2 * (by - ay) + b2 * (ay - my)) / d
  const cy = (a2 * (bx - mx) + m2 * (ax - bx) + b2 * (mx - ax)) / d
  const TAU = Math.PI * 2
  const norm = (t: number) => ((t % TAU) + TAU) % TAU
  const ta = Math.atan2(ay - cy, ax - cx)
  const toB = norm(Math.atan2(by - cy, bx - cx) - ta)
  const toM = norm(Math.atan2(my - cy, mx - cx) - ta)
  // Counter-clockwise from a, m comes before b: the arc runs that way.
  // Otherwise it runs clockwise, the long way round counter-clockwise.
  const sweep = toM < toB ? toB : toB - TAU
  if (Math.abs(sweep) < 1e-9) return null
  return Math.tan(sweep / 4)
}

/**
 * The vertices the arc a -> (through m) -> b adds to a trace: the points
 * along it and `b`, but not `a`, which is already down. Three points in a
 * line give the straight segment, `[b]`.
 */
export function arcThrough(a: P, m: P, b: P, page: Page): P[] {
  const bulge = bulgeThrough(a, m, b, page)
  if (bulge === null || !(page.width > 0) || !(page.height > 0)) return [b]
  return [...arcPoints(a, b, bulge, page, TOLERANCE), b]
}

/** A circle as a ring, from its centre and a point on its edge. */
export function circleFrom(centre: P, rim: P, page: Page): P[] {
  const r = Math.hypot((rim.x - centre.x) * page.width, (rim.y - centre.y) * page.height)
  if (!(r > 0) || !(page.width > 0)) return []
  return circleRing({ cx: centre.x, cy: centre.y, r: r / page.width }, page, TOLERANCE)
}

/** Points the first one starts the trace again from; within a millionth. */
const same = (a: P, b: P) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9

/**
 * One click in a curve tool.
 *
 * `complete` says the draft is finished and should be committed (a circle's
 * second click). Any other tool, or a line segment, places the point as
 * before. `marks` records the trace's length after each click, so Backspace
 * takes back a whole arc rather than one of its many points.
 */
export function placeCurvePoint(d: DraftState, p: P, page: Page): { draft: DraftState; complete: boolean } {
  const mode = d.mode ?? 'line'
  const marks = d.marks ?? []
  if (mode === 'circle' && CURVE_TOOLS.has(d.tool)) {
    if (d.pivot === undefined) return { draft: { ...d, points: [], pivot: p, marks: [] }, complete: false }
    const ring = circleFrom(d.pivot, p, page)
    if (ring.length < 3) return { draft: d, complete: false }
    // A run round a circle is its circumference: closed by coming back to the start.
    const points = d.tool === 'polyline' ? [...ring, ring[0]!] : ring
    const { pivot: _drop, ...rest } = d
    return { draft: { ...rest, points, marks: [points.length] }, complete: true }
  }
  if (mode === 'arc' && CURVE_TOOLS.has(d.tool) && d.points.length > 0) {
    if (d.pivot === undefined) return { draft: { ...d, pivot: p }, complete: false }
    const last = d.points[d.points.length - 1]!
    const added = arcThrough(last, d.pivot, p, page)
    const points = [...d.points, ...added]
    const { pivot: _drop, ...rest } = d
    // One arc, then straight lines again: a rounded end is line, arc, line.
    return { draft: { ...rest, points, mode: 'line', marks: [...marks, points.length] }, complete: false }
  }
  const points = [...d.points, p]
  return { draft: { ...d, points, marks: [...marks, points.length] }, complete: false }
}

/**
 * Backspace: a half-placed arc loses its through point first; otherwise the
 * last click goes, a whole arc at once.
 */
export function backCurvePoint(d: DraftState): DraftState {
  if (d.pivot !== undefined) {
    const { pivot: _drop, ...rest } = d
    return rest
  }
  const marks = d.marks ?? []
  // A trace whose marks do not describe it (a dragged rectangle) steps back one point.
  if (marks.length === 0 || marks[marks.length - 1] !== d.points.length) {
    return { ...d, points: d.points.slice(0, -1), marks: [] }
  }
  const kept = marks.slice(0, -1)
  return { ...d, points: d.points.slice(0, kept[kept.length - 1] ?? 0), marks: kept }
}

/**
 * The trace as it should be committed.
 *
 * Enter on an area or cutout with an arc half placed closes with that arc,
 * back to the first point. A closed ring whose last click landed on its first
 * point (snapped there to close an arc) does not keep the repeat.
 */
export function finishCurve(d: DraftState, page: Page): DraftState {
  let points = d.points
  const closed = d.tool === 'area' || d.tool === 'cutout'
  if (closed && d.mode === 'arc' && d.pivot !== undefined && points.length >= 2) {
    points = [...points, ...arcThrough(points[points.length - 1]!, d.pivot, points[0]!, page)]
  }
  if (closed) while (points.length > 3 && same(points[points.length - 1]!, points[0]!)) points = points.slice(0, -1)
  const { pivot: _drop, ...rest } = d
  return { ...rest, points }
}

/** The preview of what the next click would add, from the last point to the cursor. */
export function previewCurve(d: DraftState, page: Page): P[] {
  const cursor = d.cursor
  if (cursor === null) return []
  if (d.mode === 'circle' && d.pivot !== undefined) return circleFrom(d.pivot, cursor, page)
  const last = d.points[d.points.length - 1]
  if (last === undefined) return []
  if (d.mode === 'arc' && d.pivot !== undefined) return arcThrough(last, d.pivot, cursor, page)
  return [cursor]
}

/**
 * The segment mode a key asks for in a curve tool, or null to leave the key
 * to the tool shortcuts. A bare A mid-trace toggles an arc for the next
 * segment (with nothing traced, A still arms Area); Shift+C toggles circles.
 */
export function curveModeForKey(
  key: string,
  mods: { ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  d: Pick<DraftState, 'points' | 'mode'>,
): SegmentMode | null {
  if (mods.ctrlKey || mods.metaKey || mods.altKey) return null
  if (key === 'a' && d.points.length > 0) return d.mode === 'arc' ? 'line' : 'arc'
  if (key === 'C' && d.points.length === 0) return d.mode === 'circle' ? 'line' : 'circle'
  return null
}
