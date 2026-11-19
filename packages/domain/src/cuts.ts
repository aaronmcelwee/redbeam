/**
 * Cutouts as cuts of the area itself.
 *
 * Aaron, 2026-11-19: "The cutter should make a boolean edit to the markup
 * itself. It shouldn't be treated as a separate markup." And: "If a single
 * cutout crosses multiple markups, it should make corresponding boolean edits
 * to each markup, but I should be able to select that one cutout and delete
 * it and have it reverse those boolean edits."
 *
 * So an area markup's rings are `[outline, ...cuts]`. Each cut is the ring as
 * the cutter drew it, unclipped: it may run across the outline (a notch) or
 * overlap another cut. What the area IS, for measuring, drawing and hit
 * testing, is `areaRegion(rings)`: the outline less its cuts. The cut moves
 * with the area because it is part of it, and it goes to Bluebeam as Revu's
 * own /Cutouts, which is the same model.
 *
 * One cutout across several areas is the same ring in each of them. The
 * desktop finds them by equal geometry and shows them as one cutout to
 * select, drag or delete (apps/desktop/src/cutouts.ts).
 */

import type { Point, Polygon, Region } from './geometry.js'
import { cutAreas, ringsOverlap } from './clip.js'
import { regionArea } from './geometry.js'

/**
 * The material of one area from its stored rings: the outline less every
 * cut. A plain outline comes back as is, vertex order and all.
 */
export function areaRegion(rings: ReadonlyArray<ReadonlyArray<Point>>): Region {
  const usable = rings.filter((r) => r.length >= 3).map((r) => r.map((p) => ({ x: p.x, y: p.y })))
  if (usable.length <= 1) return usable
  return cutAreas([usable])
}

/** Two rings with the same points in the same order, within `eps`. */
export function sameRing(a: Polygon, b: Polygon, eps = 1e-6): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]!.x - b[i]!.x) > eps || Math.abs(a[i]!.y - b[i]!.y) > eps) return false
  }
  return true
}

/**
 * Whether cutting `ring` out of an area with these rings removes anything
 * and leaves something. An area the cut misses is not cut, and one the cut
 * would swallow whole is left for the estimator to delete instead.
 */
export function cutChanges(rings: readonly Polygon[], ring: Polygon): boolean {
  const outline = rings[0]
  if (outline === undefined || outline.length < 3 || ring.length < 3) return false
  if (!ringsOverlap(ring, outline)) return false
  const before = regionArea(areaRegion(rings))
  const after = regionArea(areaRegion([...rings, ring]))
  return after > 1e-12 && after < before - 1e-12
}
