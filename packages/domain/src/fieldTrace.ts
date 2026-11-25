/**
 * Field tracing: the outline of a hatched or patterned field, read from the
 * pattern itself rather than from a line around it.
 *
 * A Revit RCP draws a wood-slat or baffle ceiling as tens of thousands of
 * short strokes and gives the field no closed boundary of its own: its edge is
 * wherever the strokes stop. The room tracer (trace.ts) floods the free space
 * between lines, so inside a hatch it has nowhere to go ("landed on drawing
 * content"). Hulls built from the strokes break wherever the strokes are
 * dashed: at every grid line, column line and panel joint.
 *
 * This reads the pattern the way an estimator does:
 *
 *   1. LINEWORK. The pattern's direction is the strongest stroke direction
 *      around the point the agent gives. Only strokes in that direction are
 *      drawn into a grid, so grid lines, dimensions, text and the walls at
 *      other angles never enter it.
 *   2. CLOSE then OPEN. The gap between strokes is measured where the agent
 *      pointed (the smallest close that makes the pattern solid), and the
 *      close is twice that, which also bridges the dash breaks. The open
 *      then removes stray single strokes in the same direction (a grid line,
 *      a dimension line) that are not a field.
 *   3. CUTOUTS. Holes left in the field (a column, a light trough, a shaft)
 *      are kept when they are bigger than `minCutoutPoints2`, smaller ones
 *      (a sprinkler symbol, a tag) are filled.
 *   4. THE RENDERED SHEET (optional). The same box as PDFium draws it. It
 *      checks what the linework cannot know: strokes painted over by a white
 *      masking region (Revit does this for shafts and bulkheads) look like
 *      pattern to the linework and blank on the sheet, so a blank patch the
 *      size of a cutout is cut out. And past each edge, if the rendered sheet
 *      shows the same density of ink as inside, the edge may be early and is
 *      reported. With no usable strokes at all (a pattern placed as an
 *      image, or a solid tone), the field is found from the rendered ink.
 *
 * All grid work is bounded by the grid: fixed-pass dilate/erode, one visit per
 * cell for labelling and flooding, and a contour walk that consumes edges.
 */

import { regionArea, type Point, type Polygon } from './geometry.js'
import { boundaryRings, drawSegment, simplifyRing } from './trace.js'

export interface FieldFrame { x0: number; y0: number; x1: number; y1: number }

/** The rendered sheet over exactly `frame`: RGBA (4 channels) or grey (1). */
export interface FieldImage {
  data: ArrayLike<number>
  width: number
  height: number
  channels: 1 | 4
}

export interface FieldTraceOptions {
  /** Grid cell in PDF points. Default: the finest that keeps the grid under `maxCells`, at least 0.75. */
  cellPoints?: number
  /** Default 6,000,000 cells. The cell grows rather than the frame shrinking. */
  maxCells?: number
  /** The pattern's stroke direction in page degrees (0..180, y down). Default: read at the seed. */
  angleDeg?: number
  /** How far a stroke may lean from the pattern direction. Default 2 degrees. */
  angleToleranceDeg?: number
  /** The widest break inside the pattern to bridge, in points. Default: twice the measured stroke gap. */
  bridgePoints?: number
  /** Parts of the pattern narrower than this are not field (a hatched wall, a neck between fields). Default 10 points. */
  minWidthPoints?: number
  /** Also return every other field of the same pattern in the frame. */
  all?: boolean
  /** Holes smaller than this (points squared) are filled. Default 100 (about 1.3 sq ft at 1:100). */
  minCutoutPoints2?: number
  /** With `all`: the smallest other field kept, points squared. Default 1% of the seed's field. */
  minFieldPoints2?: number
  /** Douglas-Peucker tolerance for the outline, points. Default: one cell. */
  simplifyPoints?: number
  /** The rendered sheet over the frame; see the module comment. */
  image?: FieldImage
}

export interface FieldCutout {
  areaPoints2: number
  center: Point
  /** Cut because the rendered sheet is blank there, though the linework has strokes under it. */
  hidden?: boolean
}

export interface TracedField {
  /** Normalized rings, y down: the outer outline first, then each cutout. */
  rings: Polygon[]
  areaPoints2: number
  /** The field the seed point is in. */
  seed: boolean
  cutouts: FieldCutout[]
  /** Holes under `minCutoutPoints2` that were filled. */
  filledHoles: number
  /** What the rendered sheet says about this field, when it was given. */
  visual?: {
    /** Mean ink inside, 0 (white) to 1 (black). */
    insideInk: number
    /** Share of a band just outside the edge whose ink looks like the inside. 0 is a clean edge. */
    edgeContinues: number
    /** Share of the field the sheet shows blank. */
    blankInside: number
  }
}

