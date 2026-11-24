/**
 * Snapshots of the takeoff, planned before anything is drawn.
 *
 * Aaron, 2026-11-24: "vectorized snapshots of each takeoff area … get
 * everything to be proportionally scaled so it isn't a hundred different
 * scales for each of the snapshots. Make it look organized. Dim the line work
 * of the drawing and then make the area takeoff be the star of the show." And:
 * "the products within the area boundary should be bright and bold, and then
 * the offcuts that extend beyond the boundary should be faded."
 *
 * So the export carries one picture per takeoff AREA, not one per sheet, and
 * this module decides, for each:
 *
 *  - the scale it is printed at. There are at most two in the whole export,
 *    both from the ladder of architectural scales (1/4", 1/8", 1/16", …):
 *    the BASE, the largest at which the biggest area fits a page, which every
 *    picture is printed at, so a 10' room is half the size of a 20' one the
 *    way it is on the plan; and one DETAIL scale for takeoff that would print
 *    smaller than 3/4" at the base, shared by all of it;
 *  - the window on the sheet it shows: the area, the stock that hangs past
 *    its edge, and a margin of drawing for context. The composer may widen
 *    it to fill its row, never changing the scale;
 *  - what is drawn in it: the area as measured (cutouts taken out), the stock
 *    pieces the engine laid out for it in full, and where they are cut.
 *
 * Runs and counts have no area to frame. They are grouped per scope per
 * sheet, nearest first, into pictures that still fit a page at the base.
 *
 * Pure: geometry in, plan out. Coordinates stay normalized to the sheet as
 * displayed ([0,1], y down), the space every markup is stored in, until the
 * page composer turns them into points on paper.
 */
import {
  TRIM_SMOOTH_DEGREES, effectiveAreaRings, pathLength, pointInOrOnRegion, polylineLength, regionArea,
  resolveScaleForRings, trimEdges, trimPiecesForEdges,
  type Markup, type MarkupKind, type PanelCell, type Piece, type Point, type Region,
  type RunLayoutEntry, type ScaleRegion,
} from '@redbeam/domain'

export interface NormPoint { x: number; y: number }
export type NormRing = NormPoint[]
export interface NormBox { x0: number; y0: number; x1: number; y1: number }

export interface PlanMarkup {
  id: string
  scopeId: string | null
  documentId: string
  pageId: string
  kind: string
  rings: ReadonlyArray<ReadonlyArray<NormPoint>>
}

export interface PlanScope { id: string; label: string; color: string }

/** A scope's laid-out product, exactly as the piece engine returned it. */
export interface PlanPieces {
  scopeId: string
  cells: readonly PanelCell[]
  runs: readonly RunLayoutEntry[]
  /** A run product's face width; without it a piece is drawn as a line. */
  componentWidthFeet?: number
  /** Pieces cut at the factory to take a device (issue #12). */
  factoryCut?: { cells: ReadonlySet<PanelCell>; pieces: ReadonlySet<Piece> }
  /**
   * One length of the scope's perimeter trim, feet. Trim is never a takeoff
   * of its own: it is the edge of every laid-out area, cut into these lengths
   * (Aaron, 2026-11-24), so each area's picture draws it there.
   */
  trimLengthFeet?: number
}

export interface PlanSheet {
  /**
   * The page box AS DISPLAYED, in points: what normalized coordinates and the
   * piece engine's points are both taken against.
   */
  width: number
  height: number
  /** Drawing feet per point, or null for a sheet nobody has scaled. */
  feetPerPoint: number | null
  /** Details drawn at their own scale (plan 14.2). */
  regions?: readonly ScaleRegion[]
}

/** A printed scale: export points per drawing foot, and how a drawing names it. */
export interface PrintScale {
  pointsPerFoot: number
  label: string
}

/** One stock piece, whole: drawn bold inside the area and faded past it. */
export interface SnapshotPiece {
  ring: NormRing
  /** Cut at the factory to fit a device: hatched over its colour. */
  factoryCut: boolean
}

/**
 * Perimeter trim on an area's edge, as the takeoff counts it: each edge from
 * corner to corner (a curve is one edge), cut into lengths from its start.
 */
export interface SnapshotTrim {
  /** Where one length meets the next, and which way the edge runs there (a unit vector, sheet axes). */
  joints: Array<{ at: NormPoint; along: NormPoint }>
  /** The lengths this area takes: every edge rounded up on its own. */
  pieces: number
}

