/**
 * Reading a drawn grid off the sheet (NOIC takeoff report, 2026-11-26):
 * "Start this area on the nearest drawn grid crossing would replace the image
 * analysis I did for 40 FORM areas", and "something like detect_grid that
 * returns module, rows, columns and start point from double lines".
 *
 * The drawing's own vector lines are grouped into two families at right
 * angles. Inside each family, lines on the same offset are one grid line,
 * however many pieces it was drawn in (a tile grid is often drawn one tile
 * edge at a time). A grid line is kept only when its pieces cover a good part
 * of the area, so a light fixture or a tag leader does not become one. Two
 * lines much closer together than the module are a double line (a T-bar, a
 * reveal) and read as one, at their centre.
 *
 * Works in PDF points so the module comes out in real units. Pure, so it is
 * tested without a window.
 */

export interface GridPoint { x: number; y: number }

export interface DetectedGrid {
  /** Degrees 0..90, y down, of the first family (the second is +90). */
  angle: number
  /** The grid lines of each family, as offsets in points along its normal, ascending. */
  linesA: number[]
  linesB: number[]
  /** The spacing that repeats most in each family, in points. Null with fewer than two lines. */
  moduleA: number | null
  moduleB: number | null
  /** True when the lines were drawn double and were read at their centres. */
  doubleLines: boolean
  /** Width between the two lines of a double line, in points, when there were any. */
  bandWidth: number | null
  /** Crossings inside the area (or the box), normalized, y down. */
  crossings: GridPoint[]
}

export interface GridOptions {
  /** Only this family angle (degrees, y down, either family). Otherwise the strongest angle in the lines. */
  angle?: number
  /** Degrees either side of the family angle. Default 1.5. */
  angleTolerance?: number
  /**
   * The area, normalized rings (first is the outline, the rest holes). Lines
   * are measured against it and crossings must fall in it. Without it the
   * box the segments were read from (`box`) is used.
   */
  rings?: ReadonlyArray<ReadonlyArray<GridPoint>>
  box?: { x0: number; y0: number; x1: number; y1: number }
  /** Share of the area's extent a grid line's pieces must cover. Default 0.25. */
  minCoverage?: number
}

const DEG = Math.PI / 180

function inRing(p: GridPoint, ring: ReadonlyArray<GridPoint>): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function distToRing(p: GridPoint, ring: ReadonlyArray<GridPoint>): number {
  let best = Infinity
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!
    const ex = b.x - a.x, ey = b.y - a.y
    const l2 = ex * ex + ey * ey
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / l2))
    best = Math.min(best, Math.hypot(p.x - (a.x + t * ex), p.y - (a.y + t * ey)))
  }
  return best
}

/** Inside the outline and out of every hole, or within `tol` points of an edge. Points in PDF points. */
function inArea(p: GridPoint, rings: ReadonlyArray<ReadonlyArray<GridPoint>>, tol: number): boolean {
  if (rings.length === 0) return true
  const outer = rings[0]!
  const nearEdge = rings.some((r) => distToRing(p, r) <= tol)
  if (nearEdge) return true
  if (!inRing(p, outer)) return false
  return !rings.slice(1).some((h) => inRing(p, h))
}

/** Union length of [a,b] intervals. */
function unionLength(iv: Array<[number, number]>): number {
  if (iv.length === 0) return 0
  iv.sort((p, q) => p[0] - q[0])
  let total = 0
  let [s, e] = iv[0]!
  for (const [a, b] of iv.slice(1)) {
    if (a > e) { total += e - s; s = a; e = b } else if (b > e) e = b
  }
  return total + (e - s)
}

function covers(iv: ReadonlyArray<[number, number]>, t: number, tol: number): boolean {
  return iv.some(([a, b]) => t >= a - tol && t <= b + tol)
}

