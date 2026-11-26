/**
 * What redbeam_get_bom adds for an agent (NOIC report, 2026-11-26): the bill
 * for one scope or a few rather than the whole set, and layout counts per
 * area so drawn and counted numbers can be compared room by room.
 *
 * Pure, so it is tested without a window.
 */
import type { Markup, PieceResult, Scope } from '@redbeam/domain'

/**
 * Which scopes a call asks for: `scopeId`, `scopeIds`, or `scope` (a label,
 * matched whole and then in part, either case). `ids` null means all.
 */
export function bomScopeFilter(
  params: Record<string, unknown>, scopes: readonly Scope[],
): { ids: Set<string> | null } | { error: string } {
  const ids = new Set<string>()
  const asked: string[] = []
  if (typeof params['scopeId'] === 'string' && params['scopeId'] !== '') asked.push(params['scopeId'])
  if (Array.isArray(params['scopeIds'])) for (const x of params['scopeIds']) if (typeof x === 'string' && x !== '') asked.push(x)
  for (const id of asked) {
    if (!scopes.some((s) => s.id === id)) return { error: `no such scope: ${id}` }
    ids.add(id)
  }
  const label = typeof params['scope'] === 'string' ? params['scope'].trim().toLowerCase() : ''
  if (label !== '') {
    const whole = scopes.filter((s) => s.label.trim().toLowerCase() === label)
    const part = whole.length > 0 ? whole : scopes.filter((s) => s.label.toLowerCase().includes(label))
    if (part.length === 0) return { error: `no scope is called ${String(params['scope'])}; redbeam_list_scopes has them` }
    for (const s of part) ids.add(s.id)
  }
  return { ids: asked.length === 0 && label === '' ? null : ids }
}

export interface AreaCounts {
  scopeId: string
  markupId: string
  page: number | null
  sheet: string | null
  /** Quantity per item key, as the scope's lines name them. */
  counts?: Record<string, number>
  /** Why this area has no count. */
  blocked?: string[]
}

/**
 * Lay each area of each scope out on its own: the area and the scope's
 * cutouts on its sheet, through the same layout the scope's count uses.
 */
export function perAreaCounts(
  scopes: readonly Scope[],
  markups: readonly Markup[],
  layOut: (scope: Scope, markups: readonly Markup[]) => PieceResult,
  sheetOf: (pageId: string) => { page: number | null; sheet: string | null },
): { areas: AreaCounts[]; items: Record<string, { label: string; unit: string }> } {
  const areas: AreaCounts[] = []
  const items: Record<string, { label: string; unit: string }> = {}
  for (const sc of scopes) {
    const mine = markups.filter((m) => m.scopeId === sc.id)
    const cutouts = mine.filter((m) => m.kind === 'cutout')
    for (const a of mine) {
      if (a.kind !== 'area') continue
      const r = layOut(sc, [a, ...cutouts.filter((c) => c.pageId === a.pageId)])
      const where = sheetOf(a.pageId)
      const base: AreaCounts = {
        scopeId: sc.id, markupId: a.id,
        page: where.page, sheet: where.sheet,
      }
      if (r.blockers.length > 0) { areas.push({ ...base, blocked: r.blockers }); continue }
      const counts: Record<string, number> = {}
      for (const q of r.quantities) {
        const key = q.layer !== undefined && q.layer !== '' ? `${q.layer}:${q.itemKey}` : q.itemKey
        counts[key] = q.quantity
        items[key] ??= { label: q.layer !== undefined && q.layer !== '' ? `${q.layer} · ${q.label}` : q.label, unit: q.unit }
      }
      areas.push({ ...base, counts })
    }
  }
  return { areas, items }
}

export interface FieldPerimeter {
  pageId: string
  page: number | null
  sheet: string | null
  areas: number
  /** Around the outside of the field: every area's edges less the edges two areas share. */
  frameFeet: number | null
  framePoints: number
  /** Edges two areas share (a fold line between chevron wings), counted once. */
  sharedFeet: number | null
  sharedPoints: number
}

type P = { x: number; y: number }

/** Length two segments overlap along, when they lie on one line (within `tol` points). */
export function collinearOverlap(a: P, b: P, c: P, d: P, tol = 0.75): number {
  const L = Math.hypot(b.x - a.x, b.y - a.y)
  if (L === 0) return 0
  const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L
  const off = (p: P) => Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux)
  if (off(c) > tol || off(d) > tol) return 0
  // Parallel within a hair: both ends of the other edge sit on this edge's line.
  const t = (p: P) => (p.x - a.x) * ux + (p.y - a.y) * uy
  const lo = Math.max(0, Math.min(t(c), t(d))), hi = Math.min(L, Math.max(t(c), t(d)))
  return Math.max(0, hi - lo)
}

/**
 * The frame around a scope's field on each sheet (NOIC report, 2026-11-26:
 * "counts the frame around the whole field as its own product, without
 * double-counting the fold line between chevron wings"). Each area's outline
 * is summed and every stretch two areas share is taken off twice: it is
 * inside the field, not round it, and is reported on its own.
 */
export function fieldPerimeters(
  areas: ReadonlyArray<{ pageId: string; rings: ReadonlyArray<ReadonlyArray<P>> }>,
  sizeOf: (pageId: string) => { width: number; height: number } | null,
  feetPerPoint: (pageId: string) => number | null,
  sheetOf: (pageId: string) => { page: number | null; sheet: string | null },
): FieldPerimeter[] {
  const byPage = new Map<string, Array<ReadonlyArray<P>>>()
  for (const a of areas) {
    const outer = a.rings[0]
    if (outer === undefined || outer.length < 3) continue
    const list = byPage.get(a.pageId) ?? []
    list.push(outer)
    byPage.set(a.pageId, list)
  }
  const out: FieldPerimeter[] = []
  for (const [pageId, rings] of byPage) {
    const size = sizeOf(pageId)
    if (size === null || size.width === 0) continue
    const pts = rings.map((r) => r.map((p) => ({ x: p.x * size.width, y: p.y * size.height })))
    const edges = pts.map((r) => r.map((p, i) => [p, r[(i + 1) % r.length]!] as const))
    let total = 0, shared = 0
    for (const es of edges) for (const [a, b] of es) total += Math.hypot(b.x - a.x, b.y - a.y)
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        for (const [a, b] of edges[i]!) for (const [c, d] of edges[j]!) shared += collinearOverlap(a, b, c, d)
      }
    }
    const fpp = feetPerPoint(pageId)
    const frame = Math.max(0, total - 2 * shared)
    const r2 = (n: number) => Math.round(n * 100) / 100
    out.push({
      pageId, ...sheetOf(pageId), areas: rings.length,
      frameFeet: fpp === null ? null : r2(frame * fpp), framePoints: r2(frame),
      sharedFeet: fpp === null ? null : r2(shared * fpp), sharedPoints: r2(shared),
    })
  }
  return out
}