/**
 * One piece of a run (a baffle, a blade, a rail), whole, from end to end.
 * The composer strokes it, so a 2" baffle at 1/16" can be kept wide enough
 * to see.
 */
export interface SnapshotBand {
  a: NormPoint
  b: NormPoint
  /** Its face width, sheet points; 0 when the scope does not say. */
  width: number
  factoryCut: boolean
}

export interface SnapshotCard {
  id: string
  scopeId: string
  documentId: string
  pageIndex: number
  pageId: string
  sheetLabel: string
  kind: 'area' | 'line' | 'count'
  /** "Area 2", "Group 1": numbered within the scope in print order. */
  title: string
  /** How many markups the picture shows: one area, or the runs or counts of a group. */
  members: number
  /** The smallest part of the sheet the picture shows; the composer may show more around it. */
  window: NormBox
  /** The middle of the takeoff and its stock, which a wider window stays centred on. */
  focus: NormPoint
  /** The sheet's displayed size in points, so the composer can get back to points. */
  sheetWidth: number
  sheetHeight: number
  /** Export points per sheet point. */
  zoom: number
  /** Null when the sheet has no scale: the picture is then "not to scale". */
  scale: PrintScale | null
  /** The picture's size on paper, points. */
  width: number
  height: number
  quantity: { value: number; unit: string } | null
  /** The area as measured: outline, its holes, overlapping cutouts taken out. */
  region: NormRing[]
  /** The product laid out in this area, each piece whole. */
  pieces: SnapshotPiece[]
  /** Run pieces, each whole: bold inside, faded past. */
  bands: SnapshotBand[]
  /** Where two pieces of a run meet: a joiner, drawn as a tick across the run. */
  seams: Array<[NormPoint, NormPoint]>
  /** The area's perimeter trim, when its scope counts trim and the area is laid out. */
  trim: SnapshotTrim | null
  /** Polylines (line pictures). */
  lines: NormRing[]
  /** Count positions (count pictures). */
  points: NormPoint[]
}

export interface SnapshotPlan {
  cards: SnapshotCard[]
  /** The scale the pictures share; null when nothing is scaled. */
  base: PrintScale | null
  /** The one larger scale small takeoff is printed at, when any is. */
  detail: PrintScale | null
}

export interface PlanOptions {
  /** Scopes in the export, in its order. Takeoff of any other scope is ignored. */
  scopes: readonly PlanScope[]
  markups: readonly PlanMarkup[]
  pieces: readonly PlanPieces[]
  sheet: (pageId: string) => PlanSheet | null
  sheetLabelFor: (pageId: string) => string
  /** Where a page sits in the set, for reading order. Defaults to the page index. */
  sheetOrder?: (pageId: string) => number
  /** Where a drawing sits among the project's, for reading order. Defaults to its id. */
  documentOrder?: (documentId: string) => number
  /** The largest picture a page can hold, points. */
  frame: { width: number; height: number }
  /** The smallest picture worth printing; its caption needs the width. */
  minPicture?: { width: number; height: number }
}

/**
 * The ladder. Each step is half the one before, so any two pictures in the
 * export compare by a power of two, and each is a scale an estimator has a
 * scale rule for. Labels are ASCII: the export's standard font has no prime.
 */
export const SCALE_LADDER: readonly PrintScale[] = [
  { pointsPerFoot: 36, label: '1/2" = 1\'-0"' },
  { pointsPerFoot: 18, label: '1/4" = 1\'-0"' },
  { pointsPerFoot: 9, label: '1/8" = 1\'-0"' },
  { pointsPerFoot: 4.5, label: '1/16" = 1\'-0"' },
  { pointsPerFoot: 2.25, label: '1/32" = 1\'-0"' },
  { pointsPerFoot: 1.125, label: '1/64" = 1\'-0"' },
  { pointsPerFoot: 0.5625, label: '1/128" = 1\'-0"' },
]

/** Never printed larger than this: a closet at 1/2" is all wall. */
const LARGEST = 1 // index into SCALE_LADDER: 1/4"
/**
 * Takeoff whose longer side would print shorter than this (three quarters of
 * an inch) at the base scale is printed at the detail scale instead.
 */
