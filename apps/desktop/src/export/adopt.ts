/**
 * Bluebeam's markups, held as REDBEAM's own.
 *
 * Aaron, 2026-11-24: "Bluebeam markups are imported as flattened and embedded
 * into the document. I'd prefer them to be able to be directly manipulated and
 * assigned as area markups where applicable to scopes as takeoff members. I
 * want them to be natively integrated into the system and not read as an
 * embedded item."
 *
 * When a drawing opens, every other-app area and length on it (a polygon or
 * rectangle, cutouts included; a polyline or measured line) becomes a REDBEAM
 * markup with no scope, standing in for the annotation, which the viewer then
 * stops drawing. It comes in PENDING (origin `import`, review_state
 * `proposed`), out of every quantity, until somebody accepts it: by giving it a
 * scope, or with "Accept imported markups". Aaron, 2026-11-24: "They should
 * come in as pending and stay out of quantities until someone accepts them." It selects, moves, reshapes and takes a scope like anything
 * drawn here. The markup remembers the annotation's /NM and the revision it
 * was adopted at (`content.adopted`).
 *
 * The PDF stays the only record, and a markup must never be lost or doubled
 * between REDBEAM and Bluebeam, so saving follows three rules:
 *
 * - UNTOUCHED (still the adopted revision, still pending): nothing is written for it, and it
 *   is not kept in the slice. The annotation stays exactly as Bluebeam saved
 *   it, and the next open adopts it afresh, with whatever Bluebeam did since.
 * - CHANGED here (reshaped, moved, given a scope, accepted): written as a REDBEAM
 *   markup, and the original annotation is taken off the sheet (`retire`).
 * - DELETED here: the original annotation is taken off the sheet.
 *
 * Undo puts a deleted markup back as untouched, and then nothing is retired.
 * Undone after the delete was SAVED, the annotation is already off the sheet:
 * the save recorded the objects it took off (`adopted.gone`), and the next one
 * puts them back (an area or length is written as REDBEAM's instead).
 *
 * Everything else another app drew with an /NM (clouds, text boxes, arrows,
 * dimensions, stamps; Kenneth, 2026-11-26: "cannot delete or move them") is
 * held as an `annot` markup: not takeoff and not pending, drawn by the PDF
 * itself, its ring the annotation's /Rect and its colour in `content.annot`.
 * Moved or recoloured, the save rewrites that annotation IN PLACE
 * (annotRewrite.ts), so Bluebeam keeps its own markup; deleted, it is retired
 * like the rest. After each save the markup's record of the file
 * (`adopted.rev`, `annot.fileColor`) is brought up to what was written, so a
 * later undo back to the old place is a change to write too.
 */
import type { SqlDriver } from '@redbeam/store'
import { pageIdFor } from '@redbeam/store'
import { hash53, type SheetEmbedReading, type SliceTables } from './sheetEmbed.js'
import { markupRev } from './drawingEmbed.js'
import type { AnnotRewrite } from './annotRewrite.js'

/** What a markup carries when it stands for another app's annotation. */
export interface Adoption {
  nm: string
  rev: string
  /** The objects a save took off the sheet when this was deleted, as "12 0 R". */
  gone?: string[]
}

/** An `annot` markup's own record: its colour now, and the colour the file has. */
export interface HeldAnnot {
  color: string | null
  fileColor: string | null
  subtype: string
  /** The appearance's box, matrix and fill opacity, for a recolour on screen. */
  ap?: { bbox: number[], matrix: number[] | null, alpha: number } | null
}

function contentOf(content: unknown): Record<string, unknown> | null {
  let c: unknown = content
  if (typeof c === 'string') {
    try { c = JSON.parse(c) } catch { return null }
  }
  return c !== null && typeof c === 'object' ? c as Record<string, unknown> : null
}

/** `content.annot` of an `annot` markup, or null. */
export function heldOf(content: unknown): HeldAnnot | null {
  const a = contentOf(content)?.['annot']
  if (a === null || typeof a !== 'object') return null
  const h = a as Partial<HeldAnnot>
  const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null)
  return {
    color: hex(h.color), fileColor: hex(h.fileColor), subtype: typeof h.subtype === 'string' ? h.subtype : '',
    ...(h.ap === undefined ? {} : { ap: h.ap }),
  }
}

/** The markup id an annotation is adopted as: the same every open. */
export function adoptedId(documentId: string, nm: string): string {
  return `pdf-${nm}-${hash53(documentId).toString(36)}`
}

/** `content.adopted` from a markup's content, or null. */
export function adoptionOf(content: unknown): Adoption | null {
  const c = contentOf(content)
  if (c === null) return null
  const a = c['adopted']
  if (a === null || typeof a !== 'object') return null
  const { nm, rev, gone } = a as { nm?: unknown, rev?: unknown, gone?: unknown }
  if (typeof nm !== 'string' || nm === '' || typeof rev !== 'string') return null
  const refs = Array.isArray(gone) ? gone.filter((g): g is string => typeof g === 'string') : []
  return refs.length === 0 ? { nm, rev } : { nm, rev, gone: refs }
}

