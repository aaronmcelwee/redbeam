/**
 * Lays a custom pattern (patternRecipe.ts) on a scope's areas and counts it.
 *
 * Each area group is laid out in its own frame: "along" is the group's
 * direction, "across" its left normal, both in FEET from the pattern origin
 * (the placed origin, or the area's corner in that frame). Working in feet in
 * the pattern's own frame makes every module axis-aligned and every length
 * physical, so a recipe means the same thing on a 1/8" sheet and a 1/4" one.
 *
 * What is reused rather than reinvented:
 *  - The clip is the panel engine's idea (panels.ts): Sutherland-Hodgman of
 *    the REGION against a CONVEX window. A concave area with holes clips
 *    exactly, area-wise, because bridge edges add nothing to the shoelace sum
 *    and holes keep their sign from the original ring nesting. That is why a
 *    tile must be convex, and why an L is two tiles.
 *  - Stock cutting rounds the last piece of a run to the yield ladder
 *    (pieces.ts) and orders with orderStockPieceCount (panels.ts), the same
 *    nesting rule baffles and planks are ordered by.
 *  - Trim is trimEdgeLengths / trimPiecesForEdges (geometry.ts), the rule
 *    panels use: every edge rounded up to whole lengths on its own.
 *
 * Built-in layers (panels, baffles...) are counted by their own engine in
 * takeoff.ts and handed in here as page geometry, so hardware can be tied to
 * them: clips where a rail crosses a panel joint.
 */

import { pointInPolygon, regionArea, signedPolygonArea, trimEdgeLengths, trimPiecesForEdges, type Point, type Region } from './geometry.js'
import { orderStockPieceCount, roundUpQuantity } from './panels.js'
import { allowedPieceFractions, leftNormal, roundStockFractionToAllowed } from './pieces.js'
import { DEFAULT_EDGE_SNAP_FEET, slugOf, type ResolvedHardware, type ResolvedLayer, type ResolvedModule, type ResolvedRecipe, type ResolvedRunMaterial } from './patternRecipe.js'

/** One area group to lay out, in PDF points. Same shape as runs.ts RunGroup. */
export interface PatternGroup {
  pageId: string
  region: Region
  direction: Point
  feetPerPoint: number
  origin?: Point | null
}

/** Something to draw, in PDF points on `pageId`. */
export interface PatternShape {
  pageId: string
  /** Layer id and its index in the recipe: the preview colours by index. */
  layer: string
  layerIndex: number
  kind: 'polygon' | 'segment' | 'point'
  points: Point[]
  /** Cut at the edge: drawn darker, as part panels are. */
  cut: boolean
  /** A run's face width in points, when the layer states one. */
  width?: number
}

/** A built-in layer's geometry, in PDF points, from its own engine. */
export interface BuiltInGeometry {
  layerId: string
  polygons: Array<{ pageId: string; points: Point[] }>
  segments: Array<{ pageId: string; a: Point; b: Point }>
}

export interface PatternQuantity {
  itemKey: string
  label: string
  quantity: number
  unit: string
  /** The layer's name: the parts list and the BOM group by it. */
  layer: string
  /** Folded into its layer's main line in the sidebar; still in the BOM. */
  detail?: boolean
}

export interface PatternLayout {
  quantities: PatternQuantity[]
  shapes: PatternShape[]
  blockers: string[]
  /** Net area the pattern was laid on, square feet. */
  areaSquareFeet: number
}

// ---------------------------------------------------------------------------
// Geometry in the local frame (feet)
// ---------------------------------------------------------------------------

const EPS = 1e-9

function ringSigns(region: Region): number[] {
  return region.map((ring, index) => {
    if (ring.length < 3) return 0
    const probe = ring[0]!
    let depth = 0
    region.forEach((other, j) => { if (j !== index && other.length >= 3 && pointInPolygon(probe, other)) depth++ })
    return depth % 2 === 0 ? 1 : -1
  })
}

