/**
 * Cutouts: a one-shot cut into each markup the cutter crosses.
 *
 * Aaron, 2026-11-19: "I want it to act as a Boolean operation on each Markup
 * and then disappear, so that I have to delete Boolean value per markup if it
 * covers multiple markups." So the cutter is not an object. Drawing one cuts
 * every area it crosses, each area keeping its own copy trimmed to its edge
 * (packages/domain/src/cuts.ts: an area's rings are `[outline, ...cuts]`),
 * and nothing ties the copies together afterwards. Moving an area moves its
 * own holes and nothing else.
 *
 * To remove one area's hole, it still has to be pointed at: each cut ring is
 * offered to the canvas and the markups list as a `cutout` markup with id
 * `cut:<area id>:<ring index>`. It is not drawn (the area's shape already
 * shows the hole) but it can be clicked, dragged or deleted, and every write
 * goes to that one area. These are never rows in redbeam.db or the PDF.
 */

import {
  areaRegion, clipRingToRings, cutChanges, regionArea, ringDifference, ringsOverlap,
  type Markup, type Polygon, type Region,
} from '@redbeam/domain'

export const CUT_PREFIX = 'cut:'

/** True for the id of a hole offered as a cutout. */
export const isCutId = (id: string): boolean => id.startsWith(CUT_PREFIX)

/** One area's geometry before and after, for an undoable edit. */
export interface GeometryEdit {
  id: string
  before: Region
  after: Region
}

const copy = (rings: ReadonlyArray<ReadonlyArray<{ x: number, y: number }>>): Region =>
  rings.map((r) => r.map((p) => ({ x: p.x, y: p.y })))

const realOnly = <M extends Markup>(markups: readonly M[]): M[] => markups.filter((m) => !isCutId(m.id))

/** The area and ring index a cutout id names, or null. */
export function cutTarget(id: string): { areaId: string, index: number } | null {
  if (!isCutId(id)) return null
  const at = id.lastIndexOf(':')
  const index = Number(id.slice(at + 1))
  if (at <= CUT_PREFIX.length - 1 || !Number.isInteger(index) || index < 1) return null
  return { areaId: id.slice(CUT_PREFIX.length, at), index }
}

/** Each hole of each area, as a cutout of that area alone. */
export function cutoutsOf(markups: readonly Markup[]): Markup[] {
  const out: Markup[] = []
  for (const a of realOnly(markups)) {
    if (a.kind !== 'area') continue
    for (let i = 1; i < a.rings.length; i++) {
      if (a.rings[i]!.length < 3) continue
      out.push({
        id: `${CUT_PREFIX}${a.id}:${i}`,
        scopeId: a.scopeId, documentId: a.documentId, pageId: a.pageId,
        kind: 'cutout', rings: [copy([a.rings[i]!])[0]!],
      })
    }
  }
  return out
}

/** The real markups with their holes after them, hit on top. */
export function withCutouts<M extends Markup>(markups: readonly M[]): Array<M | Markup> {
  const real = realOnly(markups)
  return [...real, ...cutoutsOf(real)]
}

/** The area a cutout id belongs to, if it is in `markups`. */
export function cutOwner(markups: readonly Markup[], id: string): Markup | undefined {
  const t = cutTarget(id)
  return t === null ? undefined : markups.find((m) => m.id === t.areaId && m.kind === 'area')
}

/** Polygons (outline first, then holes) with any real area, as normalized rings go. */
const solidPolys = (polys: Region[]): Region[] => polys.filter((p) => p.length > 0 && regionArea(p) > 1e-10)

/**
 * One area's rings after cutting `ring` out of it, or null when the cut
 * misses it or would swallow it.
 *
 * A cut wholly inside the outline is a hole. A cut that crosses the outline
 * (Coinbase blind test, 2026-11-27: a box over a pilaster notch) notches the
 * outline itself, so no ring of the area ever reaches outside it, and holes
 * the notch takes away go with it. Only a cut that would split the area in
 * two stays a hole trimmed to the outline, so the area remains one markup.
 *
 * The canvas cutter passes `notch` false: a person's cut across an edge
 * stays a hole trimmed to the outline, which they can still pick and delete
 * on its own. Agents get the notch (they asked for the outline clipped).
 */
