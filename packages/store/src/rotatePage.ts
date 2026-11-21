/**
 * Turning a sheet turns everything drawn on it.
 *
 * Every position this store keeps against a page is normalized to the page AS
 * DISPLAYED: [0,1] on both axes, y down. When a sheet is rotated a quarter turn
 * its displayed width and height swap and every one of those positions moves.
 * Turning them by the same quarter turns keeps each markup on the thing it was
 * drawn over, and keeps every length and area what it was: a normalized length
 * times a swapped page box is the same number of points.
 *
 * Calibration is feet per PDF point, the same in both directions, so it does
 * not move. Neither does a scope's default direction, which is not tied to one
 * sheet: a sheet whose takeoff leaned on it gets a direction of its own instead,
 * turned with the sheet, so its pieces do not swing round.
 */

import { runBatch, type SqlStatement } from './batch.js'
import type { SqlDriver } from './index.js'

/** Clockwise, as /Rotate is. */
export type QuarterTurns = 0 | 1 | 2 | 3

export function wrapQuarterTurns(turns: number): QuarterTurns {
  return ((((Math.round(turns) % 4) + 4) % 4) as QuarterTurns)
}

interface P { x: number; y: number }

/** A normalized point turned clockwise. */
export function turnNormPoint(p: P, turns: number): P {
  switch (wrapQuarterTurns(turns)) {
    case 1: return { x: 1 - p.y, y: p.x }
    case 2: return { x: 1 - p.x, y: 1 - p.y }
    case 3: return { x: p.y, y: 1 - p.x }
    default: return { x: p.x, y: p.y }
  }
}

export interface RotatePageResult {
  markups: number
  regions: number
  scopes: number
}

const DIRECTION_KEYS = ['x1', 'y1', 'x2', 'y2'] as const