interface Row {
  id: string, kind: string, scope_id: string | null, geometry_json: string
  content_json?: string | null, review_state?: string | null
}

/**
 * True when an adopted markup is still exactly what was adopted: the same
 * shape, no scope, and not yet accepted. Accepting one is a change to keep.
 */
export function untouched(row: Row): boolean {
  const a = adoptionOf(row.content_json)
  if (a === null || a.gone !== undefined || markupRev(row) !== a.rev) return false
  if (row.kind === 'annot') {
    const h = heldOf(row.content_json)
    return h === null || h.color === null || h.color === h.fileColor
  }
  return (row.review_state ?? 'proposed') === 'proposed'
}

/** The normalized box of a ring. */
function boxOf(ring: ReadonlyArray<{ x: number, y: number }>): AnnotRewrite['rect'] | null {
  if (ring.length === 0) return null
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of ring) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
  }
  return { x0, y0, x1, y1 }
}

/** An `annot` markup's rectangle, normalized: its ring's box. */
export function heldRect(geometryJson: string): AnnotRewrite['rect'] | null {
  try {
    const rings = JSON.parse(geometryJson) as Array<Array<{ x: number, y: number }>>
    return Array.isArray(rings) && Array.isArray(rings[0]) ? boxOf(rings[0]) : null
  } catch {
    return null
  }
}

/** What a save wrote for an `annot` markup, to bring its record of the file up to date. */
export interface Rebase { id: string, rev: string, color: string | null }

/**
 * The slice to write, less the untouched adopted markups, and the /NMs of the
 * annotations to take off the sheet: those of adopted markups changed or
 * deleted here, unless a live markup still stands for the same annotation.
 */
export async function adoptedTables(
  db: SqlDriver,
  documentId: string,
  tables: SliceTables,
): Promise<{ tables: SliceTables, retire: string[], rewrite: AnnotRewrite[], rebase: Rebase[] }> {
  const live = (tables.markups ?? []) as unknown as Array<Row & { page_id?: string }>
  const keepNm = new Set<string>()
  const retire = new Set<string>()
  const kept: Array<Record<string, unknown>> = []
  const rewrite: AnnotRewrite[] = []
  const rebase: Rebase[] = []
  let pageNumbers: Map<string, number> | null = null
  for (const row of live) {
    const a = adoptionOf(row.content_json)
    if (a === null) { kept.push(row as unknown as Record<string, unknown>); continue }
    if (row.kind === 'annot') {
      // Never part of the slice: the annotation itself is the record.
      keepNm.add(a.nm)
      if (untouched(row)) continue
      const rect = heldRect(row.geometry_json)
      if (rect === null || row.page_id === undefined) continue
      if (pageNumbers === null) pageNumbers = await pagesOf(db, documentId)
      const pageIndex = pageNumbers.get(row.page_id)
      if (pageIndex === undefined) continue
      const held = heldOf(row.content_json)
      rewrite.push({
        pageIndex, nm: a.nm, rect, color: held?.color ?? null,
        ...(a.gone === undefined ? {} : { restore: a.gone }),
      })
      rebase.push({ id: row.id, rev: markupRev(row), color: held?.color ?? held?.fileColor ?? null })
      continue
    }
    if (untouched(row)) { keepNm.add(a.nm); continue }
    retire.add(a.nm)
    kept.push(row as unknown as Record<string, unknown>)
  }
  let gone: Array<{ content_json: string | null }> = []
  try {
    gone = await db.all<{ content_json: string | null }>(
      'SELECT content_json FROM markups WHERE document_id = ? AND deleted_at IS NOT NULL AND content_json LIKE ?',
      [documentId, '%"adopted"%'])
  } catch { gone = [] }
  for (const g of gone) {
    const a = adoptionOf(g.content_json)
    // Already off the sheet since a save recorded it gone: nothing to retire.
    if (a !== null && a.gone === undefined) retire.add(a.nm)
  }
  for (const nm of keepNm) retire.delete(nm)
  if (kept.length === live.length && retire.size === 0) return { tables, retire: [], rewrite, rebase }
  return { tables: { ...tables, markups: kept }, retire: [...retire].sort(), rewrite, rebase }
}

async function pagesOf(db: SqlDriver, documentId: string): Promise<Map<string, number>> {
  const rows = await db.all<{ id: string, page_number: number }>(
    'SELECT id, page_number FROM pages WHERE document_id = ?', [documentId])
  return new Map(rows.map((r) => [r.id, r.page_number]))
}

/**
 * After a save: the file now holds what was written. Each `annot` markup
 * rewritten records that as the file's state; each deleted one whose
 * annotation was taken off records what came off, so an undo can put it back.
 */