export function cutRings(rings: readonly Polygon[], ring: Polygon, notch = false): Region | null {
  const outline = rings[0]
  if (outline === undefined || !cutChanges(rings, ring)) return null
  const pieces = clipRingToRings(ring, [outline])
  if (pieces.length === 0) return null
  const spill = solidPolys(ringDifference(ring, outline))
  if (spill.length === 0 || !notch) return [...copy(rings), ...copy(pieces)]
  const left = solidPolys(ringDifference(outline, ring))
  if (left.length === 1 && left[0]!.length === 1) {
    const notched = left[0]![0]!
    const holes: Polygon[] = []
    for (const h of rings.slice(1)) {
      if (h.length < 3) continue
      // A hole still inside the new outline stays exactly as it was.
      if (solidPolys(ringDifference(h, notched)).length === 0) { holes.push(copy([h])[0]!); continue }
      holes.push(...clipRingToRings(h, [notched]))
    }
    return [notched, ...copy(holes)]
  }
  return [...copy(rings), ...copy(pieces)]
}

/**
 * The cutter: every area on the sheet that `ring` changes gets the part of
 * it inside its outline taken out (a hole, or a notch in its outline). An
 * area the cut misses is left alone, and so is one it would swallow whole.
 */
export function cutEdits(markups: readonly Markup[], pageId: string, ring: Polygon, opts: { notch?: boolean } = {}): GeometryEdit[] {
  const out: GeometryEdit[] = []
  for (const m of realOnly(markups)) {
    if (m.kind !== 'area' || m.pageId !== pageId) continue
    const after = cutRings(m.rings, ring, opts.notch ?? false)
    if (after === null) continue
    out.push({ id: m.id, before: copy(m.rings), after })
  }
  return out
}

/**
 * Several cuts in a row, each into the areas as the cuts before it left
 * them: one edit per area, from its first shape to its last. Cutting each
 * ring into the untouched areas and applying the edits one after another
 * kept only the last cut of each area (Coinbase blind test, 2026-11-27:
 * three cutouts reported "cut", one stored).
 */
export function cutAllEdits(markups: readonly Markup[], cuts: ReadonlyArray<{ pageId: string, ring: Polygon }>, opts: { notch?: boolean } = {}): { edits: GeometryEdit[], cutBy: string[][] } {
  const now = new Map<string, Markup>()
  for (const m of realOnly(markups)) if (m.kind === 'area') now.set(m.id, m)
  const first = new Map<string, Region>()
  const cutBy: string[][] = []
  for (const c of cuts) {
    const hit: string[] = []
    for (const e of cutEdits([...now.values()], c.pageId, c.ring, opts)) {
      if (!first.has(e.id)) first.set(e.id, e.before)
      now.set(e.id, { ...now.get(e.id)!, rings: e.after })
      hit.push(e.id)
    }
    cutBy.push(hit)
  }
  const edits = [...first].map(([id, before]) => ({ id, before, after: copy(now.get(id)!.rings) }))
  return { edits, cutBy }
}

/** Remove one hole from its own area. */
export function uncutEdits(markups: readonly Markup[], cutId: string): GeometryEdit[] {
  const t = cutTarget(cutId)
  const area = cutOwner(markups, cutId)
  if (t === null || area === undefined || t.index >= area.rings.length) return []
  return [{ id: area.id, before: copy(area.rings), after: copy(area.rings.filter((_, i) => i !== t.index)) }]
}

