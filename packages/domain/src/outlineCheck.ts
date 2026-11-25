/**
 * Is this outline something a takeoff can stand on?
 *
 * An agent builds an outline from many reads (a trace, lines, a close-up) and
 * the mistakes it makes are geometric before they are numeric: a corner
 * clicked in the wrong order makes the outline cross itself and the area
 * comes out as the difference of two lobes; a corner read off the wrong
 * close-up lands in the margin or off the sheet. Both still give a number.
 * This says so, so the number is not trusted silently.
 */

import { pointInPolygon, regionArea, type Point, type Polygon } from './geometry.js'

export type OutlineIssueCode =
  | 'too-few-points'
  | 'off-page'
  | 'outside-drawing'
  | 'self-crossing'
  | 'rings-cross'
  | 'cutout-outside'
  | 'no-area'

export interface OutlineIssue {
  code: OutlineIssueCode
  message: string
  /** Which ring (0 is the outline, then the cutouts). */
  ring?: number
  /** Where, normalized: the crossing or the stray point. */
  at?: Point
}

export interface OutlineCheckOptions {
  page: { width: number; height: number }
  /**
   * The drawing area of the sheet, normalized. Points outside it are in the
   * margin, the title block or off the drawing. Default: the whole page.
   */
  drawingArea?: { x0: number; y0: number; x1: number; y1: number }
  /** Boxes on the sheet that are not drawing: a title block. Normalized. */
  notDrawing?: Array<{ x0: number; y0: number; x1: number; y1: number }>
}

/** Where segments ab and cd cross properly (not at a shared end), or null. */
function crossing(a: Point, b: Point, c: Point, d: Point): Point | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y
  const den = rx * sy - ry * sx
  if (den === 0) return null
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den
  const e = 1e-9
  if (t <= e || t >= 1 - e || u <= e || u >= 1 - e) return null
  return { x: a.x + t * rx, y: a.y + t * ry }
}

interface Edge { a: Point; b: Point; ring: number; index: number; n: number }

/**
 * Every pair of edges that cross, found with a uniform grid so a ring of a
 * few thousand points is not a few million comparisons.
 */
function crossings(edges: Edge[], cells: number): Array<{ e: Edge; f: Edge; at: Point }> {
  const out: Array<{ e: Edge; f: Edge; at: Point }> = []
  if (edges.length < 2) return out
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const e of edges) {
    x0 = Math.min(x0, e.a.x, e.b.x); x1 = Math.max(x1, e.a.x, e.b.x)
    y0 = Math.min(y0, e.a.y, e.b.y); y1 = Math.max(y1, e.a.y, e.b.y)
  }
  const cw = Math.max((x1 - x0) / cells, 1e-12), ch = Math.max((y1 - y0) / cells, 1e-12)
  const grid = new Map<number, number[]>()
  edges.forEach((e, i) => {
    const gx0 = Math.floor((Math.min(e.a.x, e.b.x) - x0) / cw), gx1 = Math.floor((Math.max(e.a.x, e.b.x) - x0) / cw)
    const gy0 = Math.floor((Math.min(e.a.y, e.b.y) - y0) / ch), gy1 = Math.floor((Math.max(e.a.y, e.b.y) - y0) / ch)
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const k = gy * (cells + 1) + gx
        const list = grid.get(k)
        if (list) list.push(i); else grid.set(k, [i])
      }
    }
  })
  const seen = new Set<number>()
  for (const list of grid.values()) {
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        const i = Math.min(list[p]!, list[q]!), j = Math.max(list[p]!, list[q]!)
        const key = i * edges.length + j
        if (seen.has(key)) continue
        seen.add(key)
        const e = edges[i]!, f = edges[j]!
        if (e.ring === f.ring) {
          const d = Math.abs(e.index - f.index)
          if (d <= 1 || d === e.n - 1) continue
        }
        const at = crossing(e.a, e.b, f.a, f.b)
        if (at) out.push({ e, f, at })
      }
    }
  }
  return out
}

/**
 * Check an outline: `rings[0]` the outer outline, the rest cutouts, all
 * normalized. Returns the problems found, none for a sound outline.
 */
