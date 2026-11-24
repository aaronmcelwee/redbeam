/**
 * Each sheet carries its own takeoff, and a file's takeoff is put back
 * together from where its sheets are NOW.
 *
 * Aaron, 2026-11-24, after a tester merged a REDBEAM PDF with another in
 * Bluebeam and REDBEAM could no longer load the takeoff: "Can the embedded
 * content be updated to live in each page in isolation?"
 *
 * The file-wide slice (sheetEmbed.ts) names every sheet by its NUMBER. Merge,
 * insert, delete, reorder or extract pages in Bluebeam and the numbers move
 * while the slice stays put. So, beside the file-wide copy, every sheet with
 * takeoff on it carries a PAGE SLICE in its own /PieceInfo: its markups, its
 * scales and the scopes those markups use. A page dictionary travels whole
 * when pages are moved between files, so its takeoff goes with it, and the
 * sheet's number is read from where it sits when the file is opened.
 *
 * Bluebeam may also drop the page's private data and keep the annotations.
 * A REDBEAM annotation names its markup (/REDBEAM /MarkupId, or its /NM
 * through the slice), so a file-wide slice from before this change, or one
 * whose page copies are gone, is re-bound by finding each markup's
 * annotation on the page where it is now. That is how a file merged before
 * this build is recovered.
 *
 * Pure: everything about the PDF arrives already read.
 */
import { stableStringify, hash53, type SheetSlice, type SliceAnnot, type SliceTables } from './sheetEmbed.js'

export const PAGE_SLICE_FORMAT = 'redbeam.page-slice'
export const PAGE_SLICE_VERSION = 1

/** One sheet's takeoff, kept on the sheet. */
export interface PageSlice {
  format: typeof PAGE_SLICE_FORMAT
  version: number
  /** The file-wide slice's document id when it was written: which file it came from. */
  documentId: string
  /** Where the sheet was when it was written. Informational: where it is now decides. */
  pageNumber: number
  writtenAt: string
  appVersion: string
  /** pages (one row), markups, calibrations, scale_regions, and the scopes the markups use. */
  tables: SliceTables
  /** What REDBEAM wrote for each markup on this sheet, by /NM. */
  annots: Record<string, SliceAnnot>
  /**
   * Hash of the tables. The file-wide slice written in the same save lists
   * every page slice's hash (`SheetSlice.pageHashes`), so a page copy that a
   * later save by an older REDBEAM did not update is recognised as stale.
   */
  pageHash: string
}

const PAGE_TABLES = ['pages', 'markups', 'calibrations', 'scale_regions'] as const

const pid = (documentId: string, n: number): string => `${documentId}-p${n}`

function pageNumberOf(pageId: unknown, documentId: string): number | null {
  if (typeof pageId !== 'string') return null
  const prefix = `${documentId}-p`
  if (!pageId.startsWith(prefix)) return null
  const rest = pageId.slice(prefix.length)
  return /^\d+$/.test(rest) ? Number(rest) : null
}

export function pageSliceHash(tables: SliceTables, annots: Record<string, SliceAnnot>): string {
  // Bookkeeping columns move without the takeoff moving (see hashableTables).
  const strip = (rows: Array<Record<string, unknown>> | undefined) => (rows ?? []).map((r) => {
    const o: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) if (k !== 'created_at' && k !== 'updated_at' && k !== 'text_indexed_at') o[k] = v
    return o
  })
  const t: SliceTables = {}
  for (const [k, v] of Object.entries(tables)) t[k] = strip(v)
  return hash53(stableStringify({ t, annots, v: PAGE_SLICE_VERSION })).toString(16).padStart(14, '0')
}

/**
 * The page slices to write for a save: one per sheet that has markups or a
 * scale on it, keyed by page index. `annots` is the save's /NM map.
 */