function isDirection(v: unknown): v is Record<'x1' | 'y1' | 'x2' | 'y2', number> {
  if (v === null || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  return DIRECTION_KEYS.every((k) => typeof d[k] === 'number' && Number.isFinite(d[k]))
}

function turnDirection<T extends Record<string, unknown>>(d: T & Record<'x1' | 'y1' | 'x2' | 'y2', number>, turns: number): T {
  const a = turnNormPoint({ x: d.x1, y: d.y1 }, turns)
  const b = turnNormPoint({ x: d.x2, y: d.y2 }, turns)
  return { ...d, x1: a.x, y1: a.y, x2: b.x, y2: b.y }
}

/**
 * A scope's specifications with this sheet's directions and origins turned.
 * Null when nothing in them belongs to the sheet.
 */
export function turnScopeSpecs(
  specs: Record<string, unknown>,
  pageId: string,
  markupIds: ReadonlySet<string>,
  turns: number,
  /** The scope has areas on this sheet, so a default it leaned on must be pinned. */
  hasAreasHere: boolean,
): Record<string, unknown> | null {
  let changed = false
  const out: Record<string, unknown> = { ...specs }

  const pageDirs = specs['pageDirections']
  const pages: Record<string, unknown> =
    pageDirs !== null && typeof pageDirs === 'object' ? { ...(pageDirs as Record<string, unknown>) } : {}
  const own = pages[pageId]
  if (isDirection(own)) {
    pages[pageId] = turnDirection(own, turns)
    changed = true
  } else if (hasAreasHere && isDirection(specs['scopeDefaultDirection'])) {
    const d = specs['scopeDefaultDirection'] as Record<'x1' | 'y1' | 'x2' | 'y2', number>
    if (d.x1 !== d.x2 || d.y1 !== d.y2) {
      const { x1, y1, x2, y2 } = turnDirection(d, turns)
      pages[pageId] = { x1, y1, x2, y2 }
      changed = true
    }
  }
  if (changed) out['pageDirections'] = pages

  const areaDirs = specs['areaDirections']
  if (areaDirs !== null && typeof areaDirs === 'object') {
    const next: Record<string, unknown> = { ...(areaDirs as Record<string, unknown>) }
    let any = false
    for (const id of Object.keys(next)) {
      const d = next[id]
      if (markupIds.has(id) && isDirection(d)) { next[id] = turnDirection(d, turns); any = true }
    }
    if (any) { out['areaDirections'] = next; changed = true }
  }

  const origins = specs['areaOrigins']
  if (origins !== null && typeof origins === 'object') {
    const next: Record<string, unknown> = { ...(origins as Record<string, unknown>) }
    let any = false
    for (const id of Object.keys(next)) {
      const o = next[id] as Record<string, unknown> | null
      if (!markupIds.has(id) || o === null || typeof o !== 'object') continue
      if (typeof o.x !== 'number' || typeof o.y !== 'number') continue
      next[id] = { ...o, ...turnNormPoint({ x: o.x, y: o.y }, turns) }
      any = true
    }
    if (any) { out['areaOrigins'] = next; changed = true }
  }

  return changed ? out : null
}

/**
 * Turn everything stored against one page by `turns` clockwise quarter turns,
 * in one transaction: its markups (deleted ones too, so a restore lands right),
 * its scale regions, its page box and rotation, and the directions and origins
 * the scopes keep for it.
 */
export async function rotatePageData(db: SqlDriver, pageId: string, turns: number): Promise<RotatePageResult> {
  const t = wrapQuarterTurns(turns)
  const result: RotatePageResult = { markups: 0, regions: 0, scopes: 0 }
  if (t === 0) return result
  const now = new Date().toISOString()
  const statements: SqlStatement[] = []

  const markups = await db.all<{ id: string; geometry_json: string; scope_id: string | null; deleted_at: string | null }>(
    'SELECT id, geometry_json, scope_id, deleted_at FROM markups WHERE page_id = ?', [pageId],
  )
  const idsByScope = new Map<string, Set<string>>()
  const liveScopes = new Set<string>()
  for (const m of markups) {
    let rings: unknown
    try { rings = JSON.parse(m.geometry_json) } catch { continue }
    if (!Array.isArray(rings)) continue
    const turned = rings.map((ring) => Array.isArray(ring)
      ? ring.map((p) => (p !== null && typeof p === 'object' && typeof p.x === 'number' && typeof p.y === 'number'
        ? { ...p, ...turnNormPoint(p as P, t) } : p))
      : ring)
    statements.push({ sql: 'UPDATE markups SET geometry_json = ?, updated_at = ? WHERE id = ?', params: [JSON.stringify(turned), now, m.id] })
    result.markups++
    if (m.scope_id !== null) {
      const set = idsByScope.get(m.scope_id) ?? new Set<string>()
      set.add(m.id)
      idsByScope.set(m.scope_id, set)
      if (m.deleted_at === null) liveScopes.add(m.scope_id)
    }
  }

  const regions = await db.all<{ id: string; x0: number; y0: number; x1: number; y1: number }>(
    'SELECT id, x0, y0, x1, y1 FROM scale_regions WHERE page_id = ?', [pageId],
  )
  for (const r of regions) {
    const a = turnNormPoint({ x: r.x0, y: r.y0 }, t)
    const b = turnNormPoint({ x: r.x1, y: r.y1 }, t)
    statements.push({
      sql: 'UPDATE scale_regions SET x0 = ?, y0 = ?, x1 = ?, y1 = ? WHERE id = ?',
      params: [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y), r.id],
    })
    result.regions++
  }

  const page = await db.all<{ rotation: number | null; width_pdf_points: number | null; height_pdf_points: number | null }>(
    'SELECT rotation, width_pdf_points, height_pdf_points FROM pages WHERE id = ?', [pageId],
  )
  const p = page[0]
  if (p !== undefined) {
    const odd = t % 2 === 1
    statements.push({
      sql: 'UPDATE pages SET rotation = ?, width_pdf_points = ?, height_pdf_points = ?, updated_at = ? WHERE id = ?',
      params: [
        (((p.rotation ?? 0) + t * 90) % 360 + 360) % 360,
        odd ? p.height_pdf_points : p.width_pdf_points,
        odd ? p.width_pdf_points : p.height_pdf_points,
        now, pageId,
      ],
    })
  }

  const scopes = await db.all<{ id: string; specifications_json: string }>('SELECT id, specifications_json FROM scopes')
  for (const s of scopes) {
    let specs: unknown
    try { specs = JSON.parse(s.specifications_json || '{}') } catch { continue }
    if (specs === null || typeof specs !== 'object' || Array.isArray(specs)) continue
    const next = turnScopeSpecs(specs as Record<string, unknown>, pageId, idsByScope.get(s.id) ?? new Set(), t, liveScopes.has(s.id))
    if (next === null) continue
    statements.push({ sql: 'UPDATE scopes SET specifications_json = ?, updated_at = ? WHERE id = ?', params: [JSON.stringify(next), now, s.id] })
    result.scopes++
  }

  await runBatch(db, statements)
  return result
}