export interface FieldTraceDiagnostics {
  source: 'linework' | 'image'
  angleDeg: number | null
  /** Strokes in the pattern direction, and all strokes read. */
  patternSegments: number
  segments: number
  /** The stroke gap measured at the seed, points. */
  strokeGapPoints: number
  bridgePoints: number
  cellPoints: number
  gridWidth: number
  gridHeight: number
  ms: number
}

export type FieldTraceResult =
  | { ok: true; fields: TracedField[]; diagnostics: FieldTraceDiagnostics }
  | {
    ok: false
    reason: 'no-pattern' | 'seed-not-in-pattern' | 'seed-outside-frame' | 'empty-frame'
    message: string
    diagnostics: FieldTraceDiagnostics
  }

export interface FieldTraceInput {
  /** Flat x1,y1,x2,y2 in normalized page coordinates, y down. */
  segments: ArrayLike<number>
  page: { width: number; height: number }
  /** A point inside the field, normalized. */
  seed: Point
  /** The box searched, normalized. */
  frame: FieldFrame
  options?: FieldTraceOptions
  now?: () => number
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** Smallest difference between two directions, in degrees (0..90). */
export function angleGap(a: number, b: number): number {
  const d = Math.abs((((a - b) % 180) + 180) % 180)
  return d > 90 ? 180 - d : d
}

/**
 * Dilation by a (2rx+1) x (2ry+1) box: separable, O(w*h) whatever the radii.
 * The grid is aligned with the pattern, so x runs along the strokes and y
 * across them, and the two radii mean different things.
 */
export function dilateXY(src: Uint8Array, w: number, h: number, rx: number, ry: number): Uint8Array {
  let mid = src
  if (rx > 0) {
    mid = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      const row = y * w
      let last = -1 - rx
      for (let x = 0; x < w; x++) {
        if (src[row + x]) last = x
        if (x - last <= rx) mid[row + x] = 1
      }
      last = w + rx
      for (let x = w - 1; x >= 0; x--) {
        if (src[row + x]) last = x
        if (last - x <= rx) mid[row + x] = 1
      }
    }
  }
  if (ry <= 0) return mid === src ? src.slice() : mid
  const out = new Uint8Array(w * h)
  for (let x = 0; x < w; x++) {
    let last = -1 - ry
    for (let y = 0; y < h; y++) {
      if (mid[y * w + x]) last = y
      if (y - last <= ry) out[y * w + x] = 1
    }
    last = h + ry
    for (let y = h - 1; y >= 0; y--) {
      if (mid[y * w + x]) last = y
      if (last - y <= ry) out[y * w + x] = 1
    }
  }
  return out
}

/** Erosion as dilation of the complement; outside the grid reads as set, so a field running off the frame keeps its edge. */
export function erodeXY(src: Uint8Array, w: number, h: number, rx: number, ry: number): Uint8Array {
  const inv = new Uint8Array(w * h)
  for (let i = 0; i < inv.length; i++) inv[i] = src[i] ? 0 : 1
  const grown = dilateXY(inv, w, h, rx, ry)
  for (let i = 0; i < grown.length; i++) grown[i] = grown[i] ? 0 : 1
  return grown
}

const closeXY = (src: Uint8Array, w: number, h: number, rx: number, ry: number) => erodeXY(dilateXY(src, w, h, rx, ry), w, h, rx, ry)
const openXY = (src: Uint8Array, w: number, h: number, rx: number, ry: number) => dilateXY(erodeXY(src, w, h, rx, ry), w, h, rx, ry)

/** 4-connected labels of set cells. Returns labels (0 = unset) and each label's cell count. */
export function labelCells(mask: Uint8Array, w: number, h: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(w * h)
  const sizes: number[] = [0]
  const stack = new Int32Array(w * h)
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue
    const id = sizes.length
    let top = 0
    let count = 0
    stack[top++] = start
    labels[start] = id
    while (top > 0) {
      const i = stack[--top]!
      count++
      const x = i % w
      if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = id; stack[top++] = i - 1 }
      if (x < w - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = id; stack[top++] = i + 1 }
      if (i >= w && mask[i - w] && !labels[i - w]) { labels[i - w] = id; stack[top++] = i - w }
      if (i < w * (h - 1) && mask[i + w] && !labels[i + w]) { labels[i + w] = id; stack[top++] = i + w }
    }
    sizes.push(count)
  }
  return { labels, sizes }
}