export function pageSlicesFor(input: {
  documentId: string
  tables: SliceTables
  annots: Record<string, SliceAnnot>
  pageCount: number
  writtenAt: string
  appVersion: string
}): Map<number, PageSlice> {
  const byPage = new Map<number, SliceTables>()
  const at = (n: number): SliceTables => {
    let t = byPage.get(n)
    if (t === undefined) { t = {}; byPage.set(n, t) }
    return t
  }
  for (const table of ['markups', 'calibrations', 'scale_regions'] as const) {
    for (const row of input.tables[table] ?? []) {
      const n = pageNumberOf(row.page_id, input.documentId)
      if (n === null || n >= input.pageCount) continue
      const t = at(n)
      ;(t[table] ??= []).push(row)
    }
  }
  const scopes = new Map((input.tables.scopes ?? []).map((s) => [String(s.id), s]))
  const pageRows = new Map((input.tables.pages ?? []).map((p) => [String(p.id), p]))
  const nmByMarkup = new Map<string, string[]>()
  for (const [nm, a] of Object.entries(input.annots)) {
    const list = nmByMarkup.get(a.markupId) ?? []
    list.push(nm)
    nmByMarkup.set(a.markupId, list)
  }
  const out = new Map<number, PageSlice>()
  for (const [n, t] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const page = pageRows.get(pid(input.documentId, n))
    if (page !== undefined) t.pages = [page]
    const used = new Set((t.markups ?? []).map((m) => m.scope_id).filter((s): s is string => typeof s === 'string'))
    const mine = [...used].map((id) => scopes.get(id)).filter((s): s is Record<string, unknown> => s !== undefined)
    if (mine.length > 0) t.scopes = mine
    const annots: Record<string, SliceAnnot> = {}
    for (const m of t.markups ?? []) {
      for (const nm of nmByMarkup.get(String(m.id)) ?? []) annots[nm] = input.annots[nm]!
    }
    out.set(n, {
      format: PAGE_SLICE_FORMAT, version: PAGE_SLICE_VERSION, documentId: input.documentId, pageNumber: n,
      writtenAt: input.writtenAt, appVersion: input.appVersion, tables: t, annots, pageHash: pageSliceHash(t, annots),
    })
  }
  return out
}

/** Parse a page slice; null when it is not one, 'too-new' when a newer REDBEAM wrote it. */
export function parsePageSlice(text: string | null): PageSlice | 'too-new' | null {
  if (text === null) return null
  try {
    const v = JSON.parse(text) as Partial<PageSlice>
    if (v.format !== PAGE_SLICE_FORMAT || typeof v.documentId !== 'string' || typeof v.version !== 'number') return null
    if (v.version > PAGE_SLICE_VERSION) return 'too-new'
    if (v.tables === null || typeof v.tables !== 'object') return null
    return { annots: {}, pageHash: '', pageNumber: -1, writtenAt: '', appVersion: '', ...v } as PageSlice
  } catch {
    return null
  }
}

/** A REDBEAM annotation as found in the file: where it is and which markup it draws. */
export interface FoundAnnot { pageIndex: number, nm: string, markupId: string | null }

/** A sheet as it is now: its size as displayed, and REDBEAM's scales on it. */
export interface FoundSheet {
  width: number
  height: number
  scales: ReadonlyArray<{ feetPerPoint: number, rect: { x0: number, y0: number, x1: number, y1: number } | null, label: string }>
}

/** What re-binding did, for the status line. */
export interface Rebound {
  /** How many REDBEAM files the takeoff came from (2+ after a merge of two marked-up PDFs). */
  sources: number
  /** Markups now on a different sheet number than the takeoff said. */
  moved: number
  /** Markups whose sheet is no longer in the file (deleted in another app). */
  leftBehind: number
  /** Scopes of the same name from different files, now one. */
  scopesJoined: number
}

export interface Assembled { slice: SheetSlice | null, rebound: Rebound | null }

/**
 * The takeoff this file carries, as one slice in today's page numbering.
 *
 * `fileSlices` are the file-wide copies found (the catalog's, then any other
 * one an annotation points at). When the file is one REDBEAM file whose
 * sheets are all where it left them, the catalog's slice comes back exactly
 * as it was, so nothing about an ordinary file changes. Otherwise the slice
 * is rebuilt: sheets from their page slices, markups found by their
 * annotations, scales from the sheets' own viewports, and same-named scopes
 * from different files joined into one. Such a slice has no content hash,
 * so the next save writes the file back in order.
 */
