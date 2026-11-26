/**
 * Which legend mark a hatch belongs to (NOIC report, 2026-11-26: "Report
 * which legend mark or product a hatch pattern belongs to").
 *
 * A hatch is read as a signature: the directions its lines run, the spacing
 * between lines in each direction, how much line there is per square point,
 * and how many dots. Legend swatches are drawn at the same paper size as the
 * plan's hatch, so the signatures compare in PDF points without a scale.
 *
 * Pure, so it is tested without a window.
 */
import { commonSpacing } from './grid.js'
import { lineDirections } from './directions.js'

type P = { x: number; y: number }
export interface Box { x0: number; y0: number; x1: number; y1: number }

export interface HatchSignature {
  /** Line families, strongest first: angle as set_pattern_direction takes it, spacing between lines in points. */
  families: Array<{ angle: number; spacing: number | null; share: number }>
  /** Line length per square point. */
  density: number
  /** Dots (pieces under a point long) per 100 square points. */
  dots: number
  lines: number
}

const DEG = Math.PI / 180
const apart = (a: number, b: number) => { const d = Math.abs(a - b) % 180; return Math.min(d, 180 - d) }
const sheetAngle = (a: P, b: P) => ((Math.atan2(-(b.y - a.y), b.x - a.x) / DEG) % 180 + 180) % 180

function inRings(p: P, rings: ReadonlyArray<ReadonlyArray<P>>): boolean {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!, b = ring[j]!
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
  }
  return inside
}

/** Clip a segment to a box (Liang-Barsky), or null when it misses. */
function clip(a: P, b: P, x0: number, y0: number, x1: number, y1: number): [P, P] | null {
  const dx = b.x - a.x, dy = b.y - a.y
  let t0 = 0, t1 = 1
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]] as const) {
    if (p === 0) { if (q < 0) return null; continue }
    const r = q / p
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r } else { if (r < t0) return null; if (r < t1) t1 = r }
  }
  return [{ x: a.x + dx * t0, y: a.y + dy * t0 }, { x: a.x + dx * t1, y: a.y + dy * t1 }]
}

/**
 * The hatch drawn in `flat` (x1,y1,x2,y2 normalized) inside a box or an area
 * outline. A swatch's frame (long lines along its edges) is left out, and so
 * is an area's own outline. Null when nothing is drawn there.
 */