/** A hole reshaped or dragged from `before` to `after`, in its own area. */
export function recutEdits(markups: readonly Markup[], cutId: string, before: Polygon, after: Polygon): GeometryEdit[] {
  const t = cutTarget(cutId)
  const area = cutOwner(markups, cutId)
  if (t === null || area === undefined || t.index >= area.rings.length) return []
  return [{
    id: area.id,
    before: copy(area.rings.map((r, i) => (i === t.index ? before : r))),
    after: copy(area.rings.map((r, i) => (i === t.index ? after : r))),
  }]
}

/** A live, unsaved hole: the cutout and its area's ring move together. */
export function previewCut<M extends Markup>(markups: readonly M[], cutId: string, ring: Polygon): M[] {
  const t = cutTarget(cutId)
  if (t === null) return [...markups]
  return markups.map((m) => {
    if (m.id === cutId) return { ...m, rings: [ring] }
    if (m.id !== t.areaId || m.kind !== 'area') return m
    return { ...m, rings: m.rings.map((r, n) => (n === t.index ? ring : r)) }
  })
}

/**
 * Separate `cutout` markups, as REDBEAM drew them before cutting was a
 * boolean on the area, cut into the areas they open (same sheet, same scope,
 * overlapping: the rule they were measured by) and then dropped. A cutout
 * that opens nothing is left as it is.
 */
export function foldCutouts(markups: readonly Markup[]): { edits: GeometryEdit[], folded: Markup[] } {
  const real = realOnly(markups)
  const now = new Map(real.filter((m) => m.kind === 'area').map((m) => [m.id, copy(m.rings)]))
  const before = new Map<string, Region>()
  const folded: Markup[] = []
  for (const c of real) {
    if (c.kind !== 'cutout') continue
    const rings = c.rings.filter((r) => r.length >= 3)
    if (rings.length === 0) continue
    let used = false
    for (const a of real) {
      if (a.kind !== 'area' || a.pageId !== c.pageId || a.scopeId !== c.scopeId) continue
      const cur = now.get(a.id)!
      const outline = cur[0]
      if (outline === undefined) continue
      const pieces = rings.filter((r) => ringsOverlap(r, outline)).flatMap((r) => clipRingToRings(r, [outline]))
      if (pieces.length === 0) continue
      if (!before.has(a.id)) before.set(a.id, copy(cur))
      now.set(a.id, [...cur, ...copy(pieces)])
      used = true
    }
    if (used) folded.push(c)
  }
  const edits = [...before].map(([id, b]) => ({ id, before: b, after: now.get(id)! }))
  return { edits, folded }
}

/** What one hole takes out of its area, in the units of `toPoints` squared. */
export function cutRemoves(
  markups: readonly Markup[],
  cutId: string,
  toPoints: (ring: Polygon, pageId: string) => Polygon,
): number {
  const t = cutTarget(cutId)
  const area = cutOwner(markups, cutId)
  if (t === null || area === undefined) return 0
  const pts = area.rings.map((r) => toPoints(r, area.pageId))
  return regionArea(areaRegion(pts.filter((_, i) => i !== t.index))) - regionArea(areaRegion(pts))
}

/**
 * Remove several holes at once: one edit per area, every chosen ring out
 * together so the indices of the others do not shift under them. Areas in
 * `skip` (being deleted in the same gesture) are left out.
 */
export function uncutAllEdits(markups: readonly Markup[], cutIds: readonly string[], skip: ReadonlySet<string> = new Set()): GeometryEdit[] {
  const byArea = new Map<string, Set<number>>()
  for (const id of cutIds) {
    const t = cutTarget(id)
    if (t === null || skip.has(t.areaId)) continue
    const set = byArea.get(t.areaId) ?? new Set<number>()
    set.add(t.index)
    byArea.set(t.areaId, set)
  }
  const out: GeometryEdit[] = []
  for (const [areaId, gone] of byArea) {
    const area = realOnly(markups).find((m) => m.id === areaId && m.kind === 'area')
    if (area === undefined) continue
    const after = area.rings.filter((_, i) => !gone.has(i))
    if (after.length === area.rings.length) continue
    out.push({ id: area.id, before: copy(area.rings), after: copy(after) })
  }
  return out
}
