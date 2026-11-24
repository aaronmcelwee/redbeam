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
 */
import type { SqlDriver } from '@redbeam/store'
import { pageIdFor } from '@redbeam/store'
import { hash53, type SheetEmbedReading, type SliceTables } from './sheetEmbed.js'
import { markupRev } from './drawingEmbed.js'

/** What a markup carries when it stands for another app's annotation. */
export interface Adoption { nm: string, rev: string }

/** The markup id an annotation is adopted as: the same every open. */
export function adoptedId(documentId: string, nm: string): string {
  return `pdf-${nm}-${hash53(documentId).toString(36)}`
}

/** `content.adopted` from a markup's content, or null. */
export function adoptionOf(content: unknown): Adoption | null {
  let c: unknown = content
  if (typeof c === 'string') {
    try { c = JSON.parse(c) } catch { return null }
  }
  if (c === null || typeof c !== 'object') return null
  const a = (c as { adopted?: unknown }).adopted
  if (a === null || typeof a !== 'object') return null
  const { nm, rev } = a as { nm?: unknown, rev?: unknown }
  return typeof nm === 'string' && nm !== '' && typeof rev === 'string' ? { nm, rev } : null
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
  return a !== null && markupRev(row) === a.rev && (row.review_state ?? 'proposed') === 'proposed'
}

/**
 * The slice to write, less the untouched adopted markups, and the /NMs of the
 * annotations to take off the sheet: those of adopted markups changed or
 * deleted here, unless a live markup still stands for the same annotation.
 */
export async function adoptedTables(
  db: SqlDriver,
  documentId: string,
  tables: SliceTables,
): Promise<{ tables: SliceTables, retire: string[] }> {
  const live = (tables.markups ?? []) as unknown as Row[]
  const keepNm = new Set<string>()
  const retire = new Set<string>()
  const kept: Array<Record<string, unknown>> = []
  for (const row of live) {
    const a = adoptionOf(row.content_json)
    if (a === null) { kept.push(row as unknown as Record<string, unknown>); continue }
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
    if (a !== null) retire.add(a.nm)
  }
  for (const nm of keepNm) retire.delete(nm)
  if (kept.length === live.length && retire.size === 0) return { tables, retire: [] }
  return { tables: { ...tables, markups: kept }, retire: [...retire].sort() }
}

export interface AdoptResult {
  /** Markups made this time. */
  added: number
  /** Every /NM REDBEAM stands for on this drawing: the viewer stops drawing these. */
  nms: string[]
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
  const out: AdoptResult = { added: 0, nms: [] }
  if (reading.adoptable.length === 0) return out
  const have = await db.all<{ id: string }>('SELECT id FROM markups WHERE document_id = ?', [documentId])
  const ids = new Set(have.map((r) => r.id))
  const now = new Date().toISOString()
  const seen = new Set<string>()
  await db.exec('BEGIN')
  try {
    for (const f of reading.adoptable) {
      if (seen.has(f.nm)) continue
      seen.add(f.nm)
      out.nms.push(f.nm)
      const id = adoptedId(documentId, f.nm)
      if (ids.has(id)) continue
      const pageId = pageIdFor(documentId, f.pageIndex)
      await db.run(
        `INSERT OR IGNORE INTO pages(id, document_id, page_number, width_pdf_points, height_pdf_points, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?)`, [pageId, documentId, f.pageIndex, f.width, f.height, now, now])
      const geometry = JSON.stringify(f.rings)
      const rev = markupRev({ kind: f.kind, scope_id: null, geometry_json: geometry })
      const content = {
        source: 'pdf-annotation', subtype: f.subtype, subject: f.subject, label: f.label,
        contents: f.contents, author: f.author, color: f.color,
        adopted: { nm: f.nm, rev },
      }
      await db.run(
        `INSERT INTO markups(id, document_id, page_id, scope_id, kind, geometry_json, style_json, content_json, origin, review_state, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, documentId, pageId, null, f.kind, geometry, '{}', JSON.stringify(content), 'import', 'proposed', now, now])
      out.added++
    }
    await db.exec('COMMIT')
  } catch (err) {
    await db.exec('ROLLBACK')
    throw err
  }
  return out
}