/** Clip one ring against a convex window (Sutherland-Hodgman). */
function clipRingConvex(subject: readonly Point[], clipWindow: readonly Point[]): Point[] {
  const orient = signedPolygonArea(clipWindow as Point[]) >= 0 ? 1 : -1
  let output: Point[] = [...subject]
  for (let i = 0; i < clipWindow.length && output.length > 0; i++) {
    const a = clipWindow[i]!, b = clipWindow[(i + 1) % clipWindow.length]!
    const inside = (p: Point) => orient * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) >= -EPS
    const cross = (p: Point, q: Point): Point => {
      const dx = q.x - p.x, dy = q.y - p.y
      const ex = b.x - a.x, ey = b.y - a.y
      const den = dx * ey - dy * ex
      if (Math.abs(den) < 1e-15) return q
      const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / den
      return { x: p.x + dx * t, y: p.y + dy * t }
    }
    const input = output
    output = []
    for (let k = 0; k < input.length; k++) {
      const cur = input[k]!, prev = input[(k + input.length - 1) % input.length]!
      const ci = inside(cur), pi = inside(prev)
      if (ci) {
        if (!pi) output.push(cross(prev, cur))
        output.push(cur)
      } else if (pi) {
        output.push(cross(prev, cur))
      }
    }
  }
  return output
}

/** Region ∩ convex window: rings and net area. */
function clipRegion(region: Region, signs: readonly number[], clipWindow: readonly Point[]): { rings: Region; area: number } {
  const rings: Region = []
  let area = 0
  region.forEach((ring, i) => {
    if (ring.length < 3) return
    const c = clipRingConvex(ring, clipWindow)
    if (c.length < 3) return
    const a = Math.abs(signedPolygonArea(c))
    if (a < 1e-12) return
    rings.push(c)
    area += (signs[i] ?? 1) * a
  })
  return { rings, area: Math.max(0, area) }
}

/** Where the horizontal line y crosses the region, as inside intervals [x0, x1]. */
function lineIntervals(region: Region, y: number): Array<[number, number]> {
  const xs: number[] = []
  for (const ring of region) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!
      if ((a.y > y) !== (b.y > y)) xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y))
    }
  }
  xs.sort((p, q) => p - q)
  const out: Array<[number, number]> = []
  for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1]! - xs[i]! > EPS) out.push([xs[i]!, xs[i + 1]!])
  return out
}

/**
 * A run lying ON the area's edge (a main on the wall line) is the wall's,
 * not the ceiling's: wall angle counts it. Probe a hair to each side.
 */
function onBoundary(region: Region, s: number, e: number, y: number): boolean {
  const mid = (s + e) / 2
  const d = 1e-6
  return !(insideRegion({ x: mid, y: y + d }, region) && insideRegion({ x: mid, y: y - d }, region))
}

function insideRegion(p: Point, region: Region): boolean {
  let inside = false
  for (const ring of region) if (ring.length >= 3 && pointInPolygon(p, ring)) inside = !inside
  return inside
}

function bounds(region: Region): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const r of region) for (const p of r) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null
}

function segmentCross(a: Point, b: Point, c: Point, d: Point): Point | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y
  const den = rx * sy - ry * sx
  if (Math.abs(den) < 1e-12) return null
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null
  return { x: a.x + rx * t, y: a.y + ry * t }
}

/**
 * A convex polygon moved in by `by` on every side (each edge parallel to its
 * own), or null when nothing is left. The edge snap asks whether THIS is in
 * the area: if so, the tile is short of the area only by drawing error.
 */
function insetConvex(points: readonly Point[], by: number): Point[] | null {
  const n = points.length
  if (n < 3) return null
  if (!(by > 0)) return [...points]
  const ccw = signedPolygonArea(points as Point[]) > 0 ? 1 : -1
  const lines: Array<{ p: Point; d: Point }> = []
  for (let k = 0; k < n; k++) {
    const a = points[k]!, b = points[(k + 1) % n]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 1e-12) continue
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
    // Inward is left of a counter-clockwise edge.
    const inward = { x: -d.y * ccw, y: d.x * ccw }
    lines.push({ p: { x: a.x + inward.x * by, y: a.y + inward.y * by }, d })
  }
  const out: Point[] = []
  for (let k = 0; k < lines.length; k++) {
    const l1 = lines[(k + lines.length - 1) % lines.length]!, l2 = lines[k]!
    const den = l1.d.x * l2.d.y - l1.d.y * l2.d.x
    if (Math.abs(den) < 1e-12) { out.push(l2.p); continue }
    const t = ((l2.p.x - l1.p.x) * l2.d.y - (l2.p.y - l1.p.y) * l2.d.x) / den
    out.push({ x: l1.p.x + l1.d.x * t, y: l1.p.y + l1.d.y * t })
  }
  // Inset past its own middle, the polygon turns inside out.
  return signedPolygonArea(out) * ccw > 1e-12 ? out : null
}