/** Mean of `v` over a (2r+1)^2 box at every cell, from a summed-area table. */
function boxMean(v: Float32Array, w: number, h: number, r: number): Float32Array {
  const sat = new Float64Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += v[y * w + x]!
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1]! + row
    }
  }
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1)
      const s = sat[yb * (w + 1) + xb]! - sat[ya * (w + 1) + xb]! - sat[yb * (w + 1) + xa]! + sat[ya * (w + 1) + xa]!
      out[y * w + x] = s / ((yb - ya) * (xb - xa))
    }
  }
  return out
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = values.slice().sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

/**
 * The strongest stroke directions around the seed: a histogram in half-degree
 * bins, each stroke weighted by its length up to `capPoints`, so thousands of
 * short hatch strokes outweigh the one long wall beside them. Up to three
 * peaks at least 5 degrees apart, strongest first.
 */
export function patternAngles(
  segs: Float64Array, n: number, sx: number, sy: number, radius: number, capPoints: number,
): { angles: Array<{ angle: number; weight: number }>; count: number } {
  const bins = new Float64Array(360)
  let count = 0
  for (let i = 0; i < n; i++) {
    const ax = segs[i * 4]!, ay = segs[i * 4 + 1]!, bx = segs[i * 4 + 2]!, by = segs[i * 4 + 3]!
    const mx = (ax + bx) / 2 - sx, my = (ay + by) / 2 - sy
    if (mx * mx + my * my > radius * radius) continue
    const len = Math.hypot(bx - ax, by - ay)
    if (len < 0.2) continue
    let a = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI
    a = ((a % 180) + 180) % 180
    bins[Math.min(359, Math.floor(a * 2))] = bins[Math.min(359, Math.floor(a * 2))]! + Math.min(len, capPoints)
    count++
  }
  const smooth = new Float64Array(360)
  for (let b = 0; b < 360; b++) for (let k = -2; k <= 2; k++) smooth[b] = smooth[b]! + bins[(b + k + 360) % 360]!
  const angles: Array<{ angle: number; weight: number }> = []
  const taken = new Uint8Array(360)
  for (let pick = 0; pick < 3; pick++) {
    let best = -1, bestW = 0
    for (let b = 0; b < 360; b++) if (!taken[b] && smooth[b]! > bestW) { bestW = smooth[b]!; best = b }
    if (best < 0) break
    // Weighted mean inside the peak, unwrapped around it.
    let sw = 0, sa = 0
    for (let k = -2; k <= 2; k++) {
      const wgt = bins[(best + k + 360) % 360]!
      sw += wgt
      sa += wgt * ((best + k) / 2 + 0.25)
    }
    angles.push({ angle: (((sw > 0 ? sa / sw : best / 2) % 180) + 180) % 180, weight: bestW })
    for (let k = -10; k <= 10; k++) taken[(best + k + 360) % 360] = 1
  }
  return { angles, count }
}

/** A grid aligned with the pattern: x along the strokes, y across them. */
interface PatternGrid {
  cos: number
  sin: number
  u0: number
  v0: number
  w: number
  h: number
  c: number
}

function patternGrid(angleDeg: number, box: { x0: number; y0: number; x1: number; y1: number }, c: number): PatternGrid {
  const cos = Math.cos((angleDeg * Math.PI) / 180), sin = Math.sin((angleDeg * Math.PI) / 180)
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
  for (const [x, y] of [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]] as const) {
    const u = x * cos + y * sin, v = -x * sin + y * cos
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v)
  }
  return { cos, sin, u0, v0, w: Math.max(1, Math.ceil((u1 - u0) / c)), h: Math.max(1, Math.ceil((v1 - v0) / c)), c }
}

const gridX = (g: PatternGrid, x: number, y: number) => (x * g.cos + y * g.sin - g.u0) / g.c
const gridY = (g: PatternGrid, x: number, y: number) => (-x * g.sin + y * g.cos - g.v0) / g.c
/** Page point (points) of a grid position (cell units, corners at integers). */
function gridPoint(g: PatternGrid, gx: number, gy: number): Point {
  const u = g.u0 + gx * g.c, v = g.v0 + gy * g.c
  return { x: u * g.cos - v * g.sin, y: u * g.sin + v * g.cos }
}

