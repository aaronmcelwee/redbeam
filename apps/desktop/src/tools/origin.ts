/**
 * The Origin tool: which area a click sets the pattern start for, and where (#69).
 *
 * Setting an area's 0,0 was a right-click on the area. The tool is one click,
 * and the click has already been snapped to what is drawn by the time it
 * arrives here, so landing on a corner of the ceiling is landing on it.
 */
import {
  normalizedBoundingRect, patternStartPoint, pointInOrOnRegion,
  type Markup, type PatternStartSnap, type Point,
} from '@redbeam/domain'

export interface OriginPick<M extends Markup = Markup> {
  markup: M
  /** Where the pattern starts, normalized: on a corner or edge within reach, else the click. */
  point: Point
}

/**
 * The area a click is for, and the start point it gives that area.
 *
 * An area counts when the click is inside it or on its boundary, or when a
 * corner or edge of it is within `snap.radius` pixels (a click just outside
 * the corner still means that corner). Several can qualify: an area of the
 * active scope beats one of another scope, then the smaller area beats the
 * larger, so a soffit drawn inside a room's ceiling can be picked at all.
 */
export function pickOriginArea<M extends Markup>(
  click: Point,
  markups: readonly M[],
  activeScopeId: string | null,
  snap: PatternStartSnap,
): OriginPick<M> | null {
  let best: { pick: OriginPick<M>; active: boolean; size: number } | null = null
  for (const m of markups) {
    if (m.kind !== 'area' || m.scopeId === null) continue
    const point = patternStartPoint(click, m.rings, snap)
    if (point === null) continue
    const inside = pointInOrOnRegion(click, m.rings)
    const near = Math.hypot((point.x - click.x) * snap.scaleX, (point.y - click.y) * snap.scaleY) <= snap.radius
    if (!inside && !near) continue
    const rect = normalizedBoundingRect(m.rings)
    const size = rect === null ? Infinity : (rect.right - rect.left) * (rect.bottom - rect.top)
    const active = m.scopeId === activeScopeId
    if (best === null
      || (active && !best.active)
      || (active === best.active && size < best.size)) {
      best = { pick: { markup: m, point }, active, size }
    }
  }
  return best?.pick ?? null
}