function shrink(points: readonly Point[], by: number): Point[] {
  if (!(by > 0)) return [...points]
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length
  return points.map((p) => {
    const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy)
    return d <= by ? { x: cx, y: cy } : { x: p.x - dx / d * by, y: p.y - dy / d * by }
  })
}

// ---------------------------------------------------------------------------
// Layer results, accumulated over every group
// ---------------------------------------------------------------------------

interface RunPiece { a: Point; b: Point; length: number; full: boolean }

interface LayerAcc {
  kind: ResolvedLayer['kind']
  name: string
  /** tiles: per tile name */
  tileCounts: Map<string, { placed: number; full: number; ordered: number; cutFractions: number[]; tileArea: number; coveredArea: number }>
  modules: number
  /** Installed run pieces, local feet, per group (reset per group for crossings). */
  runs: RunPiece[]
  runCount: number
  runLength: number
  stockFractions: number[]
  parts: number
  joints: number
  /** Polygons for crossings, local feet, this group. */
  polys: Point[][]
}

const newAcc = (kind: ResolvedLayer['kind'], name: string): LayerAcc => ({
  kind, name, tileCounts: new Map(), modules: 0, runs: [], runCount: 0, runLength: 0,
  stockFractions: [], parts: 0, joints: 0, polys: [],
})

function cutRun(length: number, mat: ResolvedRunMaterial, acc: LayerAcc): void {
  if (mat.partLength > 0) { acc.parts += Math.max(1, Math.ceil(length / mat.partLength - 1e-9)); return }
  if (!(mat.stock > 0)) return
  const whole = Math.floor(length / mat.stock + 1e-9)
  const rest = length - whole * mat.stock
  for (let i = 0; i < whole; i++) acc.stockFractions.push(1)
  let pieces = whole
  if (rest > 1e-6) {
    acc.stockFractions.push(roundStockFractionToAllowed(rest / mat.stock, allowedPieceFractions(mat.yield)))
    pieces++
  }
  acc.joints += Math.max(0, pieces - 1)
}

/** Lattice index ranges covering bounds, for a module whose content spans [cMinX,cMaxX]x[cMinY,cMaxY]. */
function* lattice(
  m: ResolvedModule, b: { minX: number; maxX: number; minY: number; maxY: number },
  c: { minX: number; maxX: number; minY: number; maxY: number },
): Generator<[number, number, number, number]> {
  const j0 = Math.floor((b.minY - c.maxY) / m.across) - 1
  const j1 = Math.ceil((b.maxY - c.minY) / m.across) + 1
  for (let j = j0; j <= j1; j++) {
    const sx = j * m.shift
    const i0 = Math.floor((b.minX - sx - c.maxX) / m.along) - 1
    const i1 = Math.ceil((b.maxX - sx - c.minX) / m.along) + 1
    for (let i = i0; i <= i1; i++) yield [i, j, i * m.along + sx, j * m.across]
  }
}

function latticeSize(m: ResolvedModule, b: { minX: number; maxX: number; minY: number; maxY: number }): number {
  return ((b.maxX - b.minX) / m.along + 4) * ((b.maxY - b.minY) / m.across + 4)
}

/**
 * The guard is about UNITS, not size. Aaron (2026-11-24): no caps on how big a
 * set is. But a module typed in feet where inches were meant, on a 300' floor,
 * asks for billions of cells, and the only honest answer is to say so.
 */