/** Which cells of the grid fall inside the box (points). */
function boxCells(g: PatternGrid, box: { x0: number; y0: number; x1: number; y1: number }): Uint8Array {
  const m = new Uint8Array(g.w * g.h)
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const p = gridPoint(g, x + 0.5, y + 0.5)
      if (p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1) m[y * g.w + x] = 1
    }
  }
  return m
}

/** The rendered sheet as ink on the grid (0 white, 1 black): each cell reads the pixel under its centre. */
function inkOnGrid(img: FieldImage, g: PatternGrid, box: { x0: number; y0: number; x1: number; y1: number }): Float32Array {
  const ink = new Float32Array(g.w * g.h)
  const sx = img.width / (box.x1 - box.x0), sy = img.height / (box.y1 - box.y0)
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const p = gridPoint(g, x + 0.5, y + 0.5)
      const px = Math.floor((p.x - box.x0) * sx), py = Math.floor((p.y - box.y0) * sy)
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue
      const at = (py * img.width + px) * img.channels
      const lum = img.channels === 1 ? img.data[at]!
        : 0.299 * img.data[at]! + 0.587 * img.data[at + 1]! + 0.114 * img.data[at + 2]!
      ink[y * g.w + x] = 1 - lum / 255
    }
  }
  return ink
}