const SMALL_PT = 54
/** The detail scale goes no larger than 1/8" unless the base is already there. */
const DETAIL_CAP_PPF = 9
/**
 * Drawing kept around the takeoff, feet: `min` to `max` as it grows, but
 * down to `tight` rather than drop the whole export a scale for one area.
 */
const MARGIN_FEET = { tight: 1.5, min: 3, max: 8 } as const
/** Runs or counts further apart than this never share a picture, feet. */
const GROUP_GAP_FEET = 30
/** For a sheet with no scale: the same idea in plain magnifications. */
const ZOOM_LADDER = [1, 0.5, 0.25, 0.125, 0.0625, 0.03125]

const TAKEOFF_KINDS = new Set<string>(['area', 'cutout', 'polyline', 'count'])

/** Zero-based page index out of a page id, which is `${documentId}-p${n}`. */
export function pageIndexOf(pageId: string): number | null {
  const m = /-p(\d+)$/.exec(pageId)
  return m === null ? null : Number(m[1])
}

interface Box { x0: number; y0: number; x1: number; y1: number }

const emptyBox = (): Box => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
const grow = (b: Box, p: Point) => {
  if (p.x < b.x0) b.x0 = p.x
  if (p.y < b.y0) b.y0 = p.y
  if (p.x > b.x1) b.x1 = p.x
  if (p.y > b.y1) b.y1 = p.y
}
const isBox = (b: Box) => b.x1 >= b.x0 && b.y1 >= b.y0

/** A subject before it has a scale: what it is and how big, in sheet points. */
interface Subject {
  scopeId: string
  pageId: string
  documentId: string
  kind: SnapshotCard['kind']
  markups: PlanMarkup[]
  sheet: PlanSheet
  feetPerPoint: number | null
  /** The takeoff itself, sheet points. */
  core: Box
  /** The takeoff plus every piece of stock drawn for it, sheet points. */
  content: Box
  region: Region
  pieces: SnapshotPiece[]
  bands: SnapshotBand[]
  seams: Array<[NormPoint, NormPoint]>
  trim: SnapshotTrim | null
  quantity: SnapshotCard['quantity']
}

const toNorm = (p: Point, s: PlanSheet): NormPoint => ({ x: p.x / s.width, y: p.y / s.height })

function asMarkup(m: PlanMarkup): Markup {
  return {
    id: m.id, scopeId: m.scopeId, documentId: m.documentId, pageId: m.pageId,
    kind: m.kind as MarkupKind,
    rings: m.rings.map((r) => r.map((p) => ({ x: p.x, y: p.y }))),
  }
}

/** The band a run piece occupies: its full segment, `width` across, in sheet points. */
function band(a: Point, b: Point, width: number): Point[] | null {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (!(len > 0) || !(width > 0)) return null
  const nx = (-dy / len) * (width / 2), ny = (dx / len) * (width / 2)
  return [
    { x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny },
    { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny },
  ]
}

function centroid(ring: readonly Point[]): Point | null {
  if (ring.length === 0) return null
  let x = 0, y = 0
  for (const p of ring) { x += p.x; y += p.y }
  return { x: x / ring.length, y: y / ring.length }
}

/**
 * Whether a laid-out cell belongs to this area. A cell's clipped region lies
 * inside the region it was laid out against, which can span several areas of
 * the scope on one sheet; it belongs to the one its covered part touches.
 */
function cellTouches(cell: PanelCell, region: Region, regionBox: Box): boolean {
  const rings = cell.clippedRegion.length > 0 ? cell.clippedRegion : [cell.fullPath]
  for (const ring of rings) {
    const c = centroid(ring)
    const probes = c === null ? ring : [c, ...ring]
    for (const p of probes) {
      if (p.x < regionBox.x0 - 0.5 || p.x > regionBox.x1 + 0.5 || p.y < regionBox.y0 - 0.5 || p.y > regionBox.y1 + 0.5) continue
      if (pointInOrOnRegion(p, region, 0.05)) return true
    }
  }
  return false
}

