/**
 * Cutouts as cuts of the area itself.
 *
 * Aaron, 2026-11-19: "The cutter should make a boolean edit to the markup
 * itself. It shouldn't be treated as a separate markup."
 *
 * So an area markup's rings are `[outline, ...cuts]`. Each cut is the ring as
 * the cutter left it in that area: trimmed to the outline by the cutter, but
 * Bluebeam's and older ones may run across it (a notch) or overlap another.
 * What the area IS, for measuring, drawing and hit testing, is
 * `areaRegion(rings)`: the outline less its cuts. The cut moves
 * with the area because it is part of it, and it goes to Bluebeam as Revu's
 * own /Cutouts, which is the same model.
 *
 * The cutter is a one-shot boolean (Aaron, 2026-11-19: "act as a Boolean
 * operation on each Markup and then disappear"): each area it crosses gets
 * its own copy trimmed to its edge, and the copies are not tied together.
 * The desktop offers each hole for deleting on its own
 * (apps/desktop/src/cutouts.ts).
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