export function hatchSignature(
  flat: ArrayLike<number>,
  page: { width: number; height: number },
  where: { box: Box } | { rings: ReadonlyArray<ReadonlyArray<P>> },
): HatchSignature | null {
  const W = page.width, H = page.height
  const rings = 'rings' in where ? where.rings.map((r) => r.map((p) => ({ x: p.x * W, y: p.y * H }))) : null
  let x0: number, y0: number, x1: number, y1: number
  if (rings !== null) {
    const outer = rings[0]
    if (outer === undefined || outer.length < 3) return null
    x0 = Math.min(...outer.map((p) => p.x)); x1 = Math.max(...outer.map((p) => p.x))
    y0 = Math.min(...outer.map((p) => p.y)); y1 = Math.max(...outer.map((p) => p.y))
  } else {
    const b = (where as { box: Box }).box
    x0 = Math.min(b.x0, b.x1) * W; x1 = Math.max(b.x0, b.x1) * W
    y0 = Math.min(b.y0, b.y1) * H; y1 = Math.max(b.y0, b.y1) * H
  }
  const bw = x1 - x0, bh = y1 - y0
  if (!(bw > 0) || !(bh > 0)) return null

  const segs: Array<[P, P]> = []
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const c = clip({ x: flat[i]! * W, y: flat[i + 1]! * H }, { x: flat[i + 2]! * W, y: flat[i + 3]! * H }, x0, y0, x1, y1)
    if (c === null) continue
    const m = { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 }
    if (rings !== null && !inRings(m, rings)) continue
    segs.push(c)
  }

  // A frame: lines along the box at 0 or 90 that run most of its width or height, in its outer fifth.
  const frame = new Set<number>()
  segs.forEach(([a, b], i) => {
    const horiz = Math.abs(a.y - b.y) < 0.5, vert = Math.abs(a.x - b.x) < 0.5
    if (horiz && Math.abs(b.x - a.x) >= 0.8 * bw && (Math.abs(a.y - y0) < 0.2 * bh || Math.abs(a.y - y1) < 0.2 * bh)) frame.add(i)
    if (vert && Math.abs(b.y - a.y) >= 0.8 * bh && (Math.abs(a.x - x0) < 0.2 * bw || Math.abs(a.x - x1) < 0.2 * bw)) frame.add(i)
  })
  // Keep only the outermost frame line on each side, so a hatch of horizontal lines keeps its own.
  const outermost = new Set<number>()
  const sides: Record<string, { i: number; d: number } | undefined> = {}
  for (const i of frame) {
    const [a, b] = segs[i]!
    const horiz = Math.abs(a.y - b.y) < 0.5
    const key = horiz ? (Math.abs(a.y - y0) < Math.abs(a.y - y1) ? 'top' : 'bottom') : (Math.abs(a.x - x0) < Math.abs(a.x - x1) ? 'left' : 'right')
    const d = horiz ? Math.min(Math.abs(a.y - y0), Math.abs(a.y - y1)) : Math.min(Math.abs(a.x - x0), Math.abs(a.x - x1))
    if (sides[key] === undefined || d < sides[key]!.d) sides[key] = { i, d }
  }
  for (const s of Object.values(sides)) if (s !== undefined) outermost.add(s.i)
  // An area's own outline.
  const onOutline = (a: P, b: P): boolean => {
    if (rings === null) return false
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    for (const ring of rings) for (let k = 0; k < ring.length; k++) {
      const p = ring[k]!, q = ring[(k + 1) % ring.length]!
      const L = Math.hypot(q.x - p.x, q.y - p.y)
      if (L > 0 && Math.abs((m.x - p.x) * (q.y - p.y) - (m.y - p.y) * (q.x - p.x)) / L < 1 && apart(sheetAngle(a, b), sheetAngle(p, q)) < 3) return true
    }
    return false
  }
  const kept = segs.filter(([a, b], i) => !outermost.has(i) && !onOutline(a, b))

  const area = rings !== null ? Math.abs(rings.reduce((s, r) => {
    let t = 0
    for (let k = 0; k < r.length; k++) { const p = r[k]!, q = r[(k + 1) % r.length]!; t += p.x * q.y - q.x * p.y }
    return s + t / 2
  }, 0)) : bw * bh
  const dotsList = kept.filter(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) < 1)
  const linesList = kept.filter(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) >= 1)
  if (linesList.length === 0 && dotsList.length === 0) return null
  const length = linesList.reduce((s, [a, b]) => s + Math.hypot(b.x - a.x, b.y - a.y), 0)

  const families = lineDirections(linesList, 0.12).map((d) => {
    // Offsets across the family, merged within a third of a point, then the repeating gap.
    const n = { x: Math.sin(d.angle * DEG), y: Math.cos(d.angle * DEG) }
    const offs = linesList
      .filter(([a, b]) => apart(sheetAngle(a, b), d.angle) < 4)
      .map(([a, b]) => ((a.x + b.x) / 2) * n.x + ((a.y + b.y) / 2) * n.y)
      .sort((p, q) => p - q)
    const uniq: number[] = []
    for (const o of offs) if (uniq.length === 0 || o - uniq[uniq.length - 1]! > 0.35) uniq.push(o)
    const gaps = uniq.slice(1).map((o, k) => o - uniq[k]!)
    const s = commonSpacing(gaps)
    return { angle: d.angle, spacing: s === null ? null : Math.round(s * 100) / 100, share: d.share }
  })
  return {
    families,
    density: area > 0 ? Math.round((length / area) * 10000) / 10000 : 0,
    dots: area > 0 ? Math.round((dotsList.length / area) * 100 * 100) / 100 : 0,
    lines: linesList.length,
  }
}

/**
 * How alike two hatches are, 0..1, and why. Each family of one is paired with
 * the nearest of the other by angle; the spacing, the line density and the
 * dots must agree too.
 */
