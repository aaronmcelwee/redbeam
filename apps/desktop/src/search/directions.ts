/**
 * Split a drawn field into regions by the direction its members run (NOIC
 * report, 2026-11-26: "Split a field into regions by member direction and
 * return polygons with angles, which is what CL111 needed").
 *
 * The lines inside an area are sorted into a few directions by a
 * length-weighted histogram. The area is cut into small cells, and each cell
 * takes the direction most of its line length runs in. Cells with no lines
 * take their neighbours' direction, small islands join what surrounds them,
 * and each connected run of cells becomes one region, clipped to the area.
 *
 * Pure, so it is tested without a window.
 */
import { piecesInArea, unionRings, type Polygon, type Region } from '@redbeam/domain'

type P = { x: number; y: number }

export interface DirectionRegion {
  /** Degrees, counter-clockwise from across the sheet (set_pattern_direction's `angle`), 0..180. */
  angle: number
  /**
   * The region as areas to draw, normalized page coordinates: each is an
   * outline then its holes, as create_markup takes `rings`. Usually one; more
   * when the area's outline cuts the region in two.
   */
  polygons: P[][][]
  /** Share of the area, 0..1. */
  share: number
}

export interface DirectionResult {
  /** The directions found, strongest first, with their share of line length. */
  directions: Array<{ angle: number; share: number }>
  regions: DirectionRegion[]
  /** Cell size used, in PDF points. */
  cellPoints: number
}

export interface DirectionOptions {
  /** Area outline (normalized), outer ring first. Or `box`. */
  rings?: ReadonlyArray<ReadonlyArray<P>>
  box?: { x0: number; y0: number; x1: number; y1: number }
  /** Cell size in points; default the area's longer side / 40. */
  cellPoints?: number
  /** A direction needs this share of all line length to count. Default 0.08. */
  minShare?: number
  /** Lines shorter than this (points) are ignored. Default 3. */
  minLength?: number
}

const DEG = Math.PI / 180

/** set_pattern_direction's angle (CCW, y up) of a segment in page points (y down), 0..180. */
function sheetAngle(a: P, b: P): number {
  const t = Math.atan2(-(b.y - a.y), b.x - a.x) / DEG
  return ((t % 180) + 180) % 180
}

/** Angular distance on a 180-degree circle. */
function apart(a: number, b: number): number {
  const d = Math.abs(a - b) % 180
  return Math.min(d, 180 - d)
}

/**
 * The directions lines run in: peaks of a length-weighted histogram (1-degree
 * bins, smoothed), each at least `minShare` of the length and 10 degrees from
 * a stronger one. Each peak is refined to the weighted mean of the lines near it.
 */
export function lineDirections(segs: ReadonlyArray<[P, P]>, minShare = 0.08): Array<{ angle: number; share: number }> {
  const bins = new Float64Array(180)
  let total = 0
  for (const [a, b] of segs) {
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len === 0) continue
    bins[Math.min(179, Math.floor(sheetAngle(a, b)))]! += len
    total += len
  }
  if (total === 0) return []
  const smooth = Array.from({ length: 180 }, (_, i) => {
    let s = 0
    for (let k = -2; k <= 2; k++) s += bins[(i + k + 180) % 180]! * (k === 0 ? 1 : 0.5)
    return s
  })
  const out: Array<{ angle: number; share: number }> = []
  const order = smooth.map((w, i) => ({ w, i })).sort((p, q) => q.w - p.w)
  for (const { i } of order) {
    const centre = i + 0.5
    if (out.some((d) => apart(d.angle, centre) < 10)) continue
    let sw = 0, sa = 0
    for (const [a, b] of segs) {
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len === 0) continue
      let ang = sheetAngle(a, b)
      let d = ang - centre
      if (d > 90) { ang -= 180; d -= 180 } else if (d < -90) { ang += 180; d += 180 }
      if (Math.abs(d) <= 4) { sw += len; sa += ang * len }
    }
    if (sw / total < minShare) break
    const mean = Math.round((((sa / sw) % 180) + 180) % 180 * 100) / 100
    out.push({ angle: mean >= 180 ? 0 : mean, share: Math.round((sw / total) * 1000) / 1000 })
    if (out.length === 6) break
  }
  return out
}

const ringArea = (r: ReadonlyArray<P>): number => {
  let a = 0
  for (let i = 0; i < r.length; i++) { const p = r[i]!, q = r[(i + 1) % r.length]!; a += p.x * q.y - q.x * p.y }
  return Math.abs(a) / 2
}

