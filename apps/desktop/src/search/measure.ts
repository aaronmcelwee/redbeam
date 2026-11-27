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
  /** Which scale measured it: a stated `scale`, a region's id, the page, or none. */
  scaleSource: 'stated' | 'region' | 'page' | 'none'
  scaleRegionId?: string
  /** The stated scale it was measured at, as given. */
  scale?: string
  warning?: string
}

const r3 = (n: number) => Math.round(n * 1000) / 1000

export function measurePoints(
  points: ReadonlyArray<{ x: number; y: number }>,
  page: { width: number; height: number },
  opts: {
    closed?: boolean; regions?: readonly ScaleRegion[]; pageFeetPerPoint?: number | null
    /** A detail's own stated scale (#179): measured at it, whatever the sheet or a region says. */
    stated?: { feetPerPoint: number; text: string }
  } = {},
): Measurement {
  const pts = points.map((p) => ({ x: p.x * page.width, y: p.y * page.height }))
  const legs: number[] = []
  for (let i = 1; i < pts.length; i++) legs.push(Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y))
  const closed = opts.closed === true && pts.length >= 3
  if (closed) legs.push(Math.hypot(pts[0]!.x - pts.at(-1)!.x, pts[0]!.y - pts.at(-1)!.y))
  const lengthPoints = legs.reduce((a, b) => a + b, 0)

  const resolved = opts.stated !== undefined
    ? { feetPerPoint: opts.stated.feetPerPoint, regionId: null, warning: null }
    : resolveScaleForRings([points.map((p) => ({ x: p.x, y: p.y }))], opts.regions ?? [], opts.pageFeetPerPoint ?? null)
  const fpp = resolved.feetPerPoint
  const out: Measurement = {
    lengthPoints: r3(lengthPoints),
    lengthFeet: fpp === null ? null : r3(lengthPoints * fpp),
    length: fpp === null ? null : formatFeetInches(lengthPoints * fpp),
    segmentsFeet: legs.map((l) => (fpp === null ? null : r3(l * fpp))),
    feetPerPoint: fpp,
    scaleSource: opts.stated !== undefined ? 'stated' : resolved.regionId !== null ? 'region' : fpp !== null ? 'page' : 'none',
    ...(opts.stated !== undefined ? { scale: opts.stated.text } : {}),
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
  /** Members told apart by how they are drawn (one line, or faces this far apart), most common first. */
  memberTypes: Array<{ type: string; drawnAs: 'faces' | 'one line'; faceWidthPoints?: number; faceWidthFeet?: number | null; faceWidth?: string | null; count: number; lengthPoints: number; length: string | null }>
  /** The member kinds in order across the field, by letter, when there is more than one. */
  sequence?: string
  /** A kind that recurs every Nth member, as a beam every 4th member with slabs between. */
  repeat?: { every: number; pattern: string; summary: string }
  /** Parallel lines left out because they do not repeat with the members (lights, sprinklers). */
  ignoredLines?: number
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
  /*
   * Members: one drawn line, or two or more close lines (a member's faces).
   *
   * The faces used to be paired only when the gaps split cleanly into small
   * and large quartiles, so a field that mixed members drawn differently (the
   * NOIC L7 breakroom: beams as double lines, slabs as single ones between)
   * came back as 110 members 2.1 pt apart, a face width read as a spacing.
   * Now the gaps are split at their widest natural break (a jump of 2x or
   * more between neighbouring sizes); every run of lines closer than that is
   * one member, and members are told apart by how they are drawn (face
   * width) and how long they are.
   */
  const allGaps = lineGroups.slice(1).map((g, i) => g.across - lineGroups[i]!.across)
  const sortedGaps = [...allGaps].sort((a, b) => a - b)
  let faceBelow = 0
  {
    let bestRatio = 1
    for (let i = 1; i < sortedGaps.length; i++) {
      const ratio = sortedGaps[i]! / Math.max(0.05, sortedGaps[i - 1]!)
      if (ratio > bestRatio) { bestRatio = ratio; faceBelow = Math.sqrt(Math.max(0.05, sortedGaps[i - 1]!) * sortedGaps[i]!) }
    }
    const faceGaps = allGaps.filter((g) => g < faceBelow).length
    // Faces need a clear break and at least two members drawn with them.
    if (!(bestRatio >= 2 && lineGroups.length >= 4 && faceGaps >= 2)) faceBelow = 0
  }
  /*
   * Lines that are not members. A baffle drawn as two faces with lights and
   * sprinkler lines between them read as 184 members 3 5/8" apart instead of
   * 56 baffles at 13 1/2" (2026-11-27): the extra lines broke the gaps up so
   * no clean face break was found. The members are the lines that repeat:
   * find the period the lines repeat at, fold every line onto one period, and
   * keep the one or two phases that carry most of the drawn length (one line,
   * or a member's two faces). Lines at other phases are left out and counted.
   * Three or more strong phases is a field of mixed members (beams and slabs)
   * and keeps the reading above.
   */
  let groupsIn = lineGroups
  let ignoredLines = 0
  {
    const periodic = periodicMembers(lineGroups)
    if (periodic !== null && periodic.ignored > 0) {
      groupsIn = periodic.kept
      ignoredLines = periodic.ignored
      faceBelow = periodic.faceBelow
    }
  }
  const memberGroups: Array<{ across: number; face: number; lines: number; spans: Array<[number, number]> }> = []
  for (let i = 0; i < groupsIn.length;) {
    let j = i
    while (j + 1 < groupsIn.length && groupsIn[j + 1]!.across - groupsIn[j]!.across < faceBelow) j++
    const run = groupsIn.slice(i, j + 1)
    memberGroups.push({
      across: (run[0]!.across + run.at(-1)!.across) / 2,
      face: run.at(-1)!.across - run[0]!.across,
      lines: run.length,
      spans: run.flatMap((g) => g.spans),
    })
    i = j + 1
  }
  const centres = memberGroups.map((g) => g.across)
  const groupsForLength = memberGroups
  let gaps = centres.slice(1).map((c, i) => c - centres[i]!)
  let note: string | undefined
  if (memberGroups.some((g) => g.lines > 1)) {
    note = 'members drawn with two faces count once, at their centre line; spacing is centre to centre'
  }
  if (ignoredLines > 0) {
    const left = `${ignoredLines} parallel line${ignoredLines === 1 ? '' : 's'} between the members left out (they do not repeat with the members: lights, sprinkler lines, other trades)`
    note = note === undefined ? left : `${note}; ${left}`
  }
  if (gaps.length === 0) gaps = allGaps
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
  /*
   * Kinds of member, told apart by how they are drawn: single line or faces,
   * and the face width (within 15%). Then which kind sits where across the
   * field, and whether that repeats ("beam every 4th member, slab between").
   */
  const kinds: Array<{ face: number; lines: number; count: number; lengths: number[] }> = []
  const kindOf: number[] = []
  groupsForLength.forEach((g, gi) => {
    let k = kinds.findIndex((t) => (t.lines > 1) === (g.lines > 1) && (g.lines === 1 || Math.abs(t.face - g.face) <= Math.max(0.3, 0.15 * t.face)))
    if (k < 0) { kinds.push({ face: g.face, lines: g.lines, count: 0, lengths: [] }); k = kinds.length - 1 }
    const kind = kinds[k]!
    kind.count++
    kind.lengths.push(...(() => {
      const sp = [...g.spans].sort((a, b) => a[0] - b[0])
      const out: number[] = []
      let cur: [number, number] | null = null
      for (const x of sp) {
        if (cur !== null && x[0] <= cur[1] + 0.75) cur[1] = Math.max(cur[1], x[1])
        else { if (cur !== null) out.push(cur[1] - cur[0]); cur = [x[0], x[1]] }
      }
      if (cur !== null) out.push(cur[1] - cur[0])
      return out
    })())
    kindOf[gi] = k
  })
  // Most common first, lettered A, B, C as the sequence names them.
  const order = kinds.map((_, i) => i).sort((a, b) => kinds[b]!.count - kinds[a]!.count)
  const letter = new Map(order.map((k, i) => [k, String.fromCharCode(65 + i)]))
  const sequence = kindOf.map((k) => letter.get(k)!).join('')
  let repeat: { every: number; pattern: string; summary: string } | undefined
  if (kinds.length > 1 && sequence.length >= 4) {
    for (let p = 2; p <= Math.min(16, Math.floor(sequence.length / 2)); p++) {
      let same = 0
      for (let i = 0; i + p < sequence.length; i++) if (sequence[i] === sequence[i + p]) same++
      if (same / (sequence.length - p) >= 0.9) {
        // Start the period on the rarer kind, the one that marks it ("every Nth").
        const rare = letter.get(order.at(-1)!)!
        const at = sequence.indexOf(rare)
        const period = (sequence.slice(at) + sequence.slice(0, at)).slice(0, p)
        const describe = (ch: string) => {
          const t = kinds[order[ch.charCodeAt(0) - 65]!]!
          return t.lines > 1 ? `${ch} (faces ${r3(t.face)} pt apart)` : `${ch} (one line)`
        }
        const others = [...new Set(period.slice(1))].map(describe).join(' and ')
        repeat = { every: p, pattern: period, summary: `${describe(rare)} every ${p}${p === 2 ? 'nd' : p === 3 ? 'rd' : 'th'} member, ${others} between` }
        break
      }
    }
  }
  const memberTypes = order.map((k) => {
    const t = kinds[k]!
    const len = median(t.lengths)
    return {
      type: letter.get(k)!,
      drawnAs: t.lines > 1 ? 'faces' as const : 'one line' as const,
      ...(t.lines > 1 ? { faceWidthPoints: r3(t.face), faceWidthFeet: fpp === null ? null : r3(t.face * fpp), faceWidth: fpp === null ? null : formatFeetInches(t.face * fpp) } : {}),
      count: t.count,
      lengthPoints: r3(len),
      length: fpp === null ? null : formatFeetInches(len * fpp),
    }
  })
  if (kinds.length > 1) {
    note = `${kinds.length} kinds of member, drawn differently (see memberTypes${repeat !== undefined ? ' and repeat' : ''}); spacing is between every member, centre to centre${note !== undefined ? '. ' + note : ''}`
  }
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
    memberTypes,
    ...(kinds.length > 1 ? { sequence } : {}),
    ...(repeat !== undefined ? { repeat } : {}),
    ...(ignoredLines > 0 ? { ignoredLines } : {}),
    ...(note !== undefined ? { note } : {}),
  }
}