const UNITS_GUARD = 5_000_000

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function layoutPattern(
  recipe: ResolvedRecipe,
  groups: readonly PatternGroup[],
  builtIn: readonly BuiltInGeometry[] = [],
): PatternLayout {
  const shapes: PatternShape[] = []
  const blockers: string[] = []
  const accs = new Map<string, LayerAcc>()
  const hardwareTotals = new Map<string, number>()
  const hardwareLayer = new Map<string, string>()
  let areaSquareFeet = 0
  recipe.layers.forEach((l) => accs.set(l.id, newAcc(l.kind, l.name)))
  const snap = Math.max(0, recipe.edgeSnap ?? DEFAULT_EDGE_SNAP_FEET)
  const indexOf = new Map(recipe.layers.map((l, i) => [l.id, i]))

  for (const group of groups) {
    const fpp = group.feetPerPoint
    if (!(fpp > 0)) continue
    const dl = Math.hypot(group.direction.x, group.direction.y)
    if (!(dl > 0)) continue
    const u = { x: group.direction.x / dl, y: group.direction.y / dl }
    const n = leftNormal(u)
    // Automatic origin: the area's corner in the pattern's frame.
    let origin = group.origin ?? null
    if (origin === null) {
      let minA = Infinity, minB = Infinity
      for (const r of group.region) for (const p of r) {
        minA = Math.min(minA, p.x * u.x + p.y * u.y)
        minB = Math.min(minB, p.x * n.x + p.y * n.y)
      }
      if (!Number.isFinite(minA)) continue
      origin = { x: u.x * minA + n.x * minB, y: u.y * minA + n.y * minB }
    }
    const O = origin
    const toLocal = (p: Point): Point => {
      const rx = p.x - O.x, ry = p.y - O.y
      return { x: (rx * u.x + ry * u.y) * fpp, y: (rx * n.x + ry * n.y) * fpp }
    }
    const toPage = (p: Point): Point => ({
      x: O.x + u.x * (p.x / fpp) + n.x * (p.y / fpp),
      y: O.y + u.y * (p.x / fpp) + n.y * (p.y / fpp),
    })
    const region = group.region.map((r) => r.map(toLocal))
    const signs = ringSigns(region)
    const b = bounds(region)
    if (b === null) continue
    areaSquareFeet += regionArea(region)
    for (const acc of accs.values()) { acc.runs = []; acc.polys = [] }

    const shape = (layer: string, kind: PatternShape['kind'], pts: Point[], cut: boolean, width?: number) => {
      shapes.push({
        pageId: group.pageId, layer, layerIndex: indexOf.get(layer) ?? 0, kind,
        points: pts.map(toPage), cut, ...(width !== undefined && width > 0 ? { width: width / fpp } : {}),
      })
    }

    for (const layer of recipe.layers) {
      const acc = accs.get(layer.id)!
      if (layer.kind === 'tiles') {
        const all = layer.tiles.flatMap((t) => t.points)
        const c = { minX: Math.min(...all.map((p) => p.x)), maxX: Math.max(...all.map((p) => p.x)), minY: Math.min(...all.map((p) => p.y)), maxY: Math.max(...all.map((p) => p.y)) }
        if (latticeSize(layer.module, b) * layer.tiles.length > UNITS_GUARD) {
          blockers.push(`${layer.name}: a ${fmtFeet(layer.module.along)} by ${fmtFeet(layer.module.across)} module is very small for this area. Check the recipe's units`)
          continue
        }
        for (const [i, j, dx, dy] of lattice(layer.module, b, c)) {
          let touched = false
          for (const tile of layer.tiles) {
            const poly = tile.points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
            const tb = { minX: c.minX + dx, maxX: c.maxX + dx, minY: c.minY + dy, maxY: c.maxY + dy }
            if (tb.maxX < b.minX || tb.minX > b.maxX || tb.maxY < b.minY || tb.minY > b.maxY) continue
            const clipped = clipRegion(region, signs, poly)
            const fraction = clipped.area / tile.area
            /*
             * Edge snap (NOIC CL115, 2026-11-26): an area drawn N modules
             * wide counted six "cut" slivers, and one a hair smaller cut its
             * whole last row. A strip `snap` wide along the tile's longest
             * side is the most a drawing error can add, so a piece no bigger
             * is a sliver; and a tile that is in the area once every side
             * moves in by `snap` is short of it only by drawing error, so it
             * is whole.
             */
            if (fraction < 0.001 || clipped.area <= snap * tile.span) continue
            touched = true
            let full = fraction > 0.999
            if (!full && snap > 0) {
              const core = insetConvex(poly, snap)
              if (core !== null) {
                const coreArea = Math.abs(signedPolygonArea(core))
                full = coreArea > 0 && clipRegion(region, signs, core).area / coreArea > 0.999
              }
            }
            let t = acc.tileCounts.get(tile.name)
            if (t === undefined) { t = { placed: 0, full: 0, ordered: 0, cutFractions: [], tileArea: tile.area, coveredArea: 0 }; acc.tileCounts.set(tile.name, t) }
            t.placed++
            t.coveredArea += clipped.area
            if (full) t.full++
            else t.cutFractions.push(Math.min(1, fraction))
            acc.polys.push(poly)
            if (full) shape(layer.id, 'polygon', shrink(poly, layer.joint / 2), false)
            else for (const ring of clipped.rings) shape(layer.id, 'polygon', ring, true)
          }
          if (touched) acc.modules++
          void i; void j
        }
        continue
      }
      if (layer.kind === 'members') {
        const c = {
          minX: Math.min(...layer.members.map((m) => m.along)), maxX: Math.max(...layer.members.map((m) => m.along + m.length)),
          minY: Math.min(...layer.members.map((m) => m.across)), maxY: Math.max(...layer.members.map((m) => m.across)),
        }
        if (latticeSize(layer.module, b) * layer.members.length > UNITS_GUARD) {
          blockers.push(`${layer.name}: a ${fmtFeet(layer.module.along)} by ${fmtFeet(layer.module.across)} module is very small for this area. Check the recipe's units`)
          continue
        }
        for (const [, , dx, dy] of lattice(layer.module, b, c)) {
          let touched = false
          for (const m of layer.members) {
            const y = m.across + dy
            if (y < b.minY || y > b.maxY) continue
            const x0 = m.along + dx, x1 = x0 + m.length
            if (x1 < b.minX || x0 > b.maxX) continue
            for (const [s, e] of lineIntervals(region, y)) {
              if (onBoundary(region, s, e, y)) continue
              const a = Math.max(s, x0), z = Math.min(e, x1)
              if (z - a <= Math.max(1e-6, snap)) continue
              touched = true
              // Within the snap of whole is whole, and is ordered at its full length.
              const whole = m.length - (z - a) <= Math.max(1e-6, snap)
              const piece: RunPiece = { a: { x: a, y }, b: { x: z, y }, length: whole ? m.length : z - a, full: whole }
              addRun(acc, layer, piece)
              shape(layer.id, 'segment', [piece.a, piece.b], !piece.full, layer.width)
            }
          }
          if (touched) acc.modules++
        }
        continue
      }
      if (layer.kind === 'lines') {
        const across = layer.run === 'across'
        // Lines across the pattern: lay them in a frame turned a quarter, then turn back.
        const reg = across ? region.map((r) => r.map((p) => ({ x: p.y, y: p.x }))) : region
        const bb = across ? { minX: b.minY, maxX: b.maxY, minY: b.minX, maxY: b.maxX } : b
        const count = (bb.maxY - bb.minY) / layer.spacing
        if (count > UNITS_GUARD) {
          blockers.push(`${layer.name}: ${fmtFeet(layer.spacing)} spacing is very small for this area. Check the recipe's units`)
          continue
        }
        const k0 = Math.floor((bb.minY - layer.offset) / layer.spacing)
        const k1 = Math.ceil((bb.maxY - layer.offset) / layer.spacing)
        for (let k = k0; k <= k1; k++) {
          const y = layer.offset + k * layer.spacing
          for (const [s, e] of lineIntervals(reg, y)) {
            if (onBoundary(reg, s, e, y)) continue
            const a0 = { x: s, y }, b0 = { x: e, y }
            const a = across ? { x: a0.y, y: a0.x } : a0
            const z = across ? { x: b0.y, y: b0.x } : b0
            const piece: RunPiece = { a, b: z, length: e - s, full: true }
            addRun(acc, layer, piece)
            shape(layer.id, 'segment', [a, z], false, layer.width)
          }
        }
        continue
      }
      if (layer.kind === 'hardware') continue
      // Built-in: its own engine counted it; take its geometry for hardware.
      const geo = builtIn.find((g) => g.layerId === layer.id)
      if (geo === undefined) continue
      for (const p of geo.polygons) {
        if (p.pageId !== group.pageId) continue
        const local = p.points.map(toLocal)
        const cx = local.reduce((s, q) => s + q.x, 0) / local.length
        const cy = local.reduce((s, q) => s + q.y, 0) / local.length
        if (cx < b.minX - EPS || cx > b.maxX + EPS || cy < b.minY - EPS || cy > b.maxY + EPS) continue
        acc.polys.push(local)
      }
      for (const s of geo.segments) {
        if (s.pageId !== group.pageId) continue
        const a = toLocal(s.a), z = toLocal(s.b)
        const mid = { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 }
        if (!insideRegion(mid, region)) continue
        acc.runs.push({ a, b: z, length: Math.hypot(z.x - a.x, z.y - a.y), full: true })
      }
    }

    // Hardware, per group: it needs this group's geometry.
    for (const layer of recipe.layers) {
      if (layer.kind !== 'hardware') continue
      const keys = hardwareKeys(layer)
      layer.items.forEach((it, index) => {
        const key = keys[index]!
        hardwareLayer.set(key, layer.name)
        const add = (n: number) => hardwareTotals.set(key, (hardwareTotals.get(key) ?? 0) + n)
        // Every layer named in `of` (700 Bay: one splice item over four member layers).
        const sources = it.per === 'crossing' ? [] : it.of.map((id) => ({ id, acc: accs.get(id) }))
        for (const { id: srcId, acc: src } of sources.length > 0 ? sources : [{ id: '', acc: undefined }]) {
        switch (it.per) {
          case 'piece': {
            if (src === undefined) break
            if (src.kind === 'tiles') { add(src.polys.length * it.qty); break }
            if (src.runs.length > 0) {
              for (const r of src.runs) add(it.over > 0 && r.length > it.over + 1e-9 ? it.qtyOver : it.qty)
            } else add(src.polys.length * it.qty)
            break
          }
          case 'module': break // summed from layer modules below
          case 'along': {
            if (src === undefined || !(it.every > 0)) break
            for (const r of src.runs) {
              const usable = r.length - 2 * it.fromEnds
              const count = usable <= 1e-9 ? 1 : Math.ceil(usable / it.every - 1e-9) + 1
              add(count * it.qty)
              const ux = (r.b.x - r.a.x) / (r.length || 1), uy = (r.b.y - r.a.y) / (r.length || 1)
              for (let q = 0; q < count; q++) {
                const t = usable <= 1e-9 ? r.length / 2 : Math.min(r.length - it.fromEnds, it.fromEnds + q * usable / Math.max(1, count - 1))
                shape(layer.id, 'point', [{ x: r.a.x + ux * t, y: r.a.y + uy * t }], false)
              }
            }
            break
          }
          case 'joint': {
            if (src === undefined) break
            add(jointsOf(src, recipe.layers.find((l) => l.id === srcId)!) * it.qty)
            break
          }
          case 'crossing': {
            const A = accs.get(it.of[0] ?? ''), B = accs.get(it.of[1] ?? '')
            if (A === undefined || B === undefined) break
            const edges: Array<[Point, Point]> = []
            for (const poly of B.polys) for (let k = 0; k < poly.length; k++) edges.push([poly[k]!, poly[(k + 1) % poly.length]!])
            for (const r of B.runs) edges.push([r.a, r.b])
            const seen = new Set<string>()
            for (const r of A.runs) {
              for (const [c0, c1] of edges) {
                const p = segmentCross(r.a, r.b, c0, c1)
                if (p === null || !insideRegion(p, region)) continue
                const k = `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`
                if (seen.has(k)) continue
                seen.add(k)
                shape(layer.id, 'point', [p], false)
              }
            }
            add(seen.size * it.qty)
            break
          }
          case 'edge': {
            const lengths = trimEdgeLengths(region)
            add(it.stock > 0 ? trimPiecesForEdges(lengths, it.stock) * it.qty : lengths.reduce((s, x) => s + x, 0) * it.qty)
            break
          }
          case 'area': break // from the total area below
        }
        if (it.per === 'crossing' || it.per === 'edge' || it.per === 'area') break
        }
      })
    }
  }

  // Quantities, layer by layer in recipe order.
  const quantities: PatternQuantity[] = []
  const r1 = (x: number) => Math.round(x * 10) / 10
  for (const layer of recipe.layers) {
    const acc = accs.get(layer.id)!
    if (layer.kind === 'tiles') {
      let ordered = 0, covered = 0, orderedArea = 0
      for (const [name, t] of acc.tileCounts) {
        const cut = t.cutFractions.length
        const order = layer.cuts === 'whole'
          ? t.placed
          : layer.cuts === 'halves'
            ? t.full + roundUpQuantity(t.cutFractions.reduce((s, f) => s + (f <= 0.5 + 1e-9 ? 0.5 : 1), 0))
            : t.full + roundUpQuantity(t.cutFractions.reduce((s, f) => s + f, 0))
        ordered += order
        covered += t.coveredArea
        orderedArea += order * t.tileArea
        const k = `${layer.id}.${slugOf(name)}`
        quantities.push({ itemKey: k, label: name, quantity: order, unit: 'EA', layer: layer.name })
        // Only when some were cut: with none, "whole" repeats the line above (700 Bay, 2026-11-27).
        if (cut > 0) quantities.push({ itemKey: `${k}.whole`, label: `${name}, whole`, quantity: t.full, unit: 'EA', layer: layer.name, detail: true })
        quantities.push({ itemKey: `${k}.cut`, label: `${name}, cut at the edge`, quantity: cut, unit: 'EA', layer: layer.name, detail: true })
      }
      if (ordered > 0 && orderedArea > 0) {
        quantities.push({ itemKey: `${layer.id}.waste`, label: 'Waste', quantity: r1(Math.max(0, (orderedArea - covered) / orderedArea * 100)), unit: '%', layer: layer.name, detail: true })
      }
      continue
    }
    if (layer.kind === 'members' || layer.kind === 'lines') {
      quantities.push({ itemKey: `${layer.id}.count`, label: layer.name, quantity: acc.runCount, unit: 'EA', layer: layer.name })
      quantities.push({ itemKey: `${layer.id}.length`, label: `${layer.name}, length`, quantity: r1(acc.runLength), unit: 'LF', layer: layer.name })
      if (layer.stock > 0) quantities.push({ itemKey: `${layer.id}.stock`, label: `${layer.name}, ${fmtFeet(layer.stock)} stock`, quantity: orderStockPieceCount(acc.stockFractions), unit: 'EA', layer: layer.name })
      if (layer.partLength > 0) quantities.push({ itemKey: `${layer.id}.parts`, label: `${layer.name}, ${fmtFeet(layer.partLength)} parts`, quantity: acc.parts, unit: 'EA', layer: layer.name })
      if (layer.kind === 'members') quantities.push({ itemKey: `${layer.id}.modules`, label: 'Modules', quantity: acc.modules, unit: 'EA', layer: layer.name, detail: true })
      continue
    }
    if (layer.kind === 'hardware') {
      const keys = hardwareKeys(layer)
      for (const [index, it] of layer.items.entries()) {
        const key = keys[index]!
        let q = hardwareTotals.get(key) ?? 0
        if (it.per === 'module') q = it.of.reduce((n, id) => n + (accs.get(id)?.modules ?? 0), 0) * it.qty
        if (it.per === 'area') q = Math.ceil(areaSquareFeet / it.every - 1e-9) * it.qty
        q = it.unit === 'LF' ? r1(q) : roundUpQuantity(q)
        quantities.push({ itemKey: key, label: it.name, quantity: q, unit: it.unit, layer: layer.name })
      }
    }
  }
  return { quantities: quantities.filter((q) => q.quantity > 0 || !q.detail), shapes, blockers, areaSquareFeet }
}