/** Everything one area subject draws, gathered from its scope's layout on its sheet. */
function areaProduct(
  pageId: string,
  region: Region,
  sheet: PlanSheet,
  product: PlanPieces | undefined,
  content: Box,
): Pick<Subject, 'pieces' | 'bands' | 'seams'> {
  const pieces: SnapshotPiece[] = []
  const bands: SnapshotBand[] = []
  const seams: Array<[NormPoint, NormPoint]> = []
  if (product === undefined) return { pieces, bands, seams }
  const regionBox = emptyBox()
  for (const ring of region) for (const p of ring) grow(regionBox, p)

  for (const cell of product.cells) {
    if (cell.pageId !== undefined && cell.pageId !== pageId) continue
    if (!cellTouches(cell, region, regionBox)) continue
    const stock = cell.stockPath.length >= 3 ? cell.stockPath : cell.fullPath
    if (stock.length < 3) continue
    for (const p of stock) grow(content, p)
    pieces.push({ ring: stock.map((p) => toNorm(p, sheet)), factoryCut: product.factoryCut?.cells.has(cell) ?? false })
  }

  for (const entry of product.runs) {
    if (entry.pageId !== pageId) continue
    const fpp = entry.feetPerPoint > 0 ? entry.feetPerPoint : sheet.feetPerPoint ?? 0
    const width = (product.componentWidthFeet ?? 0) > 0 && fpp > 0 ? product.componentWidthFeet! / fpp : 0
    for (const piece of entry.layout.pieces) {
      const mid = {
        x: (piece.insideSegment.a.x + piece.insideSegment.b.x) / 2,
        y: (piece.insideSegment.a.y + piece.insideSegment.b.y) / 2,
      }
      if (!pointInOrOnRegion(mid, region, 0.05)) continue
      const { a, b } = piece.fullSegment
      for (const p of band(a, b, width) ?? [a, b]) grow(content, p)
      bands.push({ a: toNorm(a, sheet), b: toNorm(b, sheet), width, factoryCut: product.factoryCut?.pieces.has(piece) ?? false })
      // A piece that does not start its run starts at a joiner.
      if (!piece.startCap) {
        const s = piece.insideSegment.a, e = piece.insideSegment.b
        const dx = e.x - s.x, dy = e.y - s.y
        const len = Math.hypot(dx, dy)
        if (len > 0) {
          const half = Math.max(width, 0) / 2
          if (half > 0) {
            const nx = (-dy / len) * half, ny = (dx / len) * half
            seams.push([toNorm({ x: s.x + nx, y: s.y + ny }, sheet), toNorm({ x: s.x - nx, y: s.y - ny }, sheet)])
          }
        }
      }
    }
  }
  return { pieces, bands, seams }
}

/** How far a polyline turns at its vertex `b`, degrees. */
function turnAt(a: Point, b: Point, c: Point): number {
  let turn = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x)) * 180 / Math.PI
  if (turn > 180) turn = 360 - turn
  return turn
}

/**
 * Perimeter trim along an area, in the domain's own terms (trimEdges,
 * trimPiecesForEdges), so the picture and the quantities count the same
 * lengths: each edge runs from its corner in whole lengths and the last one
 * is cut to fit. `region` is in sheet points; `fpp` is its scale.
 */
function trimAlong(region: Region, trimLengthFeet: number, fpp: number, sheet: PlanSheet): SnapshotTrim {
  const edges = trimEdges(region)
  const pieces = trimPiecesForEdges(edges.map((e) => pathLength(e) * fpp), trimLengthFeet)
  const step = trimLengthFeet / fpp
  const joints: SnapshotTrim['joints'] = []
  const at = (a: Point, b: Point, t: number) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    joints.push({
      at: toNorm({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, sheet),
      along: { x: (b.x - a.x) / len, y: (b.y - a.y) / len },
    })
  }
  for (const edge of edges) {
    const total = pathLength(edge)
    const lengths = Math.ceil((total * fpp) / trimLengthFeet - 1e-9)
    const first = edge[0]!, last = edge[edge.length - 1]!
    // An edge that closes on itself with no corner (a round room) starts at
    // a joint, not at a corner, so that joint is drawn too.
    const smooth = edge.length > 3 && first.x === last.x && first.y === last.y
      && turnAt(edge[edge.length - 2]!, first, edge[1]!) < TRIM_SMOOTH_DEGREES
    if (smooth && lengths > 1) at(edge[0]!, edge[1]!, 0)
    let k = 1
    let walked = 0
    for (let i = 1; i < edge.length && k < lengths; i++) {
      const a = edge[i - 1]!, b = edge[i]!
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      while (k < lengths && k * step <= walked + len + 1e-9) {
        if (len > 0) at(a, b, (k * step - walked) / len)
        k++
      }
      walked += len
    }
  }
  return { joints, pieces }
}

