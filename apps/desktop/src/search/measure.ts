/**
 * Measuring for an agent without drawing anything (Aaron, 2026-11-24: "I got
 * the sizes by counting pixels in screenshots. I need a way to measure a
 * distance or area between points, or to read the drawing's own line
 * geometry, without writing a markup").
 *
 * Points are normalized [0,1] page coordinates, y down, the same space
 * find_text, get_words and screenshot regions use. The scale is resolved the
 * way a markup's is: the smallest scale region containing the points'
 * centroid, then the page scale, then none. Without a scale the answer is in
 * PDF points and says so; it never guesses feet.
 *
 * Pure, so it is tested without a window.
 */
import { formatFeetInches, resolveScaleForRings, type ScaleRegion } from '@redbeam/domain'

export interface Measurement {
  /** Length along the points, closing back to the first when `closed`. */
  lengthPoints: number
  lengthFeet: number | null
  length: string | null
  /** Each leg, in order. */
  segmentsFeet: Array<number | null>
  /** Enclosed area for a closed shape of 3+ points. */
  areaSquarePoints?: number
  areaSquareFeet?: number | null
  feetPerPoint: number | null
  /** Which scale measured it: a region's id, the page, or none. */
  scaleSource: 'region' | 'page' | 'none'
  scaleRegionId?: string
  warning?: string
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

export function measurePoints(
  points: ReadonlyArray<{ x: number; y: number }>,
  page: { width: number; height: number },
  opts: { closed?: boolean; regions?: readonly ScaleRegion[]; pageFeetPerPoint?: number | null } = {},
): Measurement {
  const pts = points.map((p) => ({ x: p.x * page.width, y: p.y * page.height }))
  const legs: number[] = []
  for (let i = 1; i < pts.length; i++) legs.push(Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y))
  const closed = opts.closed === true && pts.length >= 3
  if (closed) legs.push(Math.hypot(pts[0]!.x - pts.at(-1)!.x, pts[0]!.y - pts.at(-1)!.y))
  const lengthPoints = legs.reduce((a, b) => a + b, 0)

  const resolved = resolveScaleForRings([points.map((p) => ({ x: p.x, y: p.y }))], opts.regions ?? [], opts.pageFeetPerPoint ?? null)
  const fpp = resolved.feetPerPoint
  const out: Measurement = {
    lengthPoints: r3(lengthPoints),
    lengthFeet: fpp === null ? null : r3(lengthPoints * fpp),
    length: fpp === null ? null : formatFeetInches(lengthPoints * fpp),
    segmentsFeet: legs.map((l) => (fpp === null ? null : r3(l * fpp))),
    feetPerPoint: fpp,
    scaleSource: resolved.regionId !== null ? 'region' : fpp !== null ? 'page' : 'none',
    ...(resolved.regionId !== null ? { scaleRegionId: resolved.regionId } : {}),
    ...(resolved.warning !== null ? { warning: resolved.warning } : {}),
  }
  if (closed) {
    let twice = 0
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!, b = pts[(i + 1) % pts.length]!
      twice += a.x * b.y - b.x * a.y
    }
    const area = Math.abs(twice) / 2
    out.areaSquarePoints = r3(area)
    out.areaSquareFeet = fpp === null ? null : r3(area * fpp * fpp)
  }
  if (fpp === null) out.warning = 'this sheet has no scale here, so only PDF points are given'
  return out
}

export interface Line {
  x1: number; y1: number; x2: number; y2: number
  lengthPoints: number
  lengthFeet: number | null
  /** Degrees from the page's horizontal, 0 to 180, y down. */
  angle: number
  /** The drawn line goes on past the box; these are the ends at the box's edge. */
  cut?: true
}

export interface LineFilter {
  feetPerPoint?: number | null
  minLengthPoints?: number
  maxLengthPoints?: number
  /** Only segments with both ends inside this box (normalized). */
  inside?: { x0: number; y0: number; x1: number; y1: number }
  /**
   * Cut every segment to this box (normalized) and leave out the ones that
   * do not reach into it. A long wall crossing the box comes back as the
   * part inside it, so no end lies outside the box asked about.
   */
  clipTo?: { x0: number; y0: number; x1: number; y1: number }
  /** Only lines at this angle (degrees, 0..180, y down), within `angleTolerance`. */
  angle?: number
  /** horizontal, vertical, or any. Within `angleTolerance` degrees. */
  orientation?: 'horizontal' | 'vertical' | 'any'
  angleTolerance?: number
  /** Merge a segment drawn twice, in either direction, within `dedupeTolerancePoints`. Default true. */
  dedupe?: boolean
  dedupeTolerancePoints?: number
  /** length (longest first), x (left to right), y (top to bottom). */
  sort?: 'length' | 'x' | 'y'
  limit?: number
}

