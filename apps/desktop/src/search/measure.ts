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

/**
 * The drawing's own line segments, longest first, from the flat
 * [x1,y1,x2,y2,...] array the geometry reader returns (normalized).
 */
export function linesFromSegments(
  flat: ArrayLike<number>,
  page: { width: number; height: number },
  opts: { feetPerPoint?: number | null; minLengthPoints?: number; limit?: number } = {},
): { lines: Array<{ x1: number; y1: number; x2: number; y2: number; lengthPoints: number; lengthFeet: number | null }>; total: number } {
  const r5 = (n: number) => Math.round(n * 1e5) / 1e5
  const fpp = opts.feetPerPoint ?? null
  const min = opts.minLengthPoints ?? 0
  const all: Array<{ x1: number; y1: number; x2: number; y2: number; lengthPoints: number; lengthFeet: number | null }> = []
  for (let i = 0; i + 3 < flat.length; i += 4) {
    const x1 = flat[i]!, y1 = flat[i + 1]!, x2 = flat[i + 2]!, y2 = flat[i + 3]!
    const len = Math.hypot((x2 - x1) * page.width, (y2 - y1) * page.height)
    if (len < min) continue
    all.push({ x1: r5(x1), y1: r5(y1), x2: r5(x2), y2: r5(y2), lengthPoints: r3(len), lengthFeet: fpp === null ? null : r3(len * fpp) })
  }
  all.sort((a, b) => b.lengthPoints - a.lengthPoints)
  return { lines: all.slice(0, opts.limit ?? 500), total: all.length }
}
