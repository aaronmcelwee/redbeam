/**
 * Polygon booleans, for the one place the takeoff needs them: fitting a
 * cutout to the area it opens.
 *
 * The Qt build subtracted cutouts into a QPainterPath and got clipping for
 * free — a cutout drawn across an area's edge removed only the part inside,
 * and one drawn beside an area removed nothing. This port keeps explicit
 * rings and classifies them by nesting depth (see `regionArea`), which is
 * right for rings that never cross and wrong for a cutout that does: the
 * part of it OUTSIDE the area sits at depth 1 under its own ring alone and
 * even/odd counts it as material. Kenneth, 2026-09-10: "the cutout tool
 * appears to be adding product instead of removing it". This module is the
 * clipping the path used to do.
 *
 * Martinez–Rueda via `polygon-clipping` (MIT). It is the domain's only
 * dependency and it is wrapped here so nothing else in the package knows
 * its coordinate shape, and so it can be swapped for a port later without
 * touching a caller.
 */

import type { Point, Polygon, Region } from './geometry.js'
import * as clipperModule from 'polygon-clipping'

type Pair = [number, number]
type ClipRing = Pair[]
type ClipPolygon = ClipRing[]
type ClipMulti = ClipPolygon[]
type Geom = ClipPolygon | ClipMulti
interface Clipper {
  union(geom: Geom, ...geoms: Geom[]): ClipMulti
  intersection(geom: Geom, ...geoms: Geom[]): ClipMulti
  difference(subject: Geom, ...clips: Geom[]): ClipMulti
}

/*
 * The package's typings declare named exports; its ESM build has a default
 * export carrying them, and its CJS build assigns the same object to
 * module.exports. Take whichever the loader handed over.
 */
const clipper: Clipper =
  (clipperModule as unknown as { default?: Clipper }).default
  ?? (clipperModule as unknown as Clipper)

const toClipRing = (ring: Polygon): ClipRing => ring.map((p): Pair => [p.x, p.y])

/** Each ring becomes its own polygon; the clipper unions them itself. */
const toMulti = (rings: readonly Polygon[]): ClipMulti =>
  rings.filter((r) => r.length >= 3).map((r) => [toClipRing(r)])

/**
 * Back to rings. The clipper closes every ring by repeating its first
 * point; ours do not, so the repeat is dropped. Holes come back as further
 * rings of the same polygon and are kept: `regionArea` sorts material from
 * opening by nesting, which is exactly what they are.
 */
function fromMulti(multi: ClipMulti): Region {
  const out: Region = []
  for (const polygon of multi) {
    for (const ring of polygon) {
      const points: Point[] = ring.map(([x, y]) => ({ x, y }))
      const first = points[0]
      const last = points[points.length - 1]
      if (points.length > 1 && first !== undefined && last !== undefined
          && first.x === last.x && first.y === last.y) points.pop()
      if (points.length >= 3) out.push(points)
    }
  }
  return out
}

/**
 * The part of `subject` that lies inside the union of `within`.
 *
 * Empty when they do not overlap. Several rings when the areas split the
 * subject — a cutout across a gap between two areas comes back as two
 * openings, one per area, which is what it is.
 */
export function clipRingToRings(subject: Polygon, within: readonly Polygon[]): Region {
  if (subject.length < 3) return []
  const clip = toMulti(within)
  if (clip.length === 0) return []
  return fromMulti(clipper.intersection([toClipRing(subject)], clip))
}

/**
 * `subject` less `clip`, one entry per resulting polygon (its outline
 * first, then its holes). A cut across an edge leaves one polygon whose
 * outline carries the notch; a cut right across leaves several.
 */
export function ringDifference(subject: Polygon, clip: Polygon): Region[] {
  if (subject.length < 3) return []
  if (clip.length < 3) return [[[...subject]]]
  return clipper.difference([toClipRing(subject)], [toClipRing(clip)]).map((poly) => fromMulti([poly]))
}

/** True when the two rings share any interior. Touching edges do not count. */
export function ringsOverlap(a: Polygon, b: Polygon): boolean {
  if (a.length < 3 || b.length < 3) return false
  return clipper.intersection([toClipRing(a)], [toClipRing(b)]).length > 0
}

/** Union of rings, as rings (outer boundaries first, then their holes). */
export function unionRings(rings: readonly Polygon[]): Region {
  const multi = toMulti(rings)
  if (multi.length === 0) return []
  return fromMulti(clipper.union(multi))
}

/**
 * `material` with `openings` removed, as rings.
 *
 * The union of the material first, then every opening taken out of it in one
 * operation. One operation, because the result is a valid polygon set: an
 * opening across an edge becomes a NOTCH in the outer ring and only an
 * opening wholly inside becomes a hole, and feeding that result back in for
 * a second opening would union its holes shut. Callers collect their
 * openings and subtract once.
 *
 * With no openings the material is returned untouched, vertex order and all:
 * nothing that was right before may move.
 */
export function subtractRings(material: readonly Polygon[], openings: readonly Polygon[]): Region {
  const subject = toMulti(material)
  const clips = toMulti(openings)
  if (subject.length === 0) return []
  if (clips.length === 0) return material.filter((r) => r.length >= 3).map((r) => [...r])
  return fromMulti(clipper.difference(clipper.union(subject), clips))
}

/**
 * The material of a set of AREAS, each an outline with its own cuts, less
 * further `openings`.
 *
 * An area's rings are `[outline, ...cuts]`: the cutter writes the cut ring as
 * drawn, unclipped, so it may cross the outline or overlap another cut. Each
 * area is its outline with its cuts subtracted; the areas are then unioned
 * and the openings taken out, all as polygons, so a hole of one area is never
 * filled back in by treating it as material.
 */
export function cutAreas(areas: ReadonlyArray<readonly Polygon[]>, openings: readonly Polygon[] = []): Region {
  const pieces: ClipMulti[] = []
  for (const rings of areas) {
    const outline = rings[0]
    if (outline === undefined || outline.length < 3) continue
    const cuts = toMulti(rings.slice(1))
    pieces.push(cuts.length === 0 ? [[toClipRing(outline)]] : clipper.difference([toClipRing(outline)], cuts))
  }
  if (pieces.length === 0) return []
  let material: ClipMulti = pieces.length === 1 ? pieces[0]! : clipper.union(pieces[0]!, ...pieces.slice(1))
  const clips = toMulti(openings)
  if (clips.length > 0) material = clipper.difference(material, clips)
  return fromMulti(material)
}

/**
 * The union of `pieces` that lies inside one area (`[outline, ...cuts]`), as
 * rings. Kept as polygons throughout, so a cut inside a piece stays a hole.
 */
export function piecesInArea(pieces: readonly Polygon[], area: readonly Polygon[]): Region {
  const subject = toMulti(pieces)
  const outline = area[0]
  if (subject.length === 0 || outline === undefined || outline.length < 3) return []
  const cuts = toMulti(area.slice(1))
  const material: ClipMulti = cuts.length > 0
    ? clipper.difference([[toClipRing(outline)]], cuts)
    : [[toClipRing(outline)]]
  if (material.length === 0) return []
  return fromMulti(clipper.intersection(clipper.union(subject), material))
}