/** A run or a count before it is grouped into a picture. */
interface Loose {
  markup: PlanMarkup
  /** Its extent, sheet points. */
  box: Box
  feetPerPoint: number | null
}

/** Runs or counts of one scope on one sheet, waiting to be grouped. */
interface LooseSet {
  scopeId: string
  pageId: string
  documentId: string
  kind: 'line' | 'count'
  sheet: PlanSheet
  items: Loose[]
}

const boxGap = (a: Box, b: Box) => Math.hypot(
  Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1)),
  Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1)),
)
const union = (a: Box, b: Box): Box => ({
  x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
})
const scaled = (fpp: number | null): fpp is number => fpp !== null && fpp > 0

/**
 * Group runs or counts into pictures: those that sit near one another share
 * one, as long as the group still fits a page at the export's scale. The
 * nearest pair joins first, so a group grows along a corridor before it
 * reaches across a room.
 */
function groupLoose(items: Loose[], maxGap: number, fits: (b: Box, fpp: number | null) => boolean): Loose[][] {
  const groups = items.map((i) => ({ members: [i], box: { ...i.box }, fpp: i.feetPerPoint }))
  // Pair by pair is cubic; hundreds of counts on a sheet take the greedy road.
  if (items.length > 150) {
    const out: typeof groups = []
    for (const g of [...groups].sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0)) {
      const home = out.find((h) => h.fpp === g.fpp && boxGap(h.box, g.box) <= maxGap && fits(union(h.box, g.box), h.fpp))
      if (home === undefined) out.push(g)
      else {
        home.members.push(...g.members)
        home.box = union(home.box, g.box)
      }
    }
    return out.map((g) => g.members)
  }
  for (;;) {
    let best: { a: number; b: number; gap: number } | null = null
    for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        const A = groups[a]!, B = groups[b]!
        if (A.fpp !== B.fpp) continue
        const gap = boxGap(A.box, B.box)
        if (gap > maxGap || (best !== null && gap >= best.gap)) continue
        if (!fits(union(A.box, B.box), A.fpp)) continue
        best = { a, b, gap }
      }
    }
    if (best === null) break
    const A = groups[best.a]!, B = groups[best.b]!
    A.members.push(...B.members)
    A.box = union(A.box, B.box)
    groups.splice(best.b, 1)
  }
  return groups.map((g) => g.members)
}

/**
 * The drawing kept around the takeoff, sheet points: a few feet, more for a
 * big area, never so much that it decides the scale.
 */
function marginPts(content: Box, fpp: number | null, tight = false): number {
  const longest = Math.max(content.x1 - content.x0, content.y1 - content.y0)
  if (!scaled(fpp)) return tight ? 12 : Math.max(24, longest * 0.05)
  if (tight) return MARGIN_FEET.tight / fpp
  return Math.min(MARGIN_FEET.max, Math.max(MARGIN_FEET.min, longest * fpp * 0.04)) / fpp
}

/**
 * Whether `content` fits the frame at `zoom` export points per sheet point,
 * with the tight margin: the window then takes what margin the frame leaves.
 */
function fitsFrame(content: Box, fpp: number | null, zoom: number, frame: PlanOptions['frame']): boolean {
  const m = marginPts(content, fpp, true)
  return (content.x1 - content.x0 + 2 * m) * zoom <= frame.width + 1e-6
    && (content.y1 - content.y0 + 2 * m) * zoom <= frame.height + 1e-6
}

/** The largest ladder step at which `content` fits the frame. */
function fitStep(content: Box, fpp: number, frame: PlanOptions['frame']): number {
  for (let i = LARGEST; i < SCALE_LADDER.length; i++) {
    if (fitsFrame(content, fpp, SCALE_LADDER[i]!.pointsPerFoot * fpp, frame)) return i
  }
  return SCALE_LADDER.length - 1
}

function fitZoom(content: Box, frame: PlanOptions['frame']): number {
  for (let i = 0; i < ZOOM_LADDER.length; i++) if (fitsFrame(content, null, ZOOM_LADDER[i]!, frame)) return i
  return ZOOM_LADDER.length - 1
}