/**
 * One key per hardware item. Two items with the same name used to share one
 * key and so each reported the pooled total (700 Bay: 4 x 18 splices instead
 * of 6 + 6 + 3 + 3); a repeated name now gets its own key.
 */
export function hardwareKeys(layer: { id: string; items: ReadonlyArray<{ name: string }> }): string[] {
  const seen = new Map<string, number>()
  return layer.items.map((it) => {
    const base = `${layer.id}.${slugOf(it.name)}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}-${n}`
  })
}

function addRun(acc: LayerAcc, layer: ResolvedLayer & ResolvedRunMaterial, piece: RunPiece): void {
  acc.runs.push(piece)
  acc.runCount++
  acc.runLength += piece.length
  cutRun(piece.length, layer, acc)
}

function jointsOf(acc: LayerAcc, layer: ResolvedLayer): number {
  // Generic run layers count their joints as they cut; this group's share is
  // what was added since the group began, so count from the runs instead.
  if (layer.kind === 'members' || layer.kind === 'lines') {
    if (!(layer.stock > 0)) return 0
    let j = 0
    for (const r of acc.runs) j += Math.max(0, Math.ceil(r.length / layer.stock - 1e-9) - 1)
    return j
  }
  return 0
}

function fmtFeet(feet: number): string {
  const inches = feet * 12
  if (Math.abs(inches - Math.round(inches)) < 1e-6 && inches < 24) return `${Math.round(inches)}″`
  const ft = Math.floor(feet + 1e-9)
  const rest = Math.round((feet - ft) * 12 * 100) / 100
  return rest === 0 ? `${ft}′` : `${ft}′ ${rest}″`
}