export function compareHatches(a: HatchSignature, b: HatchSignature): { score: number; why: string[] } {
  const why: string[] = []
  const close = (x: number, y: number, tol: number) => (x === 0 && y === 0) ? 1 : Math.exp(-((Math.log((x + 1e-9) / (y + 1e-9)) / tol) ** 2))
  let fam = 1
  if (a.families.length === 0 && b.families.length === 0) {
    fam = 1
  } else if (a.families.length === 0 || b.families.length === 0) {
    fam = 0; why.push('one has lines and the other none')
  } else {
    const pair = (x: HatchSignature, y: HatchSignature) => x.families.map((f) => {
      let best = 0
      for (const g of y.families) {
        const ang = Math.exp(-((apart(f.angle, g.angle) / 6) ** 2))
        const sp = f.spacing !== null && g.spacing !== null ? close(f.spacing, g.spacing, 0.2) : 0.6
        best = Math.max(best, ang * sp)
      }
      return best * f.share
    }).reduce((s, v) => s + v, 0) / Math.max(1e-9, x.families.reduce((s, f) => s + f.share, 0))
    fam = Math.min(pair(a, b), pair(b, a))
    if (a.families.length !== b.families.length) { fam *= 0.75; why.push(`${a.families.length} line direction(s) against ${b.families.length}`) }
  }
  const dens = close(a.density, b.density, 0.5)
  const dots = Math.max(a.dots, b.dots) < 0.2 ? 1 : close(a.dots, b.dots, 0.7)
  if (dens < 0.5) why.push('much more line in one than the other')
  if (dots < 0.5) why.push('dots differ')
  const score = Math.round(fam * Math.sqrt(dens) * dots * 1000) / 1000
  return { score, why }
}

/**
 * Legend rows from the words in a legend box: each line of text is a row,
 * and its swatch is the part of the box to the left of the text, as high as
 * the row (halfway to the rows above and below).
 */
export function legendRows(
  words: ReadonlyArray<{ text: string; box: Box }>,
  legend: Box,
): Array<{ label: string; swatch: Box }> {
  const L = { x0: Math.min(legend.x0, legend.x1), x1: Math.max(legend.x0, legend.x1), y0: Math.min(legend.y0, legend.y1), y1: Math.max(legend.y0, legend.y1) }
  const ws = words.map((w) => ({ text: w.text, x0: Math.min(w.box.x0, w.box.x1), x1: Math.max(w.box.x0, w.box.x1), y0: Math.min(w.box.y0, w.box.y1), y1: Math.max(w.box.y0, w.box.y1) }))
    .sort((p, q) => (p.y0 + p.y1) - (q.y0 + q.y1))
  const lines: Array<typeof ws> = []
  for (const w of ws) {
    const last = lines[lines.length - 1]
    const h = w.y1 - w.y0
    if (last !== undefined && Math.abs((last[0]!.y0 + last[0]!.y1) / 2 - (w.y0 + w.y1) / 2) < 0.5 * h) last.push(w)
    else lines.push([w])
  }
  const rows = lines.map((ln) => {
    ln.sort((p, q) => p.x0 - q.x0)
    return { label: ln.map((w) => w.text).join(' '), x0: ln[0]!.x0, y: (Math.min(...ln.map((w) => w.y0)) + Math.max(...ln.map((w) => w.y1))) / 2, h: Math.max(...ln.map((w) => w.y1 - w.y0)) }
  })
  return rows.map((r, i) => {
    const up = i > 0 ? (rows[i - 1]!.y + r.y) / 2 : Math.max(L.y0, r.y - 2 * r.h)
    const down = i < rows.length - 1 ? (rows[i + 1]!.y + r.y) / 2 : Math.min(L.y1, r.y + 2 * r.h)
    return { label: r.label, swatch: { x0: L.x0, y0: up, x1: Math.max(L.x0, r.x0 - 0.2 * r.h), y1: down } }
  }).filter((r) => r.swatch.x1 - r.swatch.x0 > 0)
}