/**
 * The drawing's own line segments from the flat [x1,y1,x2,y2,...] array the
 * geometry reader returns (normalized), filtered and sorted for an agent.
 * Each line is reported with its ends in reading order (left end first, or
 * top end first for a vertical), so a segment drawn twice in opposite
 * directions reads, and dedupes, as one.
 */
export function linesFromSegments(
  flat: ArrayLike<number>,
  page: { width: number; height: number },
  opts: LineFilter = {},
): { lines: Line[]; total: number; duplicatesRemoved: number } {
  const r5 = (n: number) => Math.round(n * 1e5) / 1e5
  const fpp = opts.feetPerPoint ?? null
  const min = opts.minLengthPoints ?? 0
  const max = opts.maxLengthPoints ?? Infinity
  const tol = opts.angleTolerance ?? 1
  const box = opts.inside === undefined ? null : {
    x0: Math.min(opts.inside.x0, opts.inside.x1), x1: Math.max(opts.inside.x0, opts.inside.x1),
    y0: Math.min(opts.inside.y0, opts.inside.y1), y1: Math.max(opts.inside.y0, opts.inside.y1),
  }
  const inBox = (x: number, y: number) => box === null || (x >= box.x0 - 1e-9 && x <= box.x1 + 1e-9 && y >= box.y0 - 1e-9 && y <= box.y1 + 1e-9)
  const cb = opts.clipTo === undefined ? null : {
    x0: Math.min(opts.clipTo.x0, opts.clipTo.x1), x1: Math.max(opts.clipTo.x0, opts.clipTo.x1),
    y0: Math.min(opts.clipTo.y0, opts.clipTo.y1), y1: Math.max(opts.clipTo.y0, opts.clipTo.y1),
  }
  const all: Line[] = []
  for (let i = 0; i + 3 < flat.length; i += 4) {
    let x1 = flat[i]!, y1 = flat[i + 1]!, x2 = flat[i + 2]!, y2 = flat[i + 3]!
    let cut = false
    if (cb !== null) {
      // Liang-Barsky: the part of the segment inside the box, or nothing.
      const ex = x2 - x1, ey = y2 - y1
      let t0 = 0, t1 = 1
      const edge = (p: number, q: number): boolean => {
        if (p === 0) return q >= -1e-12
        const t = q / p
        if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t } else { if (t < t0) return false; if (t < t1) t1 = t }
        return true
      }
      if (!(edge(-ex, x1 - cb.x0) && edge(ex, cb.x1 - x1) && edge(-ey, y1 - cb.y0) && edge(ey, cb.y1 - y1))) continue
      if (t0 > 1e-9 || t1 < 1 - 1e-9) {
        cut = true
        const ax = x1 + t0 * ex, ay = y1 + t0 * ey
        x2 = x1 + t1 * ex; y2 = y1 + t1 * ey
        x1 = ax; y1 = ay
      }
    }
    const dx = (x2 - x1) * page.width, dy = (y2 - y1) * page.height
    const len = Math.hypot(dx, dy)
    if (len < min || len > max) continue
    if (!inBox(x1, y1) || !inBox(x2, y2)) continue
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI
    if (angle < 0) angle += 180
    if (angle >= 180) angle -= 180
    if (opts.orientation === 'horizontal' && !(angle <= tol || angle >= 180 - tol)) continue
    if (opts.orientation === 'vertical' && Math.abs(angle - 90) > tol) continue
    if (opts.angle !== undefined) {
      const d = Math.abs((((angle - opts.angle) % 180) + 180) % 180)
      if (Math.min(d, 180 - d) > tol) continue
    }
    // Reading order: left end first; for a near-vertical line, top end first.
    const vertical = Math.abs(angle - 90) <= 45
    if (vertical ? y2 < y1 : x2 < x1) { [x1, x2] = [x2, x1]; [y1, y2] = [y2, y1] }
    all.push({ x1, y1, x2, y2, lengthPoints: len, lengthFeet: null, angle, ...(cut ? { cut: true as const } : {}) })
  }
  let duplicatesRemoved = 0
  let kept = all
  if (opts.dedupe !== false) {
    const tolPts = opts.dedupeTolerancePoints ?? 0.5
    const cellX = Math.max(tolPts, 0.01) / page.width, cellY = Math.max(tolPts, 0.01) / page.height
    const seen = new Map<string, Line[]>()
    kept = []
    for (const l of all) {
      const key = `${Math.round(l.x1 / cellX)},${Math.round(l.y1 / cellY)}`
      const near = (a: Line) => Math.abs(a.x1 - l.x1) * page.width <= tolPts && Math.abs(a.y1 - l.y1) * page.height <= tolPts
        && Math.abs(a.x2 - l.x2) * page.width <= tolPts && Math.abs(a.y2 - l.y2) * page.height <= tolPts
      let dup = false
      const kx = Math.round(l.x1 / cellX), ky = Math.round(l.y1 / cellY)
      for (let ox = -1; ox <= 1 && !dup; ox++) {
        for (let oy = -1; oy <= 1 && !dup; oy++) {
          const bucket = seen.get(`${kx + ox},${ky + oy}`)
          if (bucket?.some(near)) dup = true
        }
      }
      if (dup) { duplicatesRemoved++; continue }
      const b = seen.get(key)
      if (b) b.push(l); else seen.set(key, [l])
      kept.push(l)
    }
  }
  const sort = opts.sort ?? 'length'
  if (sort === 'length') kept.sort((a, b) => b.lengthPoints - a.lengthPoints)
  else if (sort === 'x') kept.sort((a, b) => (a.x1 + a.x2) - (b.x1 + b.x2) || (a.y1 + a.y2) - (b.y1 + b.y2))
  else kept.sort((a, b) => (a.y1 + a.y2) - (b.y1 + b.y2) || (a.x1 + a.x2) - (b.x1 + b.x2))
  const lines = kept.slice(0, opts.limit ?? 500).map((l) => ({
    x1: r5(l.x1), y1: r5(l.y1), x2: r5(l.x2), y2: r5(l.y2),
    lengthPoints: r3(l.lengthPoints),
    lengthFeet: fpp === null ? null : r3(l.lengthPoints * fpp),
    angle: Math.round(l.angle * 100) / 100,
    ...(l.cut === true ? { cut: true as const } : {}),
  }))
  return { lines, total: kept.length, duplicatesRemoved }
}