/** Flat rings back into polygons: an outline, then the holes inside it. */
export function nestRings(rings: ReadonlyArray<ReadonlyArray<P>>): P[][][] {
  const depth = rings.map((r, i) => rings.filter((o, j) => j !== i && inRings(r[0]!, [o])).length)
  const outers = rings.map((r, i) => ({ r, i })).filter(({ i }) => depth[i]! % 2 === 0)
  const out = outers.map(({ r }) => [r.map((p) => ({ ...p }))])
  rings.forEach((r, i) => {
    if (depth[i]! % 2 === 0) return
    let best = -1, ba = Infinity
    outers.forEach((o, k) => { const a = ringArea(o.r); if (a < ba && inRings(r[0]!, [o.r])) { ba = a; best = k } })
    if (best >= 0) out[best]!.push(r.map((p) => ({ ...p })))
  })
  return out
}

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

/**
 * The regions of `flat` (x1,y1,x2,y2 normalized, as requestGeometry gives
 * them) inside an area, by the direction their lines run. Null when no
 * direction is drawn there.
 */
export function directionRegions(
  flat: ArrayLike<number>,
  page: { width: number; height: number },
  opts: DirectionOptions = {},
): DirectionResult | null {
  const W = page.width, H = page.height
  const ringsPts = opts.rings?.map((r) => r.map((p) => ({ x: p.x * W, y: p.y * H })))
  let x0: number, y0: number, x1: number, y1: number
  if (ringsPts !== undefined && ringsPts[0] !== undefined && ringsPts[0].length >= 3) {
    const xs = ringsPts[0].map((p) => p.x), ys = ringsPts[0].map((p) => p.y)
    x0 = Math.min(...xs); x1 = Math.max(...xs); y0 = Math.min(...ys); y1 = Math.max(...ys)
  } else if (opts.box !== undefined) {
    x0 = Math.min(opts.box.x0, opts.box.x1) * W; x1 = Math.max(opts.box.x0, opts.box.x1) * W
    y0 = Math.min(opts.box.y0, opts.box.y1) * H; y1 = Math.max(opts.box.y0, opts.box.y1) * H
  } else {
    return null
  }
  if (!(x1 > x0) || !(y1 > y0)) return null
  const inside = (p: P) => ringsPts === undefined ? (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) : inRings(p, ringsPts)

  // Segments in points, the part of each that lies in the box.
  const minLen = opts.minLength ?? 3
  const segs: Array<[P, P]> = []
  for (let i = 0; i + 3 < flat.length; i += 4) {
    let a = { x: flat[i]! * W, y: flat[i + 1]! * H }, b = { x: flat[i + 2]! * W, y: flat[i + 3]! * H }
    // Liang-Barsky to the box.
    const dx = b.x - a.x, dy = b.y - a.y
    let t0 = 0, t1 = 1, ok = true
    for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]] as const) {
      if (p === 0) { if (q < 0) { ok = false; break } continue }
      const r = q / p
      if (p < 0) { if (r > t1) { ok = false; break } if (r > t0) t0 = r } else { if (r < t0) { ok = false; break } if (r < t1) t1 = r }
    }
    if (!ok) continue
    const na = { x: a.x + dx * t0, y: a.y + dy * t0 }, nb = { x: a.x + dx * t1, y: a.y + dy * t1 }
    a = na; b = nb
    if (Math.hypot(b.x - a.x, b.y - a.y) < minLen) continue
    segs.push([a, b])
  }

  // The area's own outline is drawn too; its edges are not members. Leave out
  // lines that lie along the outline.
  const onOutline = (a: P, b: P): boolean => {
    if (ringsPts === undefined) return false
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    for (const ring of ringsPts) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i]!, q = ring[(i + 1) % ring.length]!
        const L = Math.hypot(q.x - p.x, q.y - p.y)
        if (L === 0) continue
        const off = Math.abs((m.x - p.x) * (q.y - p.y) - (m.y - p.y) * (q.x - p.x)) / L
        if (off < 1.5 && apart(sheetAngle(a, b), sheetAngle(p, q)) < 3) return true
      }
    }
    return false
  }
  const members = segs.filter(([a, b]) => !onOutline(a, b) && inside({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }))
  const directions = lineDirections(members, opts.minShare ?? 0.08)
  if (directions.length === 0) return null

  // Cells.
  const cell = opts.cellPoints ?? Math.max(4, Math.max(x1 - x0, y1 - y0) / 40)
  const cols = Math.max(1, Math.ceil((x1 - x0) / cell)), rows = Math.max(1, Math.ceil((y1 - y0) / cell))
  const D = directions.length
  const weight = new Float64Array(cols * rows * D)
  for (const [a, b] of members) {
    const ang = sheetAngle(a, b)
    let best = -1, bd = 8
    directions.forEach((d, k) => { const g = apart(d.angle, ang); if (g < bd) { bd = g; best = k } })
    if (best < 0) continue
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const steps = Math.max(1, Math.ceil(len / (cell / 2)))
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps
      const c = Math.min(cols - 1, Math.max(0, Math.floor((a.x + (b.x - a.x) * t - x0) / cell)))
      const r = Math.min(rows - 1, Math.max(0, Math.floor((a.y + (b.y - a.y) * t - y0) / cell)))
      weight[(r * cols + c) * D + best]! += len / steps
    }
  }
  const IN = new Uint8Array(cols * rows)
  const label = new Int16Array(cols * rows).fill(-1)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (!inside({ x: x0 + (c + 0.5) * cell, y: y0 + (r + 0.5) * cell })) continue
      IN[i] = 1
      let sum = 0, best = -1, bw = 0
      for (let k = 0; k < D; k++) { const w = weight[i * D + k]!; sum += w; if (w > bw) { bw = w; best = k } }
      if (best >= 0 && bw >= 0.6 * sum) label[i] = best
    }
  }
  const neighbours = (i: number): number[] => {
    const r = Math.floor(i / cols), c = i % cols, out: number[] = []
    if (c > 0) out.push(i - 1)
    if (c < cols - 1) out.push(i + 1)
    if (r > 0) out.push(i - cols)
    if (r < rows - 1) out.push(i + cols)
    return out
  }
  // Empty or mixed cells take the direction most of their labelled neighbours have, outward.
  for (let pass = 0; pass < cols + rows; pass++) {
    const next = Int16Array.from(label)
    let changed = false
    for (let i = 0; i < label.length; i++) {
      if (IN[i] !== 1 || label[i]! >= 0) continue
      const votes = new Map<number, number>()
      for (const n of neighbours(i)) if (label[n]! >= 0) votes.set(label[n]!, (votes.get(label[n]!) ?? 0) + 1)
      let best = -1, bv = 0
      for (const [k, v] of votes) if (v > bv || (v === bv && k < best)) { bv = v; best = k }
      if (best >= 0) { next[i] = best; changed = true }
    }
    label.set(next)
    if (!changed) break
  }
  // Connected runs; islands under 3% of the area (or 4 cells) join what surrounds them.
  const total = IN.reduce((s, v) => s + v, 0)
  const components = (): number[][] => {
    const seen = new Uint8Array(label.length), out: number[][] = []
    for (let i = 0; i < label.length; i++) {
      if (seen[i] || IN[i] !== 1 || label[i]! < 0) continue
      const comp = [i], stack = [i]
      seen[i] = 1
      while (stack.length > 0) {
        const j = stack.pop()!
        for (const n of neighbours(j)) if (!seen[n] && IN[n] === 1 && label[n] === label[i]) { seen[n] = 1; comp.push(n); stack.push(n) }
      }
      out.push(comp)
    }
    return out
  }
  for (let round = 0; round < 3; round++) {
    let changed = false
    for (const comp of components()) {
      if (comp.length >= Math.max(4, 0.03 * total)) continue
      const own = label[comp[0]!]!
      const votes = new Map<number, number>()
      for (const i of comp) for (const n of neighbours(i)) if (IN[n] === 1 && label[n]! >= 0 && label[n] !== own) votes.set(label[n]!, (votes.get(label[n]!) ?? 0) + 1)
      let best = -1, bv = 0
      for (const [k, v] of votes) if (v > bv) { bv = v; best = k }
      if (best >= 0) { for (const i of comp) label[i] = best; changed = true }
    }
    if (!changed) break
  }

  const clipTo: Polygon[] | null = ringsPts === undefined ? null : ringsPts.map((r) => r.map((p) => ({ ...p })))
  const regions: DirectionRegion[] = []
  for (const comp of components()) {
    const squares: Polygon[] = comp.map((i) => {
      const c = i % cols, r = Math.floor(i / cols)
      const ax = x0 + c * cell, ay = y0 + r * cell
      const bx = Math.min(x1, ax + cell), by = Math.min(y1, ay + cell)
      return [{ x: ax, y: ay }, { x: bx, y: ay }, { x: bx, y: by }, { x: ax, y: by }]
    })
    const region: Region = clipTo !== null ? piecesInArea(squares, clipTo) : unionRings(squares)
    if (region.length === 0) continue
    regions.push({
      angle: directions[label[comp[0]!]!]!.angle,
      polygons: nestRings(region).map((poly) => poly.map((ring) => ring.map((p) => ({ x: p.x / W, y: p.y / H })))),
      share: Math.round((comp.length / total) * 1000) / 1000,
    })
  }
  regions.sort((a, b) => b.share - a.share)
  return { directions, regions, cellPoints: Math.round(cell * 100) / 100 }
}
