/** Project domain markups into viewer overlay primitives. */
import { areaRegion, type Markup, type Scope } from '@redbeam/domain'
import type { OverlaySet } from '@redbeam/viewer'

const FALLBACK = '#8a929c'
/** Links: the blue every reader uses for one. */
export const LINK_COLOR = '#1a73e8'

/**
 * `pending`: markups not yet accepted (imported from the PDF). They are drawn
 * dashed with a faint fill, so a takeoff that counts reads differently from
 * one waiting on somebody's yes.
 */
export function toOverlay(markups: Markup[], scopes: Scope[], pending: ReadonlySet<string> = new Set()): OverlaySet {
  const colorOf = new Map(scopes.map((s) => [s.id, s.color]))
  const set: OverlaySet = { polygons: [], lines: [], dots: [] }

  for (const m of markups) {
    const color = (m.scopeId ? colorOf.get(m.scopeId) : undefined) ?? FALLBACK
    // An area is its outline less its cuts (cuts.ts): drawn as that shape,
    // so a cut across the edge is a notch and not a ring drawn outside it.
    const region = m.kind === 'area' && m.rings.length > 1 ? areaRegion(m.rings) : m.rings
    const ring = region[0]
    if (!ring || ring.length === 0) continue
    const waiting = pending.has(m.id)

    if (m.kind === 'area' || m.kind === 'cutout' || m.kind === 'shape') {
      let cx = 0, cy = 0
      for (const p of ring) { cx += p.x; cy += p.y }
      cx /= ring.length; cy /= ring.length
      set.polygons.push({
        poly: ring.map((p) => [p.x, p.y] as [number, number]),
        // An area's further rings are its holes: drawn as openings in its fill.
        ...(m.kind === 'area' && region.length > 1
          ? { holes: region.slice(1).map((r) => r.map((p) => [p.x, p.y] as [number, number])) }
          : {}),
        fill: color,
        stroke: color,
        // cutouts read as openings: no fill, dashed edge
        // A shape is the HIGHLIGHT tool. It is annotation, not measured
        // material, and it reaches no quantity — but at 8% it could not be
        // seen on a white sheet at all, so "Highlight" looked like a tool that
        // did nothing. The Qt build painted highlights at 0.35 with a multiply
        // blend; a 0.32 fill and no stroke is the nearest the overlay draws,
        // and it reads as marker rather than as billed area precisely because
        // it has no edge.
        fillOpacity: m.kind === 'cutout' ? 0 : m.kind === 'shape' ? 0.32 : waiting ? 0.06 : 0.16,
        strokeOpacity: m.kind === 'shape' ? 0 : m.kind === 'cutout' ? 1 : 0.9,
        // A cutout is an opening: no fill, and a SOLID edge heavier than the
        // area's, so it reads as a hole cut in the material rather than as a
        // hidden line. It was dashed; Aaron, 2026-09-11: "the cutout should
        // be bolder and solid".
        strokeWidth: m.kind === 'cutout' ? 2 : 1.4,
        dashed: waiting,
        cx,
        cy,
      })
    } else if (m.kind === 'polyline') {
      // one overlay line per segment so long polylines stay visible
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1]!, b = ring[i]!
        set.lines.push({
          x1: a.x, y1: a.y, x2: b.x, y2: b.y,
          color, opacity: 1, width: 2, dashed: waiting,
        })
      }
    } else if (m.kind === 'link') {
      // A link (tools/links.ts): a thin dashed box in the link blue, no fill,
      // so it says "this jumps" without covering the callout it sits on.
      set.polygons.push({
        poly: ring.map((p) => [p.x, p.y] as [number, number]),
        fill: LINK_COLOR, stroke: LINK_COLOR,
        fillOpacity: 0.06, strokeOpacity: 0.9, strokeWidth: 1, dashed: true,
        cx: ring.reduce((a, p) => a + p.x, 0) / ring.length,
        cy: ring.reduce((a, p) => a + p.y, 0) / ring.length,
      })
    } else if (m.kind === 'count') {
      const a = ring[0]!
      set.dots.push({ x: a.x, y: a.y, color, opacity: 1, r: 5, shape: 'circle' })
    }
  }
  return set
}
