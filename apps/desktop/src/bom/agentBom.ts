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