export async function rebaseAdopted(
  db: SqlDriver,
  documentId: string,
  written: readonly Rebase[],
  retired: Readonly<Record<string, readonly string[]>> | undefined,
): Promise<void> {
  const retiredNms = Object.keys(retired ?? {})
  if (written.length === 0 && retiredNms.length === 0) return
  const rows = await db.all<{ id: string, content_json: string | null, deleted_at: string | null }>(
    'SELECT id, content_json, deleted_at FROM markups WHERE document_id = ? AND content_json LIKE ?',
    [documentId, '%"adopted"%'])
  const byId = new Map(rows.map((r) => [r.id, r]))
  const save = async (id: string, content: Record<string, unknown>) => {
    await db.run('UPDATE markups SET content_json = ? WHERE id = ?', [JSON.stringify(content), id])
  }
  for (const w of written) {
    const row = byId.get(w.id)
    const c = contentOf(row?.content_json ?? null)
    if (row === undefined || c === null) continue
    const adopted: Record<string, unknown> = { ...(c['adopted'] as Record<string, unknown>), rev: w.rev }
    delete adopted['gone']
    const annot = { ...((c['annot'] as Record<string, unknown> | undefined) ?? {}), fileColor: w.color }
    await save(w.id, { ...c, adopted, annot })
  }
  if (retiredNms.length === 0) return
  for (const row of rows) {
    if (row.deleted_at === null) continue
    const a = adoptionOf(row.content_json)
    const refs = a === null ? undefined : retired?.[a.nm]
    const c = contentOf(row.content_json)
    if (refs === undefined || refs.length === 0 || c === null) continue
    await save(row.id, { ...c, adopted: { ...(c['adopted'] as Record<string, unknown>), gone: [...refs] } })
  }
}

export interface AdoptResult {
  /** Markups made this time. */
  added: number
  /** Of them, the other apps' markups held where they are (`annot`). */
  held: number
  /** Every /NM REDBEAM stands for on this drawing: the viewer stops drawing these. */
  nms: string[]
  /** Every /NM held as an `annot` markup: still drawn by the viewer, from the PDF. */
  heldNms: string[]
}

/**
 * Make the drawing's other-app areas and lengths into REDBEAM markups, unless
 * a markup (live or deleted) already stands for them. Rows go straight into
 * the store, not through the undo history: opening a file is not an edit, and
 * an untouched adopted markup is never written back.
 */
export async function adoptForeignAnnots(
  db: SqlDriver,
  documentId: string,
  reading: Pick<SheetEmbedReading, 'adoptable'>,
): Promise<AdoptResult> {
  const out: AdoptResult = { added: 0, held: 0, nms: [], heldNms: [] }
  if (reading.adoptable.length === 0) return out
  const have = await db.all<Row & { deleted_at: string | null }>(
    'SELECT id, kind, scope_id, geometry_json, content_json, review_state, deleted_at FROM markups WHERE document_id = ?', [documentId])
  const ids = new Map(have.map((r) => [r.id, r]))
  const now = new Date().toISOString()
  const seen = new Set<string>()
  await db.exec('BEGIN')
  try {
    for (const f of reading.adoptable) {
      if (seen.has(f.nm)) continue
      seen.add(f.nm)
      if (f.kind === 'annot') out.heldNms.push(f.nm)
      else out.nms.push(f.nm)
      const id = adoptedId(documentId, f.nm)
      const geometry = JSON.stringify(f.rings)
      const rev = markupRev({ kind: f.kind, scope_id: null, geometry_json: geometry })
      const annot: HeldAnnot | null = f.kind === 'annot'
        ? { color: f.color, fileColor: f.color, subtype: f.subtype, ap: f.ap ?? null }
        : null
      const content = {
        source: 'pdf-annotation', subtype: f.subtype, subject: f.subject, label: f.label,
        contents: f.contents, author: f.author, color: f.color,
        ...(annot === null ? {} : { annot }),
        adopted: { nm: f.nm, rev },
      }
      const prior = ids.get(id)
      if (prior !== undefined) {
        // Opened again in this window: a held markup nobody has changed here
        // takes the file as it is now, whatever another app did since.
        if (f.kind === 'annot' && prior.kind === 'annot' && prior.deleted_at === null && untouched(prior)) {
          await db.run('UPDATE markups SET geometry_json = ?, content_json = ? WHERE id = ?', [geometry, JSON.stringify(content), id])
        }
        continue
      }
      const pageId = pageIdFor(documentId, f.pageIndex)
      await db.run(
        `INSERT OR IGNORE INTO pages(id, document_id, page_number, width_pdf_points, height_pdf_points, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?)`, [pageId, documentId, f.pageIndex, f.width, f.height, now, now])
      await db.run(
        `INSERT INTO markups(id, document_id, page_id, scope_id, kind, geometry_json, style_json, content_json, origin, review_state, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        // Held markups are not takeoff, so there is nothing to accept: they
        // come in as they are, never pending.
        [id, documentId, pageId, null, f.kind, geometry, '{}', JSON.stringify(content), 'import', f.kind === 'annot' ? 'accepted' : 'proposed', now, now])
      out.added++
      if (f.kind === 'annot') out.held++
    }
    await db.exec('COMMIT')
  } catch (err) {
    await db.exec('ROLLBACK')
    throw err
  }
  return out
}