export function traceField(input: FieldTraceInput): FieldTraceResult {
  const now = input.now ?? defaultNow
  const t0 = now()
  const o = input.options ?? {}
  const pageW = input.page.width > 0 ? input.page.width : 1
  const pageH = input.page.height > 0 ? input.page.height : 1
  const box = {
    x0: clamp(Math.min(input.frame.x0, input.frame.x1), 0, 1) * pageW, y0: clamp(Math.min(input.frame.y0, input.frame.y1), 0, 1) * pageH,
    x1: clamp(Math.max(input.frame.x0, input.frame.x1), 0, 1) * pageW, y1: clamp(Math.max(input.frame.y0, input.frame.y1), 0, 1) * pageH,
  }
  const fw = box.x1 - box.x0, fh = box.y1 - box.y0
  const maxCells = Math.max(10_000, o.maxCells ?? 8_000_000)
  // The cell is the finest that keeps the turned grid under maxCells. Until
  // the direction is known, assume the worst turn (45 degrees).
  const cellFor = (deg: number): number => {
    const a = (deg * Math.PI) / 180, ca = Math.abs(Math.cos(a)), sa = Math.abs(Math.sin(a))
    return Math.max(o.cellPoints ?? 0, 0.75, Math.sqrt(((fw * ca + fh * sa) * (fw * sa + fh * ca)) / maxCells))
  }
  let c = cellFor(45)
  const nSeg = Math.floor(input.segments.length / 4)
  const diag: FieldTraceDiagnostics = {
    source: 'linework', angleDeg: null, patternSegments: 0, segments: nSeg,
    strokeGapPoints: 0, bridgePoints: 0, cellPoints: c, gridWidth: 0, gridHeight: 0, ms: 0,
  }
  const fail = (reason: 'no-pattern' | 'seed-not-in-pattern' | 'seed-outside-frame' | 'empty-frame', message: string): FieldTraceResult => {
    diag.ms = now() - t0
    return { ok: false, reason, message, diagnostics: diag }
  }
  if (!(fw > 0 && fh > 0)) return fail('empty-frame', 'the box to search has no area')
  const sx = input.seed.x * pageW, sy = input.seed.y * pageH
  if (!(sx >= box.x0 && sx <= box.x1 && sy >= box.y0 && sy <= box.y1)) return fail('seed-outside-frame', 'the point is outside the box searched')

  const segs = new Float64Array(nSeg * 4)
  for (let i = 0; i < nSeg * 4; i += 4) {
    segs[i] = input.segments[i]! * pageW
    segs[i + 1] = input.segments[i + 1]! * pageH
    segs[i + 2] = input.segments[i + 2]! * pageW
    segs[i + 3] = input.segments[i + 3]! * pageH
  }
  const tol = o.angleToleranceDeg ?? 2
  const inFamily = (i: number, a0: number): boolean => {
    const ax = segs[i * 4]!, ay = segs[i * 4 + 1]!, bx = segs[i * 4 + 2]!, by = segs[i * 4 + 3]!
    if (Math.hypot(bx - ax, by - ay) < 0.2) return false
    return angleGap((Math.atan2(by - ay, bx - ax) * 180) / Math.PI, a0) <= tol
  }
  /** Draw a direction's strokes that reach `within` into the grid; returns how many. */
  const drawFamily = (g: PatternGrid, a0: number, within: { x0: number; y0: number; x1: number; y1: number }): { mask: Uint8Array; count: number } => {
    const mask = new Uint8Array(g.w * g.h)
    let count = 0
    for (let i = 0; i < nSeg; i++) {
      const ax = segs[i * 4]!, ay = segs[i * 4 + 1]!, bx = segs[i * 4 + 2]!, by = segs[i * 4 + 3]!
      if (Math.max(ax, bx) < within.x0 || Math.min(ax, bx) > within.x1 || Math.max(ay, by) < within.y0 || Math.min(ay, by) > within.y1) continue
      if (!inFamily(i, a0)) continue
      if (drawSegment(mask, g.w, g.h, gridX(g, ax, ay), gridY(g, ax, ay), gridX(g, bx, by), gridY(g, bx, by))) count++
    }
    return { mask, count }
  }

  // ---- 1. the pattern direction, and how far apart its strokes are at the
  // seed. Of the strongest directions there, the one whose strokes close
  // into a solid pattern with the smallest gap wins: a slat ceiling has a
  // second direction (panel joints, omega bars) as strong but far sparser.
  const half = Math.max(28, 24 * c)
  const win = { x0: Math.max(box.x0, sx - half), y0: Math.max(box.y0, sy - half), x1: Math.min(box.x1, sx + half), y1: Math.min(box.y1, sy + half) }
  const fillCurve = (a0: number): number[] => {
    const g = patternGrid(a0, win, c)
    const { mask, count } = drawFamily(g, a0, win)
    if (count === 0) return []
    const inside = boxCells(g, win)
    let cells = 0
    for (let i = 0; i < inside.length; i++) cells += inside[i]!
    const out: number[] = []
    for (let r = 1; r <= Math.max(2, Math.ceil(12 / c)); r++) {
      const closed = closeXY(mask, g.w, g.h, 2 * r, r)
      let s = 0
      for (let i = 0; i < closed.length; i++) s += closed[i]! & inside[i]!
      out.push(cells > 0 ? s / cells : 0)
    }
    return out
  }
  const gapOf = (fills: number[]): number => {
    const top = fills.length > 0 ? Math.max(...fills) : 0
    return top >= 0.3 ? 1 + fills.findIndex((f) => f >= 0.9 * top) : Infinity
  }
  let angle: number | null = null
  let fills: number[] = []
  if (Number.isFinite(o.angleDeg)) {
    angle = ((o.angleDeg! % 180) + 180) % 180
    fills = fillCurve(angle)
  } else {
    for (let radius = Math.max(20, 30 * c); radius <= 640 && angle === null; radius *= 2) {
      const pa = patternAngles(segs, nSeg, sx, sy, radius, Math.max(3, 4 * c))
      if (pa.count < 24) continue
      let bestGap = Infinity
      for (const cand of pa.angles) {
        if (cand.weight < 0.15 * pa.angles[0]!.weight) continue
        const f = fillCurve(cand.angle)
        const gap = gapOf(f)
        if (gap < bestGap) { bestGap = gap; angle = cand.angle; fills = f }
      }
      if (angle === null && pa.angles.length > 0) { angle = pa.angles[0]!.angle; fills = fillCurve(angle) }
    }
  }
  diag.angleDeg = angle === null ? null : Math.round(angle * 100) / 100
  if (angle !== null && cellFor(angle) < c) {
    c = cellFor(angle)
    diag.cellPoints = c
    fills = fillCurve(angle)
  }

  // ---- 2. the pattern on a grid turned to it
  const g = patternGrid(angle ?? 0, box, c)
  const { w, h } = g
  diag.gridWidth = w
  diag.gridHeight = h
  const inBox = boxCells(g, box)
  const ink = o.image !== undefined && o.image.width > 0 && o.image.height > 0 ? inkOnGrid(o.image, g, box) : null
  const drawn = angle === null ? { mask: new Uint8Array(w * h), count: 0 } : drawFamily(g, angle, box)
  diag.patternSegments = drawn.count
  let base = drawn.mask
  let source: 'linework' | 'image' = 'linework'
  let rFill = gapOf(fills)
  const sgx = Math.floor(gridX(g, sx, sy)), sgy = Math.floor(gridY(g, sx, sy))
  if (!Number.isFinite(rFill)) {
    if (ink === null) {
      return fail('no-pattern', angle === null
        ? 'there are no strokes around that point'
        : `the strokes at that point (${Math.round(angle)} degrees) are too far apart to be a hatch; give bridgePoints, or use trace_area for a room`)
    }
    // No usable strokes: read the field off the rendered sheet instead.
    source = 'image'
    const blur = boxMean(ink, w, h, Math.max(2, Math.ceil(3 / c)))
    const around: number[] = []
    const rw = Math.ceil(half / c)
    for (let y = Math.max(0, sgy - rw); y < Math.min(h, sgy + rw); y++) {
      for (let x = Math.max(0, sgx - rw); x < Math.min(w, sgx + rw); x++) if (inBox[y * w + x]) around.push(blur[y * w + x]!)
    }
    const at = median(around)
    if (!(at > 0.04)) return fail('no-pattern', 'there is no pattern or tone at that point, on the linework or on the rendered sheet')
    base = new Uint8Array(w * h)
    for (let i = 0; i < base.length; i++) base[i] = blur[i]! >= 0.5 * at && blur[i]! <= 2 * at ? 1 : 0
    rFill = 1
  }
  diag.source = source
  diag.strokeGapPoints = Math.round(2 * rFill * c * 100) / 100
  // Across the strokes, close only the gap between neighbours. Along them,
  // further: a dashed stroke breaks at every grid line, column line and panel
  // joint, and its next dash is on the same line.
  const ry = o.bridgePoints !== undefined && o.bridgePoints > 0 ? Math.max(1, Math.ceil(o.bridgePoints / (2 * c))) : rFill
  const rx = Math.max(2 * ry, Math.ceil(4 / c))
  // The open drops anything narrower than `minWidthPoints`: a single stroke,
  // a hatched wall, a neck joining two fields through a wall's poche.
  const rOpen = Math.max(ry, Math.round((o.minWidthPoints ?? 10) / (2 * c)))
  diag.bridgePoints = Math.round(2 * ry * c * 100) / 100

  // ---- 3. solid fields
  const solid = openXY(closeXY(base, w, h, rx, ry), w, h, rOpen, rOpen)
  for (let i = 0; i < solid.length; i++) solid[i] = solid[i]! & inBox[i]!
  const { labels, sizes } = labelCells(solid, w, h)

  let seedLabel = sgx >= 0 && sgy >= 0 && sgx < w && sgy < h ? labels[sgy * w + sgx]! : 0
  if (seedLabel === 0) {
    // The point is on a column or a tag inside the field: take the nearest field cell.
    const reach = 3 * Math.max(rx, rOpen) + 3
    let bestD = Infinity
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const x = sgx + dx, y = sgy + dy
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        const l = labels[y * w + x]!
        const d = dx * dx + dy * dy
        if (l !== 0 && d < bestD) { bestD = d; seedLabel = l }
      }
    }
  }
  if (seedLabel === 0) {
    return fail('seed-not-in-pattern', 'the point is not inside a hatched field (the nearest pattern is too thin or too far)')
  }

  // Pattern density per field (raw stroke cells per cell), to keep `all` to the same pattern.
  const rawCount = new Float64Array(sizes.length)
  const bbox = new Int32Array(sizes.length * 4)
  for (let l = 1; l < sizes.length; l++) { bbox[l * 4] = w; bbox[l * 4 + 1] = h; bbox[l * 4 + 2] = -1; bbox[l * 4 + 3] = -1 }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x]!
      if (l === 0) continue
      rawCount[l] = rawCount[l]! + base[y * w + x]!
      if (x < bbox[l * 4]!) bbox[l * 4] = x
      if (y < bbox[l * 4 + 1]!) bbox[l * 4 + 1] = y
      if (x > bbox[l * 4 + 2]!) bbox[l * 4 + 2] = x
      if (y > bbox[l * 4 + 3]!) bbox[l * 4 + 3] = y
    }
  }
  const density = (l: number) => rawCount[l]! / sizes[l]!
  const seedDensity = density(seedLabel)
  const chosen = [seedLabel]
  if (o.all === true) {
    const minCells = (o.minFieldPoints2 ?? 0.01 * sizes[seedLabel]! * c * c) / (c * c)
    for (let l = 1; l < sizes.length; l++) {
      if (l === seedLabel || sizes[l]! < minCells) continue
      const d = density(l)
      if (!(d >= 0.5 * seedDensity && d <= 2 * seedDensity)) continue
      // Another field must be at least twice `minWidthPoints` across somewhere:
      // a wall drawn with the same hatch is a long strip, not a ceiling.
      // One empty cell around it: the erosion reads outside its grid as set.
      const bx0 = bbox[l * 4]! - 1, by0 = bbox[l * 4 + 1]! - 1, bw = bbox[l * 4 + 2]! - bx0 + 2, bh = bbox[l * 4 + 3]! - by0 + 2
      const sub = new Uint8Array(bw * bh)
      for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) sub[y * bw + x] = labels[(by0 + y) * w + bx0 + x] === l ? 1 : 0
      const core = erodeXY(sub, bw, bh, 2 * rOpen, 2 * rOpen)
      let left = 0
      for (let i = 0; i < core.length; i++) left += core[i]!
      if (left > 0) chosen.push(l)
    }
  }

  const minCutoutCells = (o.minCutoutPoints2 ?? 100) / (c * c)
  const eps = o.simplifyPoints ?? c
  const inkBlur = ink === null ? null : boxMean(ink, w, h, Math.max(1, ry + 1))
  const isChosen = new Uint8Array(sizes.length)
  for (const l of chosen) isChosen[l] = 1
  // A turned cell can poke a fraction of a cell past the box; the outline stays inside it.
  const norm = (p: Point): Point => ({ x: clamp(p.x, box.x0, box.x1) / pageW, y: clamp(p.y, box.y0, box.y1) / pageH })

  const fields: TracedField[] = []
  for (const l of chosen) {
    const bx0 = bbox[l * 4]!, by0 = bbox[l * 4 + 1]!, bx1 = bbox[l * 4 + 2]!, by1 = bbox[l * 4 + 3]!
    // Local grid with a one-cell empty border, so every hole is enclosed.
    const lw = bx1 - bx0 + 3, lh = by1 - by0 + 3
    const local = new Uint8Array(lw * lh)
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) if (labels[y * w + x] === l) local[(y - by0 + 1) * lw + (x - bx0 + 1)] = 1
    }
    const toPoint = (lx: number, ly: number): Point => gridPoint(g, bx0 - 1 + lx, by0 - 1 + ly)
    const globalAt = (lx: number, ly: number) => (by0 - 1 + ly) * w + bx0 - 1 + lx

    // A blank patch on the rendered sheet inside the field: strokes painted
    // over by a white masking region, so not this pattern on the sheet.
    const hiddenCut: FieldCutout[] = []
    let blankCells = 0, insideInkSum = 0, fieldCells = 0, insideMedian = 0
    if (inkBlur !== null && ink !== null) {
      const sample: number[] = []
      for (let y = 1; y < lh - 1; y += 2) for (let x = 1; x < lw - 1; x += 2) if (local[y * lw + x]) sample.push(inkBlur[globalAt(x, y)]!)
      insideMedian = median(sample)
      const blank = new Uint8Array(lw * lh)
      for (let y = 1; y < lh - 1; y++) {
        for (let x = 1; x < lw - 1; x++) {
          if (!local[y * lw + x]) continue
          const at = globalAt(x, y)
          fieldCells++
          insideInkSum += ink[at]!
          if (inkBlur[at]! < 0.1 * insideMedian) { blank[y * lw + x] = 1; blankCells++ }
        }
      }
      if (insideMedian > 0 && blankCells > 0) {
        const bl = labelCells(openXY(blank, lw, lh, rOpen, rOpen), lw, lh)
        for (let k = 1; k < bl.sizes.length; k++) {
          if (bl.sizes[k]! < minCutoutCells) continue
          let cx = 0, cy = 0
          for (let i = 0; i < bl.labels.length; i++) {
            if (bl.labels[i] !== k) continue
            local[i] = 0
            cx += i % lw; cy += Math.floor(i / lw)
          }
          hiddenCut.push({ areaPoints2: bl.sizes[k]! * c * c, center: norm(toPoint(cx / bl.sizes[k]! + 0.5, cy / bl.sizes[k]! + 0.5)), hidden: true })
        }
      }
    }

    // Holes: empty cells the border flood cannot reach.
    const outside = new Uint8Array(lw * lh)
    for (let i = 0; i < local.length; i++) outside[i] = local[i] ? 0 : 1
    const hl = labelCells(outside, lw, lh)
    const borderLabel = hl.labels[0]!
    const holeSum = new Float64Array(hl.sizes.length * 2)
    for (let i = 0; i < hl.labels.length; i++) {
      const k = hl.labels[i]!
      if (k === 0 || k === borderLabel) continue
      holeSum[k * 2] = holeSum[k * 2]! + i % lw
      holeSum[k * 2 + 1] = holeSum[k * 2 + 1]! + Math.floor(i / lw)
    }
    const cutouts: FieldCutout[] = []
    let filled = 0
    const fillHole = new Uint8Array(hl.sizes.length)
    for (let k = 1; k < hl.sizes.length; k++) {
      if (k === borderLabel) continue
      if (hl.sizes[k]! < minCutoutCells) { fillHole[k] = 1; filled++; continue }
      const ctr = norm(toPoint(holeSum[k * 2]! / hl.sizes[k]! + 0.5, holeSum[k * 2 + 1]! / hl.sizes[k]! + 0.5))
      const near = (hc: FieldCutout) => Math.abs(hc.center.x - ctr.x) * pageW < 3 * c && Math.abs(hc.center.y - ctr.y) * pageH < 3 * c
      if (!hiddenCut.some(near)) cutouts.push({ areaPoints2: hl.sizes[k]! * c * c, center: ctr })
    }
    for (let i = 0; i < hl.labels.length; i++) if (fillHole[hl.labels[i]!]) local[i] = 1

    const rings: Polygon[] = []
    for (const ring of boundaryRings(local, lw, lh, 10_000)) {
      const simple = simplifyRing(ring.map(([lx, ly]) => toPoint(lx, ly)), eps, 20_000)
      if (simple.length >= 3) rings.push(simple)
    }
    if (rings.length === 0) continue
    // Outer outlines first (largest first), then the holes. Turning the grid keeps winding.
    const signed = (r: Polygon) => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i]!, b = r[(i + 1) % r.length]!; s += a.x * b.y - b.x * a.y } return s / 2 }
    const outers = rings.filter((r) => signed(r) > 0).sort((a, b) => signed(b) - signed(a))
    const holes = rings.filter((r) => signed(r) <= 0)
    const ordered = [...outers, ...holes]
    const field: TracedField = {
      rings: ordered.map((r) => r.map(norm)), areaPoints2: regionArea(ordered), seed: l === seedLabel,
      cutouts: [...cutouts, ...hiddenCut].sort((a, b) => b.areaPoints2 - a.areaPoints2), filledHoles: filled,
    }
    if (inkBlur !== null && fieldCells > 0) {
      // A band just past the edge: does the sheet show the same texture there?
      const pad = Math.max(2, 2 * rOpen)
      const ex0 = Math.max(0, bx0 - pad), ey0 = Math.max(0, by0 - pad)
      const ex1 = Math.min(w - 1, bx1 + pad), ey1 = Math.min(h - 1, by1 + pad)
      const ew = ex1 - ex0 + 1, eh = ey1 - ey0 + 1
      const mine = new Uint8Array(ew * eh)
      for (let y = ey0; y <= ey1; y++) for (let x = ex0; x <= ex1; x++) if (labels[y * w + x] === l) mine[(y - ey0) * ew + x - ex0] = 1
      const grown = dilateXY(mine, ew, eh, pad, pad)
      let band = 0, alike = 0
      for (let i = 0; i < grown.length; i++) {
        if (!grown[i] || mine[i]) continue
        const at = (ey0 + Math.floor(i / ew)) * w + ex0 + (i % ew)
        if (!inBox[at] || isChosen[labels[at]!]) continue
        band++
        if (inkBlur[at]! >= 0.6 * insideMedian && inkBlur[at]! <= 1.6 * insideMedian) alike++
      }
      field.visual = {
        insideInk: Math.round((insideInkSum / fieldCells) * 1000) / 1000,
        edgeContinues: band > 0 ? Math.round((alike / band) * 1000) / 1000 : 0,
        blankInside: Math.round((blankCells / fieldCells) * 1000) / 1000,
      }
    }
    fields.push(field)
  }
  if (fields.length === 0) return fail('seed-not-in-pattern', 'the field at that point has no outline')
  fields.sort((a, b) => (a.seed === b.seed ? b.areaPoints2 - a.areaPoints2 : a.seed ? -1 : 1))
  diag.ms = now() - t0
  return { ok: true, fields, diagnostics: diag }
}