/** The spacing that repeats most, within 2%, as the mean of that cluster. */
export function commonSpacing(gaps: readonly number[]): number | null {
  if (gaps.length === 0) return null
  const sorted = [...gaps].sort((a, b) => a - b)
  let best: number[] = []
  for (let i = 0; i < sorted.length; i++) {
    const g = sorted[i]!
    const run = sorted.filter((x) => Math.abs(x - g) <= Math.max(0.5, g * 0.02))
    // A tie goes to the smaller spacing: a line left out makes a gap of two modules, never half of one.
    if (run.length > best.length) best = run
  }
  return best.reduce((s, x) => s + x, 0) / best.length
}

/** The strongest line angle mod 90, weighted by length, in degrees y down. */
export function dominantAngle(segs: ReadonlyArray<[GridPoint, GridPoint]>): number | null {
  const bins = new Float64Array(180) // 0.5 degree bins over 0..90
  for (const [a, b] of segs) {
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len === 0) continue
    let ang = Math.atan2(b.y - a.y, b.x - a.x) / DEG
    ang = ((ang % 90) + 90) % 90
    bins[Math.min(179, Math.floor(ang * 2))]! += len
  }
  let peak = -1, w = 0
  for (let i = 0; i < 180; i++) {
    // Neighbours count too, wrapping round 0/90, so a peak split over two bins still wins.
    const s = bins[i]! + 0.5 * (bins[(i + 179) % 180]! + bins[(i + 1) % 180]!)
    if (s > w) { w = s; peak = i }
  }
  if (peak < 0) return null
  // Length-weighted mean of the lines near the peak, unwrapped around it.
  const centre = peak / 2 + 0.25
  let sw = 0, sa = 0
  for (const [a, b] of segs) {
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len === 0) continue
    let ang = (((Math.atan2(b.y - a.y, b.x - a.x) / DEG) % 90) + 90) % 90
    let d = ang - centre
    if (d > 45) { ang -= 90; d -= 90 } else if (d < -45) { ang += 90; d += 90 }
    if (Math.abs(d) <= 1) { sw += len; sa += ang * len }
  }
  const out = sw > 0 ? sa / sw : centre
  return ((out % 90) + 90) % 90
}

/**
 * The grid drawn in `flat` (x1,y1,x2,y2 normalized, as requestGeometry gives
 * them) on a page of `page` points. Null when there are not two families of
 * lines to make a grid of.
 */