/**
 * Plan every picture for the export.
 *
 * Cards come back grouped by scope, in the export's scope order; within a
 * scope by sheet, the taller pictures first so the composer can fill its rows
 * with pictures of a height, and otherwise in reading order. They are
 * numbered in that order, which is the order they print in.
 */
export function planSnapshots(opts: PlanOptions): SnapshotPlan {
  const minW = opts.minPicture?.width ?? 180
  const minH = opts.minPicture?.height ?? 96
  const frame = opts.frame
  const inExport = new Set(opts.scopes.map((s) => s.id))
  const takeoff = opts.markups.filter((m) =>
    m.scopeId !== null && inExport.has(m.scopeId) && TAKEOFF_KINDS.has(m.kind) && pageIndexOf(m.pageId) !== null)
  const productOf = new Map(opts.pieces.map((p) => [p.scopeId, p]))

  // 1. Each area is a subject. Runs and counts wait, one by one, to be grouped.
  const subjects: Subject[] = []
  const loose: LooseSet[] = []
  for (const scope of opts.scopes) {
    const mine = takeoff.filter((m) => m.scopeId === scope.id)
    const pages = [...new Set(mine.map((m) => m.pageId))]
    for (const pageId of pages) {
      const sheet = opts.sheet(pageId)
      if (sheet === null || !(sheet.width > 0) || !(sheet.height > 0)) continue
      const here = mine.filter((m) => m.pageId === pageId)
      const cutouts = here.filter((m) => m.kind === 'cutout')
      const pageCal = { feetPerPoint: sheet.feetPerPoint ?? 1, pageWidth: sheet.width, pageHeight: sheet.height }
      const fppOf = (rings: PlanMarkup['rings']) => sheet.feetPerPoint === null
        ? null
        : resolveScaleForRings(rings, sheet.regions ?? [], sheet.feetPerPoint).feetPerPoint
      const boxOf = (rings: PlanMarkup['rings']) => {
        const b = emptyBox()
        for (const r of rings) for (const p of r) grow(b, { x: p.x * sheet.width, y: p.y * sheet.height })
        return b
      }

      for (const area of here.filter((m) => m.kind === 'area')) {
        const outline = area.rings[0]
        if (outline === undefined || outline.length < 3) continue
        const region = effectiveAreaRings([asMarkup(area), ...cutouts.map(asMarkup)], pageCal)
        if (region.length === 0) continue
        const fpp = fppOf(area.rings)
        const core = boxOf([outline])
        const content = { ...core }
        const scopeProduct = productOf.get(scope.id)
        const product = areaProduct(pageId, region, sheet, scopeProduct, content)
        // Trim is counted only where the scope is laid out, so it is drawn only there.
        const trimFeet = scopeProduct?.trimLengthFeet ?? 0
        const laidOut = product.pieces.length > 0 || product.bands.length > 0
        subjects.push({
          scopeId: scope.id, pageId, documentId: area.documentId, kind: 'area', markups: [area], sheet,
          feetPerPoint: fpp, core, content, region, ...product,
          trim: laidOut && trimFeet > 0 && scaled(fpp) ? trimAlong(region, trimFeet, fpp, sheet) : null,
          quantity: scaled(fpp) ? { value: regionArea(region) * fpp * fpp, unit: 'SF' } : null,
        })
      }

      for (const kind of ['polyline', 'count'] as const) {
        const items = here
          .filter((m) => m.kind === kind && (m.rings[0]?.length ?? 0) > 0)
          .map((m) => ({ markup: m, box: boxOf([m.rings[0]!]), feetPerPoint: fppOf([m.rings[0]!]) }))
        if (items.length === 0) continue
        loose.push({
          scopeId: scope.id, pageId, documentId: items[0]!.markup.documentId,
          kind: kind === 'count' ? 'count' : 'line', sheet, items,
        })
      }
    }
  }

  /*
   * 2. The base scale: the largest step of the ladder at which every area,
   * and every run or count on its own, fits a page with its margin. Sheets
   * nobody scaled get the same treatment in plain magnifications.
   */
  let baseStep = LARGEST
  let baseZoom = 0
  let anyScaled = false
  const consider = (content: Box, fpp: number | null) => {
    if (!isBox(content)) return
    if (scaled(fpp)) {
      anyScaled = true
      baseStep = Math.max(baseStep, fitStep(content, fpp, frame))
    } else {
      baseZoom = Math.max(baseZoom, fitZoom(content, frame))
    }
  }
  for (const s of subjects) consider(s.content, s.feetPerPoint)
  for (const set of loose) for (const it of set.items) consider(it.box, it.feetPerPoint)
  const zoomAtBase = (fpp: number | null) => (scaled(fpp) ? SCALE_LADDER[baseStep]!.pointsPerFoot * fpp : ZOOM_LADDER[baseZoom]!)

  // 3. Runs and counts, grouped into pictures that fit a page at the base.
  for (const set of loose) {
    const sheet = set.sheet
    const maxGap = scaled(sheet.feetPerPoint) ? GROUP_GAP_FEET / sheet.feetPerPoint : sheet.width * 0.06
    const groups = groupLoose(set.items, maxGap, (b, fpp) => fitsFrame(b, fpp, zoomAtBase(fpp), frame))
    for (const members of groups) {
      const core = members.reduce((b, m) => union(b, m.box), emptyBox())
      const fpp = members[0]!.feetPerPoint
      const quantity = set.kind === 'count'
        ? { value: members.length, unit: 'EA' }
        : scaled(fpp)
          ? { value: members.reduce((n, m) => n + polylineLength([...m.markup.rings[0]!], sheet.width, sheet.height), 0) * fpp, unit: 'LF' }
          : null
      subjects.push({
        scopeId: set.scopeId, pageId: set.pageId, documentId: set.documentId, kind: set.kind,
        markups: members.map((m) => m.markup), sheet, feetPerPoint: fpp, core, content: { ...core },
        region: [], pieces: [], bands: [], seams: [], trim: null, quantity,
      })
    }
  }

  /*
   * 4. The detail scale, for takeoff too small to read at the base: ONE step
   * for all of it, the largest at which every such picture fits, and no more
   * than twice the base or 1/8", whichever is larger. A closet does not get
   * its own scale.
   */
  const longestAt = (s: Subject, zoom: number) => Math.max(s.core.x1 - s.core.x0, s.core.y1 - s.core.y0) * zoom
  const small = new Set(subjects.filter((s) => isBox(s.core) && longestAt(s, zoomAtBase(s.feetPerPoint)) < SMALL_PT))
  let detailStep: number | null = null
  const smallScaled = [...small].filter((s) => scaled(s.feetPerPoint))
  if (smallScaled.length > 0) {
    const cap = Math.max(2 * SCALE_LADDER[baseStep]!.pointsPerFoot, DETAIL_CAP_PPF)
    for (let i = LARGEST; i < baseStep && detailStep === null; i++) {
      const ppf = SCALE_LADDER[i]!.pointsPerFoot
      if (ppf > cap + 1e-9) continue
      if (smallScaled.every((s) => fitsFrame(s.content, s.feetPerPoint, ppf * s.feetPerPoint!, frame))) detailStep = i
    }
  }
  let detailZoom: number | null = null
  const smallUnscaled = [...small].filter((s) => !scaled(s.feetPerPoint))
  if (smallUnscaled.length > 0) {
    const cap = Math.max(2 * ZOOM_LADDER[baseZoom]!, 1)
    for (let i = 0; i < baseZoom && detailZoom === null; i++) {
      const z = ZOOM_LADDER[i]!
      if (z > cap + 1e-9) continue
      if (smallUnscaled.every((s) => fitsFrame(s.content, null, z, frame))) detailZoom = i
    }
  }

  // 5. A card per subject: its scale, and the window that frames it.
  const cards: SnapshotCard[] = []
  for (const s of subjects) {
    if (!isBox(s.content)) continue
    const sheet = s.sheet
    let scale: PrintScale | null = null
    let zoom: number
    if (scaled(s.feetPerPoint)) {
      scale = SCALE_LADDER[small.has(s) && detailStep !== null ? detailStep : baseStep]!
      zoom = scale.pointsPerFoot * s.feetPerPoint
    } else {
      zoom = ZOOM_LADDER[small.has(s) && detailZoom !== null ? detailZoom : baseZoom]!
    }
    const margin = marginPts(s.content, s.feetPerPoint)
    const cx = (s.content.x0 + s.content.x1) / 2
    const cy = (s.content.y0 + s.content.y1) / 2
    const w = Math.min(Math.max(s.content.x1 - s.content.x0 + 2 * margin, minW / zoom), frame.width / zoom)
    const h = Math.min(Math.max(s.content.y1 - s.content.y0 + 2 * margin, minH / zoom), frame.height / zoom)
    const x0 = placeOn(cx, w, sheet.width)
    const y0 = placeOn(cy, h, sheet.height)
    cards.push({
      id: `${s.kind}-${s.markups.map((m) => m.id).join('+')}`,
      scopeId: s.scopeId,
      documentId: s.documentId,
      pageIndex: pageIndexOf(s.pageId) ?? 0,
      pageId: s.pageId,
      sheetLabel: opts.sheetLabelFor(s.pageId),
      kind: s.kind,
      title: '',
      members: s.markups.length,
      window: { x0: x0 / sheet.width, y0: y0 / sheet.height, x1: (x0 + w) / sheet.width, y1: (y0 + h) / sheet.height },
      focus: { x: cx / sheet.width, y: cy / sheet.height },
      sheetWidth: sheet.width,
      sheetHeight: sheet.height,
      zoom,
      scale,
      width: w * zoom,
      height: h * zoom,
      quantity: s.quantity,
      region: s.region.map((r) => r.map((p) => toNorm(p, sheet))),
      pieces: s.pieces,
      bands: s.bands,
      seams: s.seams,
      trim: s.trim,
      lines: s.kind === 'line' ? s.markups.map((m) => m.rings[0]!.map((p) => ({ x: p.x, y: p.y }))) : [],
      points: s.kind === 'count' ? s.markups.map((m) => ({ x: m.rings[0]![0]!.x, y: m.rings[0]![0]!.y })) : [],
    })
  }

  // 6. Print order, and a number for each picture in it.
  const order = opts.sheetOrder ?? ((pageId: string) => pageIndexOf(pageId) ?? 0)
  const rank = new Map(opts.scopes.map((s, i) => [s.id, i]))
  const band = frame.height / 6
  const size = (c: SnapshotCard) => Math.floor(c.height / band)
  cards.sort((a, b) =>
    (rank.get(a.scopeId)! - rank.get(b.scopeId)!)
    || (opts.documentOrder?.(a.documentId) ?? 0) - (opts.documentOrder?.(b.documentId) ?? 0)
    || a.documentId.localeCompare(b.documentId)
    || order(a.pageId) - order(b.pageId)
    || kindRank(a.kind) - kindRank(b.kind)
    || size(b) - size(a)
    // Rows a tenth of the sheet tall: two ceilings side by side read left to
    // right even when one sits a little lower.
    || Math.floor(a.focus.y * 10) - Math.floor(b.focus.y * 10)
    || a.focus.x - b.focus.x)
  const counters = new Map<string, number>()
  for (const c of cards) {
    const key = `${c.scopeId}|${c.kind === 'area' ? 'area' : 'group'}`
    const n = (counters.get(key) ?? 0) + 1
    counters.set(key, n)
    c.title = c.kind === 'area' ? `Area ${n}` : `Group ${n}`
  }
  return {
    cards,
    base: anyScaled ? SCALE_LADDER[baseStep]! : null,
    detail: detailStep !== null && cards.some((c) => c.scale === SCALE_LADDER[detailStep!]) ? SCALE_LADDER[detailStep]! : null,
  }
}

/** Where a window of `size` starts along a sheet `extent` long: on the sheet if it can be, centred if not. */
function placeOn(centre: number, size: number, extent: number): number {
  if (size >= extent) return (extent - size) / 2
  return Math.min(Math.max(centre - size / 2, 0), extent - size)
}

const kindRank = (k: SnapshotCard['kind']) => (k === 'area' ? 0 : k === 'line' ? 1 : 2)

/** A round length for a scale bar about `targetPts` long at `pointsPerFoot`. */
export function scaleBarFeet(pointsPerFoot: number, targetPts = 56): number {
  const steps = [1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 40, 50, 64, 80, 100, 128, 160, 200, 250, 320, 400, 500]
  const want = targetPts / pointsPerFoot
  let best = steps[0]!
  for (const s of steps) if (Math.abs(s - want) < Math.abs(best - want)) best = s
  return best
}