export interface DetectedPattern {
  /** horizontal or vertical members, or the angle in degrees for a skewed pattern. */
  direction: 'horizontal' | 'vertical' | number
  /** Two normalized points along a member: hand them to set_scope_direction. */
  directionLine: { x1: number; y1: number; x2: number; y2: number }
  /** Member lines found (after merging duplicates and collinear pieces). */
  members: number
  /** Distinct member lines across the pattern, i.e. how many members side by side. */
  runs: number
  /** Members end to end along one line, the most common count. */
  rows: number
  spacingPoints: number
  spacingFeet: number | null
  spacing: string | null
  /** Share of gaps within 5% of the spacing: 1 is a perfectly regular pattern. */
  regularity: number
  memberLengthPoints: number
  memberLengthFeet: number | null
  memberLength: string | null
  /** The box the members fill, normalized. */
  extent: { x0: number; y0: number; x1: number; y1: number }
  feetPerPoint: number | null
  note?: string
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/**
 * A drawn pattern of parallel members (baffles, planks, slats) read off the
 * drawing's own lines in a box: which way the members run, how far apart they
 * are on centre, how long they are, and how many there are across and along.
 *
 * Members are the dominant direction among the longer lines. Their offsets
 * across that direction are clustered (a member's two faces, drawn as two
 * close lines, count as one member at their mid-line once the gap between
 * them is under half the spacing), and the spacing is the median gap.
 */
export function detectPattern(
  flat: ArrayLike<number>,
  page: { width: number; height: number },
  opts: { feetPerPoint?: number | null; inside?: { x0: number; y0: number; x1: number; y1: number }; minLengthPoints?: number } = {},
): DetectedPattern | { error: string } {
  const fpp = opts.feetPerPoint ?? null
  const { lines } = linesFromSegments(flat, page, {
    ...(opts.inside !== undefined ? { inside: opts.inside } : {}),
    minLengthPoints: opts.minLengthPoints ?? 4, dedupe: true, limit: 200_000,
  })
  if (lines.length < 3) return { error: 'too few lines in the box to read a pattern; make the box cover several members' }
  // Dominant angle, weighted by length, in 1-degree bins.
  const bins = new Array<number>(180).fill(0)
  for (const l of lines) bins[Math.round(l.angle) % 180]! += l.lengthPoints
  let best = 0
  for (let i = 1; i < 180; i++) if (bins[i]! > bins[best]!) best = i
  const near = (a: number) => Math.min(Math.abs(a - best), 180 - Math.abs(a - best)) <= 2
  const members = lines.filter((l) => near(l.angle))
  if (members.length < 2) return { error: 'no repeated parallel lines in the box' }
  const rad = (best * Math.PI) / 180
  const ux = Math.cos(rad), uy = Math.sin(rad)
  // Work in page points: along = projection on u, across = on the normal.
  const P = members.map((l) => {
    const ax = l.x1 * page.width, ay = l.y1 * page.height, bx = l.x2 * page.width, by = l.y2 * page.height
    const s0 = ax * ux + ay * uy, s1 = bx * ux + by * uy
    return { across: (-ax * uy + ay * ux + -bx * uy + by * ux) / 2, from: Math.min(s0, s1), to: Math.max(s0, s1) }
  }).sort((a, b) => a.across - b.across)
  // Cluster offsets that coincide (collinear pieces of one line) within 0.75 pt.
  const lineGroups: Array<{ across: number; spans: Array<[number, number]> }> = []
  for (const p of P) {
    const g = lineGroups.at(-1)
    if (g && p.across - g.across <= 0.75) g.spans.push([p.from, p.to])
    else lineGroups.push({ across: p.across, spans: [[p.from, p.to]] })
  }
  if (lineGroups.length < 2) return { error: 'the parallel lines in the box all sit on one line' }
  let gaps = lineGroups.slice(1).map((g, i) => g.across - lineGroups[i]!.across)
  // Two faces per member: alternating small and large gaps. Pair them up.
  const sortedGaps = [...gaps].sort((a, b) => a - b)
  const small = sortedGaps[Math.floor(sortedGaps.length * 0.25)]!, large = sortedGaps[Math.floor(sortedGaps.length * 0.75)]!
  let centres = lineGroups.map((g) => g.across)
  let groupsForLength = lineGroups
  let note: string | undefined
  if (lineGroups.length >= 4 && large > small * 2.5) {
    const merged: Array<{ across: number; spans: Array<[number, number]> }> = []
    for (let i = 0; i < lineGroups.length; i++) {
      const a = lineGroups[i]!, b = lineGroups[i + 1]
      if (b && b.across - a.across < (small + large) / 2) {
        merged.push({ across: (a.across + b.across) / 2, spans: [...a.spans, ...b.spans] })
        i++
      } else merged.push(a)
    }
    centres = merged.map((g) => g.across)
    groupsForLength = merged
    note = `members are drawn with two faces ${r3(small)} pt apart; spacing is measured centre to centre`
    gaps = centres.slice(1).map((c, i) => c - centres[i]!)
  }
  const spacing = median(gaps)
  const regular = gaps.filter((g) => Math.abs(g - spacing) <= spacing * 0.05).length / Math.max(1, gaps.length)
  // Member lengths: merge overlapping spans along each line, count pieces.
  const pieceLengths: number[] = []
  const piecesPerLine: number[] = []
  for (const g of groupsForLength) {
    const spans = [...g.spans].sort((a, b) => a[0] - b[0])
    const merged: Array<[number, number]> = []
    for (const s of spans) {
      const last = merged.at(-1)
      if (last && s[0] <= last[1] + 0.75) last[1] = Math.max(last[1], s[1])
      else merged.push([s[0], s[1]])
    }
    piecesPerLine.push(merged.length)
    for (const m of merged) pieceLengths.push(m[1] - m[0])
  }
  const memberLength = median(pieceLengths)
  const counts = new Map<number, number>()
  for (const n of piecesPerLine) counts.set(n, (counts.get(n) ?? 0) + 1)
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0]
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0
  for (const l of members) {
    x0 = Math.min(x0, l.x1, l.x2); x1 = Math.max(x1, l.x1, l.x2)
    y0 = Math.min(y0, l.y1, l.y2); y1 = Math.max(y1, l.y1, l.y2)
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  const L = 0.05 * Math.min(page.width, page.height)
  const r5n = (n: number) => Math.round(n * 1e5) / 1e5
  const dirLine = {
    x1: r5n(cx - (ux * L) / page.width), y1: r5n(cy - (uy * L) / page.height),
    x2: r5n(cx + (ux * L) / page.width), y2: r5n(cy + (uy * L) / page.height),
  }
  const direction: DetectedPattern['direction'] = best <= 1 || best >= 179 ? 'horizontal' : Math.abs(best - 90) <= 1 ? 'vertical' : best
  return {
    direction,
    directionLine: dirLine,
    members: centres.length * rows,
    runs: centres.length,
    rows,
    spacingPoints: r3(spacing),
    spacingFeet: fpp === null ? null : r3(spacing * fpp),
    spacing: fpp === null ? null : formatFeetInches(spacing * fpp),
    regularity: Math.round(regular * 100) / 100,
    memberLengthPoints: r3(memberLength),
    memberLengthFeet: fpp === null ? null : r3(memberLength * fpp),
    memberLength: fpp === null ? null : formatFeetInches(memberLength * fpp),
    extent: { x0: Math.round(x0 * 1e5) / 1e5, y0: Math.round(y0 * 1e5) / 1e5, x1: Math.round(x1 * 1e5) / 1e5, y1: Math.round(y1 * 1e5) / 1e5 },
    feetPerPoint: fpp,
    ...(note !== undefined ? { note } : {}),
  }
}