export function assembleSlice(input: {
  catalog: SheetSlice | null
  fileSlices: readonly SheetSlice[]
  pageSlices: ReadonlyMap<number, PageSlice>
  annots: readonly FoundAnnot[]
  sheets: readonly FoundSheet[]
}): Assembled {
  // The newest file-wide slice of each file the takeoff came from.
  const newest = new Map<string, SheetSlice>()
  for (const s of [...(input.catalog === null ? [] : [input.catalog]), ...input.fileSlices]) {
    const had = newest.get(s.documentId)
    // The catalog's copy wins a tie; otherwise the later save.
    if (had === undefined || s.writtenAt > had.writtenAt) newest.set(s.documentId, s)
  }
  // A page copy is current when its file's slice lists it, or when no slice of its file survives.
  const pages = new Map<number, PageSlice>()
  for (const [k, ps] of input.pageSlices) {
    const file = newest.get(ps.documentId)
    const current = file === undefined
      || (file.pageHashes !== undefined ? file.pageHashes.includes(ps.pageHash) : file.writtenAt <= ps.writtenAt)
    if (current) pages.set(k, ps)
  }

  const primary = input.catalog ?? [...newest.values()][0] ?? null
  const primaryId = primary?.documentId ?? [...pages.values()][0]?.documentId ?? null
  if (primaryId === null) return { slice: null, rebound: null }

  // ---- Is this the file as REDBEAM left it? Then the slice stands as written.
  const sources = new Set([...newest.keys(), ...[...pages.values()].map((p) => p.documentId)])
  const where = new Map<string, number[]>()
  for (const a of input.annots) {
    if (a.markupId === null) continue
    const list = where.get(a.markupId) ?? []
    list.push(a.pageIndex)
    where.set(a.markupId, list)
  }
  const pageCount = input.sheets.length
  const drawn = new Set(primary === null ? [] : Object.values(primary.annots).map((a) => a.markupId))
  const drawnOn = new Set(primary === null ? [] : (primary.tables.markups ?? [])
    .filter((m) => drawn.has(String(m.id)))
    .map((m) => pageNumberOf(m.page_id, primary.documentId)).filter((n): n is number => n !== null))
  const inOrder = primary !== null && sources.size === 1
    && [...pages.entries()].every(([k, ps]) => ps.pageNumber === k)
    // Every markup's annotation is on the sheet the slice says, and no sheet it names is gone.
    // A markup on a sheet past the end that never had an annotation (the
    // database knew a sheet this PDF never had) is not a sign of pages moving.
    && (primary.tables.markups ?? []).every((m) => {
      const n = pageNumberOf(m.page_id, primary.documentId)
      if (n !== null && n >= pageCount) return !drawn.has(String(m.id))
      const found = where.get(String(m.id))
      return found === undefined || (found.length === 1 && (n === null || found[0] === n))
    })
    && [...(primary.tables.calibrations ?? []), ...(primary.tables.scale_regions ?? [])]
      .every((r) => { const n = pageNumberOf(r.page_id, primary.documentId); return n === null || n < pageCount || !drawnOn.has(n) })
  if (inOrder && primary !== null) return { slice: primary, rebound: null }

  // ---- Re-bind.
  const rebound: Rebound = { sources: Math.max(1, sources.size), moved: 0, leftBehind: 0, scopesJoined: 0 }
  interface Placed { row: Record<string, unknown>, page: number, from: string }
  const placed: Placed[] = []
  const taken = new Set<string>()
  /** `${file}|${original markup id}`, for every markup placed at least once. */
  const done = new Set<string>()
  const annots: Record<string, SliceAnnot> = {}
  /** A markup id seen twice (a sheet duplicated, a file merged with itself) gets its own id. */
  const place = (row: Record<string, unknown>, page: number, from: string, oldPage: number | null): string => {
    let id = String(row.id)
    if (taken.has(id)) id = `${id}-p${page}`
    if (taken.has(id)) return ''
    taken.add(id)
    done.add(`${from}|${String(row.id)}`)
    placed.push({ row: { ...row, id }, page, from })
    origOf.set(id, String(row.id))
    if (oldPage !== null && oldPage !== page) rebound.moved++
    return id
  }

  // Scale rows, by page.
  const origOf = new Map<string, string>()
  const scaleRows: Array<{ table: 'calibrations' | 'scale_regions', row: Record<string, unknown>, page: number }> = []
  /** Sheets whose scale came from their own page slice. */
  const scaled = new Set<number>()

  // 1. Sheets that carry their own takeoff: it is theirs, wherever they are now.
  for (const [k, ps] of [...pages.entries()].sort((a, b) => a[0] - b[0])) {
    const oldNumber = ps.pageNumber >= 0 ? ps.pageNumber : null
    for (const m of ps.tables.markups ?? []) {
      const id = place(m, k, ps.documentId, oldNumber)
      if (id === '') continue
      for (const [nm, a] of Object.entries(ps.annots)) if (a.markupId === String(m.id)) annots[nm] = { ...a, markupId: id }
    }
    for (const table of ['calibrations', 'scale_regions'] as const) {
      for (const r of ps.tables[table] ?? []) { scaleRows.push({ table, row: r, page: k }); scaled.add(k) }
    }
  }

  // 2. File-wide slices: each markup not already placed goes where its annotation is,
  //    else where the other markups of its old sheet went.
  for (const s of newest.values()) {
    const rows = (s.tables.markups ?? []).filter((m) => m.deleted_at === null || m.deleted_at === undefined)
    // Old sheet -> new sheet, by vote of the markups found by their annotations.
    const votes = new Map<number, Map<number, number>>()
    const vote = (oldN: number | null, newN: number) => {
      if (oldN === null) return
      const v = votes.get(oldN) ?? new Map<number, number>()
      v.set(newN, (v.get(newN) ?? 0) + 1)
      votes.set(oldN, v)
    }
    for (const m of rows) for (const n of where.get(String(m.id)) ?? []) vote(pageNumberOf(m.page_id, s.documentId), n)
    for (const p of placed) if (p.from === s.documentId) {
      const orig = rows.find((m) => String(m.id) === origOf.get(String(p.row.id)))
      if (orig !== undefined) vote(pageNumberOf(orig.page_id, s.documentId), p.page)
    }
    const mapOld = (oldN: number | null): number | null => {
      if (oldN === null) return null
      const v = votes.get(oldN)
      if (v === undefined) return null
      return [...v.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0]
    }
    // Folded cutouts have no annotation of their own: they follow their area.
    const areaOf = new Map<string, string>()
    for (const a of Object.values(s.annots)) for (const f of a.folded ?? []) areaOf.set(f, a.markupId)

    const pending = rows.filter((m) => !done.has(`${s.documentId}|${String(m.id)}`))
    const placedAt = (id: string): number | null => {
      const p = placed.find((x) => x.from === s.documentId && origOf.get(String(x.row.id)) === id)
      return p === undefined ? null : p.page
    }
    for (const m of pending.filter((x) => !areaOf.has(String(x.id)))) {
      const oldN = pageNumberOf(m.page_id, s.documentId)
      const found = where.get(String(m.id)) ?? []
      const mapped = mapOld(oldN)
      const targets = found.length > 0 ? found : mapped === null ? [] : [mapped]
      if (targets.length === 0) { rebound.leftBehind++; continue }
      for (const t of targets) {
        const id = place(m, t, s.documentId, oldN)
        if (id === '') continue
        // Its annotation on that sheet now answers to the markup placed there.
        for (const f of input.annots) {
          const rec = s.annots[f.nm]
          if (f.pageIndex === t && rec !== undefined && rec.markupId === String(m.id)) annots[f.nm] = { ...rec, markupId: id }
        }
      }
    }
    for (const m of pending.filter((x) => areaOf.has(String(x.id)))) {
      const oldN = pageNumberOf(m.page_id, s.documentId)
      const t = placedAt(areaOf.get(String(m.id))!) ?? mapOld(oldN)
      if (t === null) { rebound.leftBehind++; continue }
      place(m, t, s.documentId, oldN)
    }
    for (const table of ['calibrations', 'scale_regions'] as const) {
      for (const r of s.tables[table] ?? []) {
        const t = mapOld(pageNumberOf(r.page_id, s.documentId))
        if (t === null || scaled.has(t)) continue
        scaleRows.push({ table, row: r, page: t })
      }
    }
  }
  for (const r of scaleRows) scaled.add(r.page)

  // 3. Sheets REDBEAM scaled that nothing above accounted for: the scale is on the sheet itself.
  input.sheets.forEach((sheet, k) => {
    if (scaled.has(k) || sheet.scales.length === 0) return
    for (const sc of sheet.scales) {
      if (sc.rect === null) {
        scaleRows.push({ table: 'calibrations', page: k, row: { id: `cal-${primaryId}-p${k}`, feet_per_pdf_point: sc.feetPerPoint, source: 'manual' } })
      } else {
        scaleRows.push({ table: 'scale_regions', page: k, row: {
          id: `sr-${primaryId}-p${k}-${scaleRows.length}`, label: sc.label, x0: sc.rect.x0, y0: sc.rect.y0, x1: sc.rect.x1, y1: sc.rect.y1,
          feet_per_pdf_point: sc.feetPerPoint, source: 'manual',
        } })
      }
    }
  })
  // One page scale per sheet (calibrations are unique per page).
  const calibrated = new Set<number>()
  const scales = scaleRows.filter((r) => {
    if (r.table !== 'calibrations') return true
    if (calibrated.has(r.page)) return false
    calibrated.add(r.page)
    return true
  })
  // Region ids must not collide when a sheet was duplicated.
  const scaleIds = new Set<string>()

  // 4. Scopes: every file's, with same-named live scopes joined into the first.
  const allScopes: Array<Record<string, unknown>> = []
  const seenScope = new Set<string>()
  const addScopes = (rows: Array<Record<string, unknown>> | undefined) => {
    for (const r of rows ?? []) {
      const id = String(r.id)
      if (seenScope.has(id)) continue
      seenScope.add(id)
      allScopes.push(r)
    }
  }
  if (primary !== null) addScopes(primary.tables.scopes)
  for (const s of newest.values()) addScopes(s.tables.scopes)
  for (const ps of pages.values()) addScopes(ps.tables.scopes)
  const scopeFor = new Map<string, string>()
  const byLabel = new Map<string, string>()
  const scopes: Array<Record<string, unknown>> = []
  for (const r of allScopes) {
    const id = String(r.id)
    const live = r.archived_at === null || r.archived_at === undefined
    const key = String(r.label ?? '').trim().toLowerCase()
    const first = live && key !== '' ? byLabel.get(key) : undefined
    if (first !== undefined) { scopeFor.set(id, first); rebound.scopesJoined++; continue }
    if (live && key !== '') byLabel.set(key, id)
    scopeFor.set(id, id)
    scopes.push(r)
  }

  // 5. Rows in today's numbering, under the primary file's id.
  const pageIds = new Set<number>([...placed.map((p) => p.page), ...scales.map((s) => s.page)])
  const tables: SliceTables = {
    ...(primary?.tables.documents === undefined ? {} : { documents: primary.tables.documents }),
    pages: [...pageIds].filter((k) => k < pageCount).sort((a, b) => a - b).map((k) => ({
      id: pid(primaryId, k), document_id: primaryId, page_number: k,
      width_pdf_points: input.sheets[k]!.width, height_pdf_points: input.sheets[k]!.height,
    })),
    markups: placed.filter((p) => p.page < pageCount).map((p) => ({
      ...p.row, document_id: primaryId, page_id: pid(primaryId, p.page),
      scope_id: p.row.scope_id === null || p.row.scope_id === undefined ? null : scopeFor.get(String(p.row.scope_id)) ?? null,
    })),
    calibrations: scales.filter((s) => s.table === 'calibrations' && s.page < pageCount).map((s) => uniqueScale(s, primaryId, scaleIds)),
    scale_regions: scales.filter((s) => s.table === 'scale_regions' && s.page < pageCount).map((s) => uniqueScale(s, primaryId, scaleIds)),
    scopes,
    // Runs and layouts are worked out again from the markups; only the joined-into scopes' runs are kept.
    calculation_runs: [...newest.values()].flatMap((s) => s.tables.calculation_runs ?? [])
      .filter((r) => scopeFor.get(String(r.scope_id)) === String(r.scope_id)),
  }
  const runIds = new Set((tables.calculation_runs ?? []).map((r) => String(r.id)))
  tables.quantity_results = [...newest.values()].flatMap((s) => s.tables.quantity_results ?? [])
    .filter((r) => runIds.has(String(r.calculation_run_id)))

  // Rows put together here carry the times a table row needs.
  const stamp = primary?.writtenAt ?? [...pages.values()].map((p) => p.writtenAt).sort().pop() ?? new Date(0).toISOString()
  for (const table of ['pages', 'calibrations', 'scale_regions'] as const) {
    tables[table] = (tables[table] ?? []).map((r) => ({ created_at: stamp, updated_at: stamp, ...r }))
  }

  const base = primary ?? {
    format: 'redbeam.sheet-slice', version: 1, documentId: primaryId, relativePath: '', displayName: '',
    writtenAt: [...pages.values()].map((p) => p.writtenAt).sort().pop() ?? '', appVersion: '',
    tables: {}, annots: {}, contentHash: '',
  } as SheetSlice
  const { pageHashes: _drop, ...rest } = base
  return {
    slice: { ...rest, documentId: primaryId, tables, annots, contentHash: '' },
    rebound,
  }
}

function uniqueScale(
  s: { row: Record<string, unknown>, page: number },
  documentId: string,
  ids: Set<string>,
): Record<string, unknown> {
  let id = String(s.row.id)
  if (ids.has(id)) id = `${id}-p${s.page}`
  ids.add(id)
  return { ...s.row, id, document_id: documentId, page_id: pid(documentId, s.page) }
}
