/**
 * Cutouts on the canvas: one selectable cutout over the cuts it made.
 *
 * A cut is part of the area it cuts (packages/domain/src/cuts.ts): an area's
 * rings are `[outline, ...cuts]`. A cutout drawn across two areas is the same
 * ring in both. For the estimator it is still ONE cutout (Aaron, 2026-11-19:
 * "I should be able to select that one cutout and delete it and have it
 * reverse those boolean edits"), so the canvas and the markups list show a
 * cutout markup made from the cuts: the same ring on the same sheet is one
 * cutout, however many areas it is in.
 *
 * Those cutouts are not rows in redbeam.db or the PDF. Their id is
 * `cut:<first area id>:<ring index>`, stable while the cut is dragged, and
 * every write goes to the areas: deleting a cutout removes its ring from each
 * of them, dragging it moves the ring in each of them.
 *
 * Moving an area moves its cuts with it, because they are its rings. A cutout
 * across two areas, one of which is then moved, becomes two cutouts: each
 * area keeps its own cut where it now is.
 */

import {
  areaRegion, cutChanges, regionArea, ringsOverlap, sameRing,
  type Markup, type Polygon, type Region,
} from '@redbeam/domain'

export const CUT_PREFIX = 'cut:'

/** True for the id of a cutout made from area cuts. */
export const isCutId = (id: string): boolean => id.startsWith(CUT_PREFIX)

/** One area's geometry before and after, for an undoable edit. */
export interface GeometryEdit {
  id: string
  before: Region
  after: Region
}

const copy = (rings: readonly Polygon[]): Region => rings.map((r) => r.map((p) => ({ ...p })))

const realOnly = <M extends Markup>(markups: readonly M[]): M[] => markups.filter((m) => !isCutId(m.id))

/**
 * The cutouts these areas' cuts make: one per distinct ring per sheet, each
 * a `cutout` markup in the scope of the first area it cuts.
 */
export function cutoutsOf(markups: readonly Markup[]): Markup[] {
  const out: Markup[] = []
  const areas = realOnly(markups).filter((m) => m.kind === 'area' && m.rings.length > 1)
  for (const a of areas) {
    for (let i = 1; i < a.rings.length; i++) {
      const ring = a.rings[i]!
      if (ring.length < 3) continue
      if (out.some((c) => c.pageId === a.pageId && sameRing(c.rings[0]!, ring))) continue
      out.push({
        id: `${CUT_PREFIX}${a.id}:${i}`,
        scopeId: a.scopeId, documentId: a.documentId, pageId: a.pageId,
        kind: 'cutout', rings: [ring.map((p) => ({ ...p }))],
      })
    }
  }
  return out
}

/** The real markups with their cutouts after them, drawn and hit on top. */
export function withCutouts<M extends Markup>(markups: readonly M[]): Array<M | Markup> {
  const real = realOnly(markups)
  return [...real, ...cutoutsOf(real)]
}

/** The areas, and the ring index in each, that hold this cut ring. */
export function cutHolders(markups: readonly Markup[], pageId: string, ring: Polygon): Array<{ area: Markup, index: number }> {
  const out: Array<{ area: Markup, index: number }> = []
  for (const m of realOnly(markups)) {
    if (m.kind !== 'area' || m.pageId !== pageId) continue
    for (let i = 1; i < m.rings.length; i++) {
      if (sameRing(m.rings[i]!, ring)) { out.push({ area: m, index: i }); break }
    }
  }
  return out
}

/**
 * The cutter: cut `ring` out of every area on the sheet it changes. An area
 * it misses is left alone, and so is one it would swallow whole.
 */
export function cutEdits(markups: readonly Markup[], pageId: string, ring: Polygon): GeometryEdit[] {
  const out: GeometryEdit[] = []
  for (const m of realOnly(markups)) {
    if (m.kind !== 'area' || m.pageId !== pageId) continue
    if (!cutChanges(m.rings, ring)) continue
    out.push({ id: m.id, before: copy(m.rings), after: [...copy(m.rings), ring.map((p) => ({ ...p }))] })
  }
  return out
}

/** Delete a cutout: its ring comes out of every area that holds it. */
export function uncutEdits(markups: readonly Markup[], cut: Markup, skip: ReadonlySet<string> = new Set()): GeometryEdit[] {
  const ring = cut.rings[0]
  if (ring === undefined) return []
  return cutHolders(markups, cut.pageId, ring)
    .filter(({ area }) => !skip.has(area.id))
    .map(({ area, index }) => ({
      id: area.id,
      before: copy(area.rings),
      after: copy(area.rings.filter((_, i) => i !== index)),
    }))
}

/**
 * A cutout reshaped or dragged from `before` to `after`. The live geometry
 * already carries `after` (see `previewCut`); the edit for each area puts
 * `before` back for the undo.
 */
export function recutEdits(markups: readonly Markup[], cut: Markup, before: Polygon, after: Polygon): GeometryEdit[] {
  return cutHolders(markups, cut.pageId, after).map(({ area, index }) => ({
    id: area.id,
    before: copy(area.rings.map((r, i) => (i === index ? before : r))),
    after: copy(area.rings.map((r, i) => (i === index ? after : r))),
  }))
}

/** A live, unsaved cutout ring: the cutout and every cut it stands for move together. */
export function previewCut<M extends Markup>(markups: readonly M[], cutId: string, ring: Polygon): M[] {
  const cut = markups.find((m) => m.id === cutId)
  const was = cut?.rings[0]
  if (cut === undefined || was === undefined) return [...markups]
  return markups.map((m) => {
    if (m.id === cutId) return { ...m, rings: [ring] }
    if (m.kind !== 'area' || m.pageId !== cut.pageId || isCutId(m.id)) return m
    const i = m.rings.findIndex((r, n) => n > 0 && sameRing(r, was))
    return i < 0 ? m : { ...m, rings: m.rings.map((r, n) => (n === i ? ring : r)) }
  })
}

/**
 * Separate `cutout` markups, as REDBEAM drew them before cuts were part of
 * the area, folded into the areas they open: same sheet, same scope,
 * overlapping, the rule they were measured by. A cutout that opens nothing
 * is left as it is.
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
      const opens = rings.filter((r) => ringsOverlap(r, outline))
      if (opens.length === 0) continue
      if (!before.has(a.id)) before.set(a.id, copy(cur))
      now.set(a.id, [...cur, ...copy(opens)])
      used = true
    }
    if (used) folded.push(c)
  }
  const edits = [...before].map(([id, b]) => ({ id, before: b, after: now.get(id)! }))
  return { edits, folded }
}

/**
 * What one cutout takes out, in the units of `toPoints` squared: the areas
 * holding it, measured with and without it.
 */
export function cutRemoves(
  markups: readonly Markup[],
  cut: Markup,
  toPoints: (ring: Polygon, pageId: string) => Polygon,
): number {
  const ring = cut.rings[0]
  if (ring === undefined) return 0
  let total = 0
  for (const { area, index } of cutHolders(markups, cut.pageId, ring)) {
    const pts = area.rings.map((r) => toPoints(r, area.pageId))
    const without = pts.filter((_, i) => i !== index)
    total += regionArea(areaRegion(without)) - regionArea(areaRegion(pts))
  }
  return total
}