type LineGroup = { across: number; spans: Array<[number, number]> }

const coveredLength = (spans: Array<[number, number]>): number => {
  const sp = [...spans].sort((a, b) => a[0] - b[0])
  let total = 0
  let cur: [number, number] | null = null
  for (const s of sp) {
    if (cur !== null && s[0] <= cur[1]) cur[1] = Math.max(cur[1], s[1])
    else { if (cur !== null) total += cur[1] - cur[0]; cur = [s[0], s[1]] }
  }
  if (cur !== null) total += cur[1] - cur[0]
  return total
}

/**
 * The lines of a field that repeat at one period, by drawn length: the
 * members. Null when there is no clear period, or when three or more phases
 * are strong (mixed members, read the usual way).
 */
export function periodicMembers(groups: LineGroup[]): { kept: LineGroup[]; ignored: number; period: number; faceBelow: number } | null {
  const n = groups.length
  if (n < 6) return null
  const across = groups.map((g) => g.across)
  const w = groups.map((g) => coveredLength(g.spans))
  const total = w.reduce((a, b) => a + b, 0)
  if (!(total > 0)) return null
  const span = across[n - 1]! - across[0]!
  const tolFor = (p: number) => Math.max(0.4, 0.04 * p)
  // Index of the group nearest `x`, by binary search on the sorted offsets.
  const nearest = (x: number): number => {
    let lo = 0, hi = n - 1
    while (lo < hi) { const m = (lo + hi) >> 1; if (across[m]! < x) lo = m + 1; else hi = m }
    if (lo > 0 && Math.abs(across[lo - 1]! - x) < Math.abs(across[lo]! - x)) lo--
    return lo
  }
  /*
   * Share of drawn length that repeats at period p: a line counts when like
   * lines sit two steps along it (one each side, or two on one side). Two
   * steps, so a member's face width (one face a step from the other, then
   * nothing) is not taken for the spacing.
   */
  const score = (p: number): number => {
    const tol = tolFor(p)
    let hit = 0
    for (let i = 0; i < n; i++) {
      const at = (x: number) => { const j = nearest(x); return Math.abs(across[j]! - x) <= tol ? w[j]! : 0 }
      const a = across[i]!
      const m1 = at(a - p), p1 = at(a + p)
      const best = Math.max(Math.min(m1, p1), Math.min(p1, at(a + 2 * p)), Math.min(m1, at(a - 2 * p)))
      hit += Math.min(w[i]!, best)
    }
    return hit / total
  }
  // Candidate periods: offsets between nearby lines, at quarter-point steps.
  const cands = new Set<number>()
  for (let i = 0; i < n; i++) {
    for (let k = 1; k <= 8 && i + k < n; k++) {
      const d = across[i + k]! - across[i]!
      if (d > 0.5 && d <= span / 2) cands.add(Math.round(d * 4) / 4)
    }
  }
  if (cands.size === 0) return null
  const scored = [...cands].map((p) => ({ p, s: score(p) }))
  const top = Math.max(...scored.map((c) => c.s))
  if (top < 0.6) return null
  // The shortest period that scores near the best (not a multiple of it).
  const period = scored.filter((c) => c.s >= 0.9 * top).sort((a, b) => a.p - b.p)[0]!.p
  // Refine: median of the offsets between lines a period apart.
  const tol = tolFor(period)
  const fine: number[] = []
  for (let i = 0; i < n; i++) {
    const j = nearest(across[i]! + period)
    if (j !== i && Math.abs(across[j]! - across[i]! - period) <= tol) fine.push(across[j]! - across[i]!)
  }
  const P = fine.length > 0 ? median(fine) : period
  // Fold onto one period, from the heaviest line; cluster the phases.
  let heaviest = 0
  for (let i = 1; i < n; i++) if (w[i]! > w[heaviest]!) heaviest = i
  const origin = across[heaviest]!
  const phase = across.map((a) => ((((a - origin) % P) + P) % P))
  const order = phase.map((_, i) => i).sort((a, b) => phase[a]! - phase[b]!)
  const ptol = tolFor(P)
  const clusters: Array<{ phase: number; members: number[]; weight: number }> = []
  for (const i of order) {
    const c = clusters.at(-1)
    if (c && phase[i]! - c.phase <= ptol) { c.members.push(i); c.weight += w[i]! }
    else clusters.push({ phase: phase[i]!, members: [i], weight: w[i]! })
  }
  // The first and last clusters meet across the fold.
  if (clusters.length > 1 && clusters[0]!.phase + P - clusters.at(-1)!.phase <= ptol) {
    const last = clusters.pop()!
    clusters[0]!.members.push(...last.members); clusters[0]!.weight += last.weight
  }
  const maxW = Math.max(...clusters.map((c) => c.weight))
  const strong = clusters.filter((c) => c.weight >= 0.5 * maxW)
  if (strong.length > 2) return null
  // Strong phases must hold most of the drawn length to be the field's members.
  if (strong.reduce((a, c) => a + c.weight, 0) < 0.5 * total) return null
  const keep = new Set(strong.flatMap((c) => c.members))
  const kept = groups.filter((_, i) => keep.has(i))
  let faceBelow = 0
  if (strong.length === 2) {
    let d = Math.abs(strong[0]!.phase - strong[1]!.phase)
    d = Math.min(d, P - d)
    // Faces of one member sit closer together than half the spacing.
    if (d < P / 2) faceBelow = (d + Math.min(P - d, P / 2)) / 2
  }
  return { kept, ignored: n - kept.length, period: P, faceBelow }
}