export function detectGrid(
  flat: ArrayLike<number>,
  page: { width: number; height: number },
  opts: GridOptions = {},
): DetectedGrid | null {
  const W = page.width, H = page.height
  const toPt = (p: GridPoint): GridPoint => ({ x: p.x * W, y: p.y * H })
  const rings = (opts.rings ?? []).map((r) => r.map(toPt))
  const box = opts.box
  const boxRing = box === undefined ? null : [
    { x: Math.min(box.x0, box.x1) * W, y: Math.min(box.y0, box.y1) * H },
    { x: Math.max(box.x0, box.x1) * W, y: Math.min(box.y0, box.y1) * H },
    { x: Math.max(box.x0, box.x1) * W, y: Math.max(box.y0, box.y1) * H },
    { x: Math.min(box.x0, box.x1) * W, y: Math.max(box.y0, box.y1) * H },
  ]
  const area = rings.length > 0 ? rings : boxRing !== null ? [boxRing] : []
  const EDGE = 1.5

  /*
   * Lines come whole, as drawn: a grid line across three rooms reaches far
   * past this one. Each is cut to the area's bounding box first, so its
   * middle is the middle of the part that is here.
   */
  const outer = area[0]
  const bb = outer === undefined ? null : outer.reduce((r, p) => ({
    x0: Math.min(r.x0, p.x), y0: Math.min(r.y0, p.y), x1: Math.max(r.x1, p.x), y1: Math.max(r.y1, p.y),
  }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
  const clipTo = (a: GridPoint, b: GridPoint): [GridPoint, GridPoint] | null => {
    if (bb === null) return [a, b]
    const ex = b.x - a.x, ey = b.y - a.y
    let t0 = 0, t1 = 1
    const edge = (q: number, r: number): boolean => {
      if (q === 0) return r >= -EDGE
      const t = r / q
      if (q < 0) { if (t > t1) return false; if (t > t0) t0 = t } else { if (t < t0) return false; if (t < t1) t1 = t }
      return true
    }
    if (!(edge(-ex, a.x - (bb.x0 - EDGE)) && edge(ex, bb.x1 + EDGE - a.x) && edge(-ey, a.y - (bb.y0 - EDGE)) && edge(ey, bb.y1 + EDGE - a.y))) return null
    return [{ x: a.x + t0 * ex, y: a.y + t0 * ey }, { x: a.x + t1 * ex, y: a.y + t1 * ey }]
  }

  const segs: Array<[GridPoint, GridPoint]> = []
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const cut = clipTo({ x: flat[i]! * W, y: flat[i + 1]! * H }, { x: flat[i + 2]! * W, y: flat[i + 3]! * H })
    if (cut === null) continue
    const [a, b] = cut
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1) continue
    // A piece of the grid has its middle in the area (or on its edge).
    if (!inArea({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, area, EDGE)) continue
    segs.push([a, b])
  }
  if (segs.length < 4) return null

  const angle = opts.angle !== undefined ? (((opts.angle % 90) + 90) % 90) : dominantAngle(segs)
  if (angle === null) return null
  const tol = opts.angleTolerance ?? 1.5
  const minCoverage = opts.minCoverage ?? 0.25

  /*
   * How far the area reaches along a direction, for coverage: the outline's
   * reach, or the drawn lines' when they reach less (a grid in one corner of
   * a box read around it).
   */
  const ends = segs.flatMap(([a, b]) => [a, b])
  const reach = (pts: readonly GridPoint[], u: GridPoint): number => {
    let lo = Infinity, hi = -Infinity
    for (const p of pts) { const t = p.x * u.x + p.y * u.y; if (t < lo) lo = t; if (t > hi) hi = t }
    return hi - lo
  }
  const extent = (u: GridPoint): number => Math.min(reach(ends, u), area[0] === undefined ? Infinity : reach(area[0], u))

  const family = (deg: number): { lines: number[]; spans: Array<Array<[number, number]>>; u: GridPoint; n: GridPoint } => {
    const u = { x: Math.cos(deg * DEG), y: Math.sin(deg * DEG) }
    const n = { x: -u.y, y: u.x }
    const items: Array<{ off: number; iv: [number, number] }> = []
    for (const [a, b] of segs) {
      let ang = Math.atan2(b.y - a.y, b.x - a.x) / DEG - deg
      ang = ((ang % 180) + 180) % 180
      if (Math.min(ang, 180 - ang) > tol) continue
      const off = ((a.x + b.x) / 2) * n.x + ((a.y + b.y) / 2) * n.y
      const ta = a.x * u.x + a.y * u.y, tb = b.x * u.x + b.y * u.y
      items.push({ off, iv: [Math.min(ta, tb), Math.max(ta, tb)] })
    }
    items.sort((p, q) => p.off - q.off)
    // Pieces on one offset (within 0.75 pt) are one line.
    const clusters: Array<{ off: number; w: number; iv: Array<[number, number]> }> = []
    for (const it of items) {
      const last = clusters[clusters.length - 1]
      const len = it.iv[1] - it.iv[0]
      if (last !== undefined && it.off - last.off / last.w <= 0.75) {
        last.off += it.off * len; last.w += len; last.iv.push(it.iv)
      } else clusters.push({ off: it.off * len, w: len, iv: [it.iv] })
    }
    const need = minCoverage * extent(u)
    const kept = clusters
      .map((c) => ({ off: c.off / c.w, iv: c.iv, cover: unionLength(c.iv.map((x) => [x[0], x[1]] as [number, number])) }))
      .filter((c) => c.cover >= need)
    return { lines: kept.map((c) => c.off), spans: kept.map((c) => c.iv), u, n }
  }

  let A = family(angle)
  let B = family(angle + 90)
  if (A.lines.length < 2 && B.lines.length < 2) return null

  /*
   * Double lines: gaps much smaller than the module come in pairs. Read each
   * pair as one line at its centre, and say how wide the band was.
   */
  let doubleLines = false
  const bands: number[] = []
  const undouble = (f: typeof A): typeof A => {
    const gaps = f.lines.slice(1).map((x, i) => x - f.lines[i]!)
    const big = gaps.filter((g) => g > 0)
    if (big.length < 2) return f
    const sortedGaps = [...big].sort((a, b) => a - b)
    const largest = sortedGaps[sortedGaps.length - 1]!
    const small = (g: number) => g < 0.3 * commonSpacing(big.filter((x) => x >= 0.3 * largest))!
    if (!gaps.some(small)) return f
    const lines: number[] = [], spans: Array<Array<[number, number]>> = []
    const mine: number[] = []
    for (let i = 0; i < f.lines.length; i++) {
      if (i + 1 < f.lines.length && small(gaps[i]!)) {
        lines.push((f.lines[i]! + f.lines[i + 1]!) / 2)
        spans.push([...f.spans[i]!, ...f.spans[i + 1]!])
        mine.push(gaps[i]!)
        i++
      } else { lines.push(f.lines[i]!); spans.push(f.spans[i]!) }
    }
    /*
     * A wall or a bulkhead at the edge is drawn double too. Only when most
     * of the grid is double is the grid called double (NOIC IC3.004A: single
     * 2'-0" grids with walls round them read as double before this).
     */
    if (mine.length * 2 >= lines.length) { doubleLines = true; bands.push(...mine) }
    return { ...f, lines, spans }
  }
  A = undouble(A)
  B = undouble(B)

  const gapsOf = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!)
  const crossings: GridPoint[] = []
  const SPAN_TOL = 2
  for (let i = 0; i < A.lines.length; i++) {
    for (let j = 0; j < B.lines.length; j++) {
      const a = A.lines[i]!, b = B.lines[j]!
      // n_A and n_B are orthonormal; a point at offset a along n_A and b along n_B.
      const p = { x: a * A.n.x + b * B.n.x, y: a * A.n.y + b * B.n.y }
      // Both lines must actually reach the crossing.
      if (!covers(A.spans[i]!, p.x * A.u.x + p.y * A.u.y, SPAN_TOL)) continue
      if (!covers(B.spans[j]!, p.x * B.u.x + p.y * B.u.y, SPAN_TOL)) continue
      if (!inArea(p, area, EDGE)) continue
      crossings.push({ x: p.x / W, y: p.y / H })
    }
  }

  const r = (n: number) => Math.round(n * 1000) / 1000
  return {
    angle: r(angle),
    linesA: A.lines.map(r),
    linesB: B.lines.map(r),
    moduleA: commonSpacing(gapsOf(A.lines)),
    moduleB: commonSpacing(gapsOf(B.lines)),
    doubleLines,
    bandWidth: bands.length > 0 ? r(bands.reduce((s, x) => s + x, 0) / bands.length) : null,
    crossings,
  }
}

/** The crossing nearest `to` (normalized), measured in points. */
export function nearestCrossing(
  grid: DetectedGrid, to: GridPoint, page: { width: number; height: number },
): { point: GridPoint; distancePoints: number } | null {
  let best: GridPoint | null = null, d = Infinity
  for (const c of grid.crossings) {
    const dd = Math.hypot((c.x - to.x) * page.width, (c.y - to.y) * page.height)
    if (dd < d) { d = dd; best = c }
  }
  return best === null ? null : { point: best, distancePoints: d }
}