export function checkOutline(rings: ReadonlyArray<ReadonlyArray<Point>>, opts: OutlineCheckOptions): OutlineIssue[] {
  const issues: OutlineIssue[] = []
  const r5 = (p: Point): Point => ({ x: Math.round(p.x * 1e5) / 1e5, y: Math.round(p.y * 1e5) / 1e5 })
  const area = opts.drawingArea ?? { x0: 0, y0: 0, x1: 1, y1: 1 }
  const inBox = (p: Point, b: { x0: number; y0: number; x1: number; y1: number }, e = 0) =>
    p.x >= Math.min(b.x0, b.x1) - e && p.x <= Math.max(b.x0, b.x1) + e && p.y >= Math.min(b.y0, b.y1) - e && p.y <= Math.max(b.y0, b.y1) + e

  rings.forEach((ring, r) => {
    if (ring.length < 3) {
      issues.push({ code: 'too-few-points', ring: r, message: `${r === 0 ? 'the outline' : `cutout ${r}`} has ${ring.length} point${ring.length === 1 ? '' : 's'}; an area needs at least 3` })
      return
    }
    const off = ring.find((p) => !(p.x >= -1e-4 && p.x <= 1 + 1e-4 && p.y >= -1e-4 && p.y <= 1 + 1e-4) || !Number.isFinite(p.x) || !Number.isFinite(p.y))
    if (off) {
      issues.push({ code: 'off-page', ring: r, at: off, message: `a point (${off.x}, ${off.y}) is off the sheet: coordinates are normalized 0..1` })
      return
    }
    const stray = ring.find((p) => !inBox(p, area, 1e-4) || (opts.notDrawing ?? []).some((b) => inBox(p, b)))
    if (stray) {
      issues.push({ code: 'outside-drawing', ring: r, at: r5(stray), message: `a point (${r5(stray).x}, ${r5(stray).y}) is outside the drawing area (in the margin or the title block)` })
    }
  })

  const usable = rings.filter((r) => r.length >= 3)
  const edges: Edge[] = []
  usable.forEach((ring, r) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!
      if (a.x === b.x && a.y === b.y) continue
      edges.push({ a: { x: a.x * opts.page.width, y: a.y * opts.page.height }, b: { x: b.x * opts.page.width, y: b.y * opts.page.height }, ring: r, index: i, n: ring.length })
    }
  })
  const found = crossings(edges, Math.max(4, Math.min(256, Math.round(Math.sqrt(edges.length)))))
  const selfReported = new Set<number>()
  let ringsReported = false
  for (const { e, f, at } of found) {
    const where = r5({ x: at.x / opts.page.width, y: at.y / opts.page.height })
    if (e.ring === f.ring) {
      if (selfReported.has(e.ring)) continue
      selfReported.add(e.ring)
      issues.push({
        code: 'self-crossing', ring: e.ring, at: where,
        message: `${e.ring === 0 ? 'the outline' : `cutout ${e.ring}`} crosses itself near (${where.x}, ${where.y}): its points are out of order, and its area is wrong`,
      })
    } else if (!ringsReported) {
      ringsReported = true
      issues.push({ code: 'rings-cross', ring: f.ring, at: where, message: `cutout ${f.ring} crosses ring ${e.ring} near (${where.x}, ${where.y})` })
    }
  }
  if (usable.length > 1 && usable[0]) {
    const outer = usable[0] as Polygon
    usable.slice(1).forEach((hole, i) => {
      if (!pointInPolygon(hole[0]!, outer) && !pointInPolygon(hole[Math.floor(hole.length / 2)]!, outer)) {
        issues.push({ code: 'cutout-outside', ring: i + 1, at: r5(hole[0]!), message: `cutout ${i + 1} is not inside the outline` })
      }
    })
  }
  if (usable.length > 0 && !issues.some((i) => i.code === 'self-crossing')) {
    const pts = usable.map((r) => r.map((p) => ({ x: p.x * opts.page.width, y: p.y * opts.page.height })))
    if (regionArea(pts) < 1) issues.push({ code: 'no-area', message: 'the outline has no area (its points are in a line or on top of each other)' })
  }
  return issues
}
