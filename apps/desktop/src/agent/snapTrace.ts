/*
 * Put a traced outline back on the drawing's own lines.
 *
 * The tracer floods a raster and walks its edge, so a corner lands within a
 * cell or two of the ink, not on it. That is invisible on a room and a large
 * error on a small field: a 2 ft ceiling cell traced as 5.19 sq ft. Each
 * vertex is moved to where the two nearest lines through it cross, or onto
 * the one line it sits beside, when one is within reach.
 */
export interface Pt { x: number; y: number }

interface Seg { ax: number; ay: number; bx: number; by: number; dx: number; dy: number; len: number }

/** Distance from p to the segment (not the infinite line), and the foot. */
function reach(s: Seg, px: number, py: number): { d: number; fx: number; fy: number } {
  const t = Math.max(0, Math.min(1, ((px - s.ax) * s.dx + (py - s.ay) * s.dy) / (s.len * s.len)))
  const fx = s.ax + t * s.dx, fy = s.ay + t * s.dy
  return { d: Math.hypot(px - fx, py - fy), fx, fy }
}

/**
 * Snap rings (normalized) to linework (flat x1,y1,x2,y2, normalized).
 * `tolerancePoints` is how far a vertex may move, in PDF points.
 */
export function snapToLinework(
  rings: ReadonlyArray<ReadonlyArray<Pt>>,
  flat: ArrayLike<number>,
  page: { width: number; height: number },
  tolerancePoints = 5,
): { rings: Pt[][]; moved: number } {
  const segs: Seg[] = []
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const ax = flat[i]! * page.width, ay = flat[i + 1]! * page.height
    const bx = flat[i + 2]! * page.width, by = flat[i + 3]! * page.height
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy)
    if (len >= 1) segs.push({ ax, ay, bx, by, dx, dy, len })
  }
  let moved = 0
  const out = rings.map((ring) => {
    const snapped = ring.map((p) => {
      const px = p.x * page.width, py = p.y * page.height
      const near: Array<{ s: Seg; d: number; fx: number; fy: number }> = []
      for (const s of segs) {
        const r = reach(s, px, py)
        if (r.d <= tolerancePoints) near.push({ s, ...r })
      }
      if (near.length === 0) return { x: p.x, y: p.y }
      near.sort((a, b) => a.d - b.d)
      const first = near[0]!
      // The nearest line that crosses the first one: a corner is where they meet.
      for (const other of near.slice(1)) {
        const cross = first.s.dx * other.s.dy - first.s.dy * other.s.dx
        if (Math.abs(cross) < 0.2 * first.s.len * other.s.len) continue
        const t = ((other.s.ax - first.s.ax) * other.s.dy - (other.s.ay - first.s.ay) * other.s.dx) / cross
        const ix = first.s.ax + t * first.s.dx, iy = first.s.ay + t * first.s.dy
        if (Math.hypot(ix - px, iy - py) <= tolerancePoints * 1.5) {
          moved++
          return { x: ix / page.width, y: iy / page.height }
        }
      }
      moved++
      return { x: first.fx / page.width, y: first.fy / page.height }
    })
    // Vertices that landed on the same corner are one vertex.
    const dedup: Pt[] = []
    for (const p of snapped) {
      const last = dedup[dedup.length - 1]
      if (last !== undefined && Math.hypot((last.x - p.x) * page.width, (last.y - p.y) * page.height) < 0.05) continue
      dedup.push(p)
    }
    if (dedup.length > 1) {
      const a = dedup[0]!, z = dedup[dedup.length - 1]!
      if (Math.hypot((a.x - z.x) * page.width, (a.y - z.y) * page.height) < 0.05) dedup.pop()
    }
    // Middle vertices left on a straight edge add nothing.
    const clean = dedup.filter((p, i) => {
      if (dedup.length <= 3) return true
      const a = dedup[(i - 1 + dedup.length) % dedup.length]!, b = dedup[(i + 1) % dedup.length]!
      const ux = (p.x - a.x) * page.width, uy = (p.y - a.y) * page.height
      const vx = (b.x - p.x) * page.width, vy = (b.y - p.y) * page.height
      return Math.abs(ux * vy - uy * vx) > 0.02 * Math.hypot(ux, uy) * Math.hypot(vx, vy)
    })
    return clean.length >= 3 ? clean : dedup
  })
  return { rings: out, moved }
}

/** Area of rings in square points: the first ring less the rest. */
export function ringsAreaPoints(rings: ReadonlyArray<ReadonlyArray<Pt>>, page: { width: number; height: number }): number {
  const one = (r: ReadonlyArray<Pt>) => {
    let twice = 0
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!, b = r[(i + 1) % r.length]!
      twice += a.x * page.width * b.y * page.height - b.x * page.width * a.y * page.height
    }
    return Math.abs(twice) / 2
  }
  return rings.reduce((sum, r, i) => (i === 0 ? one(r) : sum - one(r)), 0)
}
