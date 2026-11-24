/**
 * Curved outlines from an agent (round 3 #10): the Boardroom's rounded ends
 * and a pendant ring's circle, instead of straight-sided guesses.
 *
 * A markup's ring is a list of vertices, so a curve is stored as a dense
 * polyline. What changes is who chooses the points: the agent states the arc
 * (a DXF-style bulge on the vertex it leaves from, or a circle), and the arc
 * is laid out here so no chord strays more than `tolerancePoints` from the
 * true curve (a twentieth of a point by default). Areas,
 * lengths and pattern clipping then follow the curve to that tolerance.
 */

export type Vertex = { x: number; y: number; bulge?: number }
export type Circle = { circle: { cx: number; cy: number; r: number; rUnit?: 'width' | 'height' } }

const isCircle = (r: unknown): r is Circle =>
  typeof r === 'object' && r !== null && !Array.isArray(r) && typeof (r as Circle).circle === 'object'

/**
 * The points along an arc from a to b with bulge = tan(sweep / 4), positive
 * counter-clockwise as the drawing reads it (y up); a and b excluded.
 * Worked in page points so the arc is round on the sheet, not in [0,1].
 */
export function arcPoints(
  a: { x: number; y: number }, b: { x: number; y: number }, bulge: number,
  page: { width: number; height: number }, tolerancePoints = 0.05,
): Array<{ x: number; y: number }> {
  if (!Number.isFinite(bulge) || Math.abs(bulge) < 1e-9) return []
  // Page points with y UP, so "counter-clockwise" means what it does in CAD.
  const ax = a.x * page.width, ay = -a.y * page.height
  const bx = b.x * page.width, by = -b.y * page.height
  const chord = Math.hypot(bx - ax, by - ay)
  if (chord === 0) return []
  const sweep = 4 * Math.atan(bulge)
  const r = chord / (2 * Math.abs(Math.sin(sweep / 2)))
  // Centre: from the chord midpoint along its left normal by r*cos(sweep/2) (signed).
  const mx = (ax + bx) / 2, my = (ay + by) / 2
  const ux = (bx - ax) / chord, uy = (by - ay) / chord
  const d = r * Math.cos(sweep / 2) * Math.sign(bulge)
  const h = (Math.abs(bulge) > 1 ? -1 : 1) * Math.abs(d) * Math.sign(bulge)
  const cx = mx - uy * h, cy = my + ux * h
  const a0 = Math.atan2(ay - cy, ax - cx)
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolerancePoints / Math.max(r, tolerancePoints))))
  const n = Math.min(720, Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-3))))
  const out: Array<{ x: number; y: number }> = []
  for (let i = 1; i < n; i++) {
    const t = a0 + (sweep * i) / n
    out.push({ x: (cx + r * Math.cos(t)) / page.width, y: -(cy + r * Math.sin(t)) / page.height })
  }
  return out
}

/** A circle as a ring. `r` is normalized to the page width unless rUnit says height. */
export function circleRing(
  c: Circle['circle'], page: { width: number; height: number }, tolerancePoints = 0.05,
): Array<{ x: number; y: number }> {
  const rp = c.r * (c.rUnit === 'height' ? page.height : page.width)
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolerancePoints / Math.max(rp, tolerancePoints))))
  const n = Math.min(720, Math.max(12, Math.ceil((2 * Math.PI) / Math.max(step, 1e-3))))
  const out: Array<{ x: number; y: number }> = []
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n
    out.push({ x: c.cx + (rp * Math.cos(t)) / page.width, y: c.cy - (rp * Math.sin(t)) / page.height })
  }
  return out
}

/**
 * One ring as stored: vertices with any bulges laid out as arcs, or a circle.
 * `closed` decides whether the last vertex's bulge arcs back to the first.
 * Returns null for something that is neither.
 */
export function expandRing(
  ring: unknown, page: { width: number; height: number }, closed: boolean, tolerancePoints = 0.05,
): Array<{ x: number; y: number }> | null {
  if (isCircle(ring)) {
    const { cx, cy, r } = ring.circle
    if (![cx, cy, r].every((v) => Number.isFinite(Number(v))) || !(Number(r) > 0)) return null
    return circleRing({ cx: Number(cx), cy: Number(cy), r: Number(r), ...(ring.circle.rUnit ? { rUnit: ring.circle.rUnit } : {}) }, page, tolerancePoints)
  }
  if (!Array.isArray(ring)) return null
  const vs = ring.map((p) => ({
    x: Number((p as Vertex)?.x), y: Number((p as Vertex)?.y),
    bulge: (p as Vertex)?.bulge === undefined ? 0 : Number((p as Vertex).bulge),
  }))
  const out: Array<{ x: number; y: number }> = []
  for (let i = 0; i < vs.length; i++) {
    const v = vs[i]!
    out.push({ x: v.x, y: v.y })
    const next = i + 1 < vs.length ? vs[i + 1] : closed ? vs[0] : undefined
    if (next !== undefined && v.bulge !== 0) out.push(...arcPoints(v, next, v.bulge, page, tolerancePoints))
  }
  return out
}
