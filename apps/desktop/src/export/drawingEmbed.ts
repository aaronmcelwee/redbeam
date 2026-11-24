/**
 * Between redbeam.db and a drawing's embedded takeoff.
 *
 * `sheetEmbed` knows PDF and nothing about a project. This is the other half:
 * which rows of redbeam.db make up one drawing's slice, what each markup's
 * Bluebeam annotation should say, when the file needs writing at all, and how
 * a slice found in a PDF gets back into a database that has nothing for it.
 *
 * Everything that touches the outside world arrives as an argument — the
 * database, reading and writing the file — so it runs under test with sql.js
 * and an in-memory "disk".
 */
import type { SqlDriver } from '@redbeam/store'
import { pageIdFor, pageNumberFrom } from '@redbeam/store'
import { cutAreas, polylineLength, regionArea, ringsOverlap, squarePointsToSquareFeet } from '@redbeam/domain'
import {
  embedSheet, hash53, readSheetEmbed, type EmbedInput, type EmbedMarkup, type EmbedResult, type SheetEmbedReading, type SheetSlice, type SliceTables,
} from './sheetEmbed.js'
import { adoptedTables } from './adopt.js'
import type { WritableScaleRegion } from './pdfMarkup.js'

/**
 * The tables a drawing's slice is cut from, and how each is filtered to it.
 *
 * Scope rows travel whole (specifications, layout settings) because a markup
 * without its scope is a shape without a meaning. Calculation runs travel for
 * the scopes on this sheet, with their quantity results (the counts) and only
 * THIS drawing's layout components.
 */
const SLICE_QUERIES: ReadonlyArray<readonly [string, string]> = [
  ['documents', 'SELECT * FROM documents WHERE id = ?1'],
  ['pages', 'SELECT * FROM pages WHERE document_id = ?1'],
  ['calibrations', 'SELECT * FROM calibrations WHERE document_id = ?1'],
  ['scale_regions', 'SELECT * FROM scale_regions WHERE document_id = ?1'],
  ['markups', 'SELECT * FROM markups WHERE document_id = ?1 AND deleted_at IS NULL'],
  ['scopes', `SELECT * FROM scopes WHERE id IN (
     SELECT scope_id FROM markups WHERE document_id = ?1 AND deleted_at IS NULL AND scope_id IS NOT NULL)`],
  ['calculation_runs', `SELECT * FROM calculation_runs WHERE scope_id IN (
     SELECT scope_id FROM markups WHERE document_id = ?1 AND deleted_at IS NULL AND scope_id IS NOT NULL)`],
  ['quantity_results', `SELECT * FROM quantity_results WHERE calculation_run_id IN (
     SELECT id FROM calculation_runs WHERE scope_id IN (
       SELECT scope_id FROM markups WHERE document_id = ?1 AND deleted_at IS NULL AND scope_id IS NOT NULL))`],
  ['layout_components', 'SELECT * FROM layout_components WHERE document_id = ?1'],
  /*
   * Who changed what, and when (Aaron, 2026-11-24: "That would have answered
   * straight away who deleted the markup from Dave's file"). The trail rides
   * in the PDF with the takeoff, so it survives the session; the newest 5000
   * entries, which is years of a busy estimate.
   */
  ['activity', 'SELECT * FROM activity ORDER BY created_at DESC LIMIT 5000'],
]

/**
 * The same, for a Light-mode file: every live scope travels, drawn on or not.
 *
 * In Light mode the store is in memory and holds this one PDF, so its scopes
 * ARE the file's scopes (Aaron, 2026-11-18: "each file has its own scopes").
 * A scope made but not yet drawn, or brought in from last round's PDF, has to
 * survive the save, which the markup-filtered queries above would drop. Pro
 * keeps those queries: there the scopes are the whole job's, and every sheet
 * carrying all of them would be wrong.
 */
const LIGHT_SLICE_QUERIES: ReadonlyArray<readonly [string, string]> = SLICE_QUERIES.map(([table, sql]) => {
  if (table === 'scopes') return [table, 'SELECT * FROM scopes WHERE archived_at IS NULL'] as const
  if (table === 'calculation_runs') {
    return [table, 'SELECT * FROM calculation_runs WHERE scope_id IN (SELECT id FROM scopes WHERE archived_at IS NULL)'] as const
  }
  if (table === 'quantity_results') {
    return [table, `SELECT * FROM quantity_results WHERE calculation_run_id IN (
       SELECT id FROM calculation_runs WHERE scope_id IN (SELECT id FROM scopes WHERE archived_at IS NULL))`] as const
  }
  return [table, sql] as const
})

/** Volatile columns that change without the takeoff changing. */
const VOLATILE = new Set(['modified_at_observed', 'content_fingerprint', 'size_bytes', 'availability',
  'text_indexed_at', 'updated_at'])

/** This drawing's rows of redbeam.db. A table the database lacks is left out. */
export async function sliceTables(
  db: SqlDriver,
  documentId: string,
  opts: { allScopes?: boolean } = {},
): Promise<SliceTables> {
  const out: SliceTables = {}
  for (const [table, sql] of opts.allScopes === true ? LIGHT_SLICE_QUERIES : SLICE_QUERIES) {
    try {
      const rows = await db.all<Record<string, unknown>>(sql.replace(/\?1/g, '?'),
        Array.from({ length: (sql.match(/\?1/g) ?? []).length }, () => documentId))
      out[table] = rows.map((r) => {
        const row: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(r)) if (!VOLATILE.has(k) || table !== 'documents') row[k] = v
        return row
      })
    } catch {
      // An older database without that table simply has nothing to carry.
    }
  }
  return out
}

interface MarkupRowLike {
  id: string
  page_id: string
  scope_id: string | null
  kind: string
  geometry_json: string
}

interface ScopeRowLike { id: string, label: string, color: string }

const parseRings = (json: string): Array<Array<{ x: number, y: number }>> => {
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? v as Array<Array<{ x: number, y: number }>> : []
  } catch {
    return []
  }
}

/**
 * A markup's revision: what it is in redbeam.db, as one hash. Recorded in the
 * slice beside the annotation written from it, so a later reading can tell
 * "the annotation changed and the markup did not" (an edit made in another
 * app) from "both changed" (a conflict REDBEAM leaves alone).
 */
export function markupRev(row: { kind: string, scope_id: string | null, geometry_json: string }): string {
  let rings: unknown = []
  try { rings = JSON.parse(row.geometry_json) } catch { rings = row.geometry_json }
  return hash53(JSON.stringify([row.kind, row.scope_id ?? '', rings])).toString(16)
}

/**
 * The Bluebeam-facing markups for a slice: one per takeoff markup, with the
 * scope as its label and its NET quantity.
 *
 * An area's openings travel as Revu's own cutouts on the area (`cutouts`, which
 * sheetEmbed writes as /Cutouts), so Bluebeam shows one area with holes and
 * measures it net: the area's own hole rings, and every separate cutout markup
 * of the same scope on the same sheet that overlaps it. A cutout folded into
 * an area is not written again on its own; one that overlaps no area still is,
 * as the deduction it was drawn as.
 */
export function embedMarkupsFor(tables: SliceTables, documentId: string): {
  markups: EmbedMarkup[]
  pageScales: Map<number, number>
  pageRegions: Map<number, WritableScaleRegion[]>
} {
  const scopes = new Map((tables.scopes ?? []).map((s) => [String(s.id), s as unknown as ScopeRowLike]))
  const boxes = new Map((tables.pages ?? []).map((p) => [String(p.id), {
    width: Number(p.width_pdf_points ?? 0), height: Number(p.height_pdf_points ?? 0),
  }]))
  const fppByPage = new Map((tables.calibrations ?? []).map((c) => [String(c.page_id), Number(c.feet_per_pdf_point)]))

  const pageScales = new Map<number, number>()
  for (const [pageId, fpp] of fppByPage) {
    const i = pageNumberFrom(pageId, documentId)
    if (i !== null && fpp > 0) pageScales.set(i, fpp)
  }
  const pageRegions = new Map<number, WritableScaleRegion[]>()
  for (const r of tables.scale_regions ?? []) {
    const i = pageNumberFrom(String(r.page_id), documentId)
    if (i === null) continue
    const list = pageRegions.get(i) ?? []
    list.push({
      rect: { x0: Number(r.x0), y0: Number(r.y0), x1: Number(r.x1), y1: Number(r.y1) },
      feetPerPoint: Number(r.feet_per_pdf_point),
      label: String(r.label ?? ''),
    })
    pageRegions.set(i, list)
  }

  const rows = ((tables.markups ?? []) as unknown as MarkupRowLike[])
    .map((raw) => ({ raw, rings: parseRings(raw.geometry_json) }))
    .filter((r) => r.rings.length > 0 && pageNumberFrom(r.raw.page_id, documentId) !== null)

  // Which separate cutouts open which area: same sheet, same scope, overlapping.
  // Overlap is judged in points, so a tall sheet's aspect cannot fake it.
  const inPoints = (ring: ReadonlyArray<{ x: number, y: number }>, pageId: string) => {
    const box = boxes.get(pageId)
    const w = box !== undefined && box.width > 0 ? box.width : 1
    const h = box !== undefined && box.height > 0 ? box.height : 1
    return ring.map((p) => ({ x: p.x * w, y: p.y * h }))
  }
  const cutoutRows = rows.filter((r) => r.raw.kind === 'cutout')
  const foldedInto = new Map<string, typeof cutoutRows>()
  const foldedIds = new Set<string>()
  for (const area of rows) {
    if (area.raw.kind !== 'area') continue
    const outline = inPoints(area.rings[0]!, area.raw.page_id)
    const mine = cutoutRows.filter((c) => c.raw.page_id === area.raw.page_id && c.raw.scope_id === area.raw.scope_id
      && c.rings[0] !== undefined && c.rings[0].length >= 3 && ringsOverlap(inPoints(c.rings[0], c.raw.page_id), outline))
    if (mine.length === 0) continue
    foldedInto.set(area.raw.id, mine)
    for (const c of mine) foldedIds.add(c.raw.id)
  }

  const markups: EmbedMarkup[] = []
  for (const { raw, rings } of rows) {
    if (raw.kind === 'cutout' && foldedIds.has(raw.id)) continue
    const pageIndex = pageNumberFrom(raw.page_id, documentId)!
    const scope = raw.scope_id === null ? undefined : scopes.get(raw.scope_id)
    const label = scope?.label ?? 'Unassigned'
    const color = scope?.color ?? '#888888'
    const box = boxes.get(raw.page_id)
    const fpp = fppByPage.get(raw.page_id)
    const folded = foldedInto.get(raw.id) ?? []
    const cutouts = raw.kind === 'area'
      ? [...rings.slice(1), ...folded.map((c) => c.rings[0]!)]
      : []
    let quantity: number | null = null
    if (box !== undefined && box.width > 0 && box.height > 0 && fpp !== undefined) {
      if (raw.kind === 'area') {
        const own = rings.map((ring) => inPoints(ring, raw.page_id))
        // The outline less its own cuts and any folded cutouts (cuts.ts).
        const region = cutAreas([own], folded.map((c) => inPoints(c.rings[0]!, raw.page_id)))
        quantity = squarePointsToSquareFeet(regionArea(region), fpp)
      } else if (raw.kind === 'polyline') {
        quantity = polylineLength([...rings[0]!], box.width, box.height) * fpp
      }
    }
    if (raw.kind === 'count') quantity = 1
    markups.push({
      id: raw.id, pageIndex, kind: raw.kind, rings: [rings[0]!], scopeLabel: label, color, quantity,
      rev: markupRev(raw),
      ...(cutouts.length === 0 ? {} : { cutouts }),
      ...(folded.length === 0 ? {} : { folded: folded.map((c) => c.raw.id) }),
    })
  }
  return { markups, pageScales, pageRegions }
}

/** A change to one markup that was made in another app, ready to apply. */
export interface ForeignEdit {
  markupId: string
  before: Array<Array<{ x: number, y: number }>>
  after: Array<Array<{ x: number, y: number }>>
}

export interface ForeignEdits {
  /** Markups whose shape was changed in Bluebeam and not since in REDBEAM. */
  edits: ForeignEdit[]
  /**
   * Separate cutout markups that went out inside an edited area's /Cutouts.
   * The area now carries whatever cutouts Bluebeam left it, so these are
   * removed rather than counted twice.
   */
  absorbed: string[]
  /** Changed in Bluebeam AND in REDBEAM since: left alone, REDBEAM's kept. */
  conflicts: string[]
}

/**
 * What was done in Bluebeam (or any app that keeps REDBEAM's annotations) to
 * the markups REDBEAM put on this drawing, as edits to the markups.
 *
 * An annotation whose fingerprint differs from the one recorded when it was
 * written was edited there. It is taken only when the markup is still the
 * revision it was written from: then the other app's version is the newer one.
 * When both changed, REDBEAM's is kept and the clash reported. An area takes
 * the outline and every /Cutouts opening as its rings, so a cutout added,
 * moved or removed in Bluebeam arrives as one area with those holes.
 *
 * Pure: `rows` are this drawing's markups as redbeam.db has them now.
 */
export function foreignEdits(
  reading: SheetEmbedReading,
  rows: ReadonlyArray<{ id: string, kind: string, scope_id: string | null, geometry_json: string }>,
): ForeignEdits {
  const out: ForeignEdits = { edits: [], absorbed: [], conflicts: [] }
  const slice = reading.slice
  if (slice === null) return out
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const a of reading.redbeamAnnots) {
    const recorded = slice.annots[a.nm]
    if (recorded === undefined || recorded.fp === a.fp) continue
    const row = byId.get(recorded.markupId)
    if (row === undefined || recorded.rev === undefined) continue
    if (markupRev(row) !== recorded.rev) { out.conflicts.push(row.id); continue }
    if (a.rings.length === 0) continue
    const min = row.kind === 'polyline' ? 2 : 3
    const outline = a.rings[0]!
    if (outline.length < min) continue
    const after = row.kind === 'area'
      ? [outline, ...a.rings.slice(1).filter((r) => r.length >= 3)]
      : row.kind === 'polyline' || row.kind === 'cutout' || row.kind === 'shape' ? [outline] : null
    if (after === null) continue
    out.edits.push({ markupId: row.id, before: parseRings(row.geometry_json), after })
    for (const id of recorded.folded ?? []) if (byId.has(id)) out.absorbed.push(id)
  }
  return out
}

export interface DrawingFile {
  /** The drawing's bytes as they are now, and a token naming that version. */
  read: () => Promise<{ bytes: Uint8Array, version: string }>
  /**
   * Replace the drawing, but only if it is still the version `read` returned.
   * Resolves false when somebody (Bluebeam, OneDrive) changed it in between.
   * `appendsAt`, when given, says `bytes` is the version `read` returned
   * (that many bytes long) with more after it, so only the rest need writing.
   */
  write: (bytes: Uint8Array, expectedVersion: string, appendsAt?: number) => Promise<boolean>
  /**
   * Hands back bytes `read` gave out that were not written (the takeoff was
   * already in the file), so a file that keeps its last version in memory
   * can keep it. Optional.
   */
  keep?: (bytes: Uint8Array, version: string) => void
  /**
   * True when the last `read` came from memory rather than the disk. A write
   * refused after such a read is tried once more from a fresh read: the file
   * may simply have been saved by something else since.
   */
  fromMemory?: () => boolean
}

/**
 * Builds the PDF with the takeoff in it. `embedSheet` by default; the app
 * passes one that runs in a worker, which may take ownership of `source`
 * and so hands it (or a copy) back.
 */
export type SheetEmbedder = (source: Uint8Array, input: EmbedInput) => Promise<{
  result: EmbedResult
  source: Uint8Array
  /**
   * Set when `result.bytes` is `source` with more added after it, checked byte
   * for byte: the length of `source`. A file that can append (see
   * `DrawingFile.write`) then writes only what comes after it.
   */
  appendsAt?: number
}>

const embedHere: SheetEmbedder = async (source, input) => ({ result: await embedSheet(source, input), source })

export type EmbedOutcome =
  /** Light: not attempted, because the file's own takeoff is not (yet) in the window. */
  | { kind: 'held', reason: string | null }
  | { kind: 'written', editedElsewhere: string[], foreignKept: number, stamp?: string | null }
  | { kind: 'unchanged', stamp?: string | null }
  /** Light: the PDF now carries a takeoff someone else saved since this window read it. Not written. */
  | { kind: 'elsewhere' }
  | { kind: 'nothing-to-embed' }
  | { kind: 'busy' }
  | { kind: 'failed', message: string }

/**
 * Write a drawing's slice into its PDF, if it needs it.
 *
 * A drawing REDBEAM has never marked up and that carries nothing of ours is
 * left alone: writing an empty slice into every sheet somebody merely opened
 * would touch hundreds of synced files for nothing.
 */
export async function embedDrawing(opts: EmbedDrawingOptions): Promise<EmbedOutcome> {
  const first = await embedDrawingOnce(opts)
  // A write refused after a read from memory: read the disk and try once more.
  if (first.kind === 'busy' && opts.file.fromMemory?.() === true) return embedDrawingOnce(opts)
  return first
}

export interface EmbedDrawingOptions {
  db: SqlDriver
  documentId: string
  relativePath: string
  displayName: string
  appVersion: string
  file: DrawingFile
  /** Light mode: the file carries every live scope, drawn on or not. */
  allScopes?: boolean
  /** Where the PDF is built; in this thread when left out. */
  embed?: SheetEmbedder
  /** Light mode: the takeoff this window last saw in the file; see `EmbedInput.expectStamp`. */
  expectStamp?: string | null
  /** Sheets turned in REDBEAM, page index to degrees; see `EmbedInput.pageRotations`. */
  pageRotations?: ReadonlyMap<number, number>
}

async function embedDrawingOnce(opts: EmbedDrawingOptions): Promise<EmbedOutcome> {
  const { tables, retire } = await adoptedTables(opts.db, opts.documentId,
    await sliceTables(opts.db, opts.documentId, { allScopes: opts.allScopes === true }))
  const { markups, pageScales, pageRegions } = embedMarkupsFor(tables, opts.documentId)

  let current: { bytes: Uint8Array, version: string }
  try {
    current = await opts.file.read()
  } catch (err) {
    return { kind: 'failed', message: err instanceof Error ? err.message : String(err) }
  }

  try {
    if (markups.length === 0 && (tables.scopes ?? []).length === 0 && (opts.pageRotations?.size ?? 0) === 0 && retire.length === 0) {
      // Nothing of ours to show; only write if the file still shows OLD ours.
      const before = await readSheetEmbed(current.bytes)
      if (before.slice === null && before.redbeamAnnots.length === 0) {
        opts.file.keep?.(current.bytes, current.version)
        return { kind: 'nothing-to-embed' }
      }
    }
    const { result, source, appendsAt } = await (opts.embed ?? embedHere)(current.bytes, {
      documentId: opts.documentId,
      relativePath: opts.relativePath,
      displayName: opts.displayName,
      appVersion: opts.appVersion,
      tables,
      markups,
      pageScales,
      pageRegions,
      ...(retire.length === 0 ? {} : { retire }),
      ...(opts.pageRotations === undefined ? {} : { pageRotations: opts.pageRotations }),
      ...(opts.expectStamp === undefined ? {} : { expectStamp: opts.expectStamp }),
    })
    if (result.bytes === null) opts.file.keep?.(source, current.version)
    if (result.conflict === true) return { kind: 'elsewhere' }
    if (result.bytes === null) return { kind: 'unchanged', stamp: result.stamp }
    const ok = await opts.file.write(result.bytes, current.version, appendsAt)
    if (!ok) return { kind: 'busy' }
    return { kind: 'written', editedElsewhere: result.editedElsewhere, foreignKept: result.foreignKept, stamp: result.stamp }
  } catch (err) {
    return { kind: 'failed', message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The drawing with this window's takeoff in it, as bytes to save somewhere else.
 *
 * Aaron, 2026-11-19: "offer to save a copy elsewhere. Don't ever refuse to
 * save." When the PDF itself cannot take the takeoff (open in another app,
 * read-only, or carrying a takeoff this build could not read and so must not
 * overwrite), the work still has to land somewhere. The original is only
 * read. A drawing that already says exactly this comes back as it is.
 */
export async function embedCopy(opts: {
  db: SqlDriver
  documentId: string
  relativePath: string
  displayName: string
  appVersion: string
  read: () => Promise<Uint8Array>
  allScopes?: boolean
  pageRotations?: ReadonlyMap<number, number>
  /** Leave every other app's markups out of the copy. */
  withoutForeign?: boolean
}): Promise<Uint8Array> {
  const { tables, retire } = await adoptedTables(opts.db, opts.documentId,
    await sliceTables(opts.db, opts.documentId, { allScopes: opts.allScopes === true }))
  const { markups, pageScales, pageRegions } = embedMarkupsFor(tables, opts.documentId)
  const source = await opts.read()
  const result = await embedSheet(source, {
    documentId: opts.documentId, relativePath: opts.relativePath, displayName: opts.displayName,
    appVersion: opts.appVersion, tables, markups, pageScales, pageRegions,
    ...(retire.length === 0 ? {} : { retire }),
    ...(opts.pageRotations === undefined ? {} : { pageRotations: opts.pageRotations }),
    ...(opts.withoutForeign === true ? { retireForeign: true } : {}),
  })
  return result.bytes ?? source
}

/** The name offered for a copy: "A-101.pdf" becomes "A-101 (takeoff).pdf". */
export function copyName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '')
  return /\.pdf$/i.test(base) ? base.replace(/\.pdf$/i, ' (takeoff).pdf') : `${base} (takeoff).pdf`
}

/** The redbeam_meta key listing the drawings the on-open migration has finished. */
export const MIGRATED_KEY = 'pdf_embed_migrated'

export interface MigrationDrawing { id: string, relativePath: string, displayName: string, missing?: boolean }

export interface MigrationResult {
  /** Drawings whose PDF was written by this pass. */
  written: string[]
  /** Drawings that could not be written this time (open elsewhere, unreadable); retried next open. */
  retry: Array<{ name: string, outcome: EmbedOutcome }>
}

async function readMigrated(db: SqlDriver): Promise<Set<string>> {
  try {
    const rows = await db.all<{ value: string }>('SELECT value FROM redbeam_meta WHERE key = ?', [MIGRATED_KEY])
    const v = rows[0] === undefined ? [] : JSON.parse(rows[0].value) as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * Carry an older project's takeoffs into its drawings, once, when it opens.
 *
 * Projects from before 0.3.7 keep every takeoff only in redbeam.db; their PDFs
 * carry nothing, so Bluebeam (or another job folder) sees a bare sheet until
 * someone happens to open and leave each drawing in REDBEAM. This pass embeds
 * every drawing that has takeoff in the database and has not been done yet.
 *
 * Nothing is moved OUT of redbeam.db: it stays the record and the embed is a
 * copy, so a failed or refused write loses nothing. Each write is the same
 * guarded one as leaving a drawing (incremental update, refused if the file
 * changed since it was read, temp file + rename on disk). A drawing is marked
 * done only once its PDF holds the takeoff or there was nothing to write, so a
 * drawing open in Bluebeam is simply tried again next time. Running it twice
 * is harmless: an already-embedded drawing comes back `unchanged`.
 *
 * `exclusive` lets the caller queue each write behind any other write to the
 * same drawing (leaving it, closing it) so two never race.
 */
export async function migrateProjectTakeoffs(opts: {
  db: SqlDriver
  documents: readonly MigrationDrawing[]
  appVersion: string
  fileFor: (doc: MigrationDrawing) => DrawingFile
  exclusive?: (docId: string, task: () => Promise<EmbedOutcome>) => Promise<EmbedOutcome>
  cancelled?: () => boolean
}): Promise<MigrationResult> {
  const result: MigrationResult = { written: [], retry: [] }
  let withTakeoff: Set<string>
  try {
    const rows = await opts.db.all<{ id: string }>(
      'SELECT DISTINCT document_id AS id FROM markups WHERE deleted_at IS NULL')
    withTakeoff = new Set(rows.map((r) => r.id))
  } catch {
    return result
  }
  const done = await readMigrated(opts.db)
  const todo = opts.documents.filter((d) => withTakeoff.has(d.id) && !done.has(d.id) && d.missing !== true)
  if (todo.length === 0) return result

  for (const doc of todo) {
    if (opts.cancelled?.() === true) break
    const name = doc.displayName || doc.relativePath
    const task = () => embedDrawing({
      db: opts.db, documentId: doc.id, relativePath: doc.relativePath, displayName: name,
      appVersion: opts.appVersion, file: opts.fileFor(doc),
    })
    const outcome = opts.exclusive === undefined ? await task() : await opts.exclusive(doc.id, task)
    if (outcome.kind === 'written') result.written.push(name)
    if (outcome.kind === 'busy' || outcome.kind === 'failed') {
      result.retry.push({ name, outcome })
      continue
    }
    done.add(doc.id)
    // Recorded after every drawing, so quitting halfway keeps what was done.
    await opts.db.run('INSERT OR REPLACE INTO redbeam_meta(key, value) VALUES(?, ?)',
      [MIGRATED_KEY, JSON.stringify([...done].sort())])
  }
  return result
}

/** A short line for the status bar after the on-open migration, or null for silence. */
export function migrationStatus(result: MigrationResult): string | null {
  const parts: string[] = []
  if (result.written.length > 0) {
    parts.push(result.written.length === 1
      ? `older takeoff saved into ${result.written[0]}`
      : `older takeoffs saved into ${result.written.length} drawings`)
  }
  if (result.retry.length > 0) {
    const first = result.retry[0]!
    parts.push(result.retry.length === 1
      ? `${first.name} could not take its takeoff yet (open in Bluebeam?); REDBEAM will try again next time the project opens`
      : `${result.retry.length} drawings could not take their takeoff yet (open in Bluebeam?); REDBEAM will try again next time the project opens`)
  }
  return parts.length === 0 ? null : parts.join('. ')
}

/** Order matters: a row's parents go in before it does. */
const IMPORT_ORDER = ['scopes', 'calibrations', 'scale_regions', 'markups',
  'calculation_runs', 'quantity_results', 'layout_components', 'activity'] as const

const IDENT = /^[a-z_][a-z0-9_]*$/

/** Tables holding what a person made, which nothing can work out again. */
const HAND_MADE = new Set(['scopes', 'calibrations', 'scale_regions', 'markups'])

/**
 * Re-key a slice's rows onto this project's document.
 *
 * The slice was written in some other job folder, where the drawing had some
 * other id. Page ids are built from the document id, so they are rewritten
 * with it; every other id (markups, scopes, runs) is a UUID and carries over.
 */
function rekey(row: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  if (from === to) return row
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (k === 'document_id' && v === from) out[k] = to
    else if (k === 'page_id' && typeof v === 'string' && v.startsWith(`${from}-p`)) out[k] = `${to}-p${v.slice(from.length + 2)}`
    else out[k] = v
  }
  return out
}

export interface ImportOutcome {
  markups: number
  scopes: number
  /** Rows of the slice this database could not take. Absent when it took all of them. */
  skipped?: number
}

/** Whether a Light file's takeoff is in the window, so the window may save over the file's. */
export type FileLoad = { state: 'loaded' } | { state: 'blocked', reason: string }

/**
 * Light mode: may this window save into the PDF it just opened?
 *
 * The window's store starts empty and is filled from the PDF. A save made
 * from a store that never received the file's takeoff, or only part of it,
 * would write that emptiness over the takeoff. So a file is saved into only
 * once everything it carried is known to be in the window; anything less
 * leaves the file exactly as it was found and says why.
 */
export function fileLoadVerdict(
  reading: SheetEmbedReading, imported: ImportOutcome | null, name: string, rebuilt: RebuiltTakeoff | null = null,
): FileLoad {
  // Every REDBEAM annotation the file shows is in the window as a markup, so a save puts back all of it.
  if (reading.privateDataLost && !reading.sliceTooNew && rebuilt !== null) return { state: 'loaded' }
  if (reading.sliceTooNew) {
    return { state: 'blocked', reason: `${name} was saved by a newer REDBEAM than this one. Update REDBEAM to work on it. This version will not save into it, so its takeoff is safe; what you draw here can be saved as a copy.` }
  }
  if (reading.privateDataLost) {
    return { state: 'blocked', reason: `${name} was saved by another app that dropped REDBEAM's takeoff detail, so the takeoff could not be loaded. REDBEAM will not save into it, so the markups it still shows are kept; what you draw here can be saved as a copy.` }
  }
  if (reading.slice !== null && imported === null) {
    return { state: 'blocked', reason: `The takeoff inside ${name} could not be loaded. REDBEAM will not save into it, so it stays as it is; what you draw here can be saved as a copy. Close and reopen the file to try again.` }
  }
  if ((imported?.skipped ?? 0) > 0) {
    return { state: 'blocked', reason: `Part of the takeoff inside ${name} could not be loaded (${imported!.skipped} item${imported!.skipped === 1 ? '' : 's'}). REDBEAM will not save into it, so it stays as it is; what you draw here can be saved as a copy.` }
  }
  return { state: 'loaded' }
}

export interface RebuiltTakeoff {
  markups: number
  scopes: number
  /** Sheets with measured markups whose scale the file no longer says. */
  unscaled: number
}

const DEDUCTION = /\s\(deduction\)$/i
const finiteRing = (ring: ReadonlyArray<{ x: number, y: number }>): boolean =>
  ring.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))

/**
 * Light mode: put a takeoff back together from REDBEAM's own annotations.
 *
 * Another app (Bluebeam flattening or re-saving, a PDF optimizer) can keep
 * the markups REDBEAM drew and drop the private data that said what they
 * were. Aaron, 2026-11-19: the takeoff must "survive across different REDBEAM
 * as well as Bluebeam sessions." What the annotations still say is enough for
 * the takeoff itself: each one's shape, its scope by name and colour, and the
 * sheet's scale from REDBEAM's viewports. A scope's product specifications
 * were only ever in the private data and are not recovered.
 *
 * All or nothing. The next save replaces REDBEAM's annotations with ones
 * written from the markups, so an annotation that could not be turned back
 * into a markup would be deleted by it. If any one cannot be read, nothing is
 * rebuilt and the file stays blocked, exactly as it was found.
 */
export async function rebuildFromAnnots(
  db: SqlDriver,
  documentId: string,
  reading: SheetEmbedReading,
): Promise<RebuiltTakeoff | null> {
  if (!reading.privateDataLost || reading.sliceTooNew || reading.redbeamAnnots.length === 0) return null
  const existing = await db.all<{ n: number }>(
    'SELECT COUNT(*) AS n FROM markups WHERE document_id = ? AND deleted_at IS NULL', [documentId])
  if ((existing[0]?.n ?? 0) > 0) return null

  interface Planned { pageIndex: number, kind: string, label: string, color: string, rings: Array<Array<{ x: number, y: number }>> }
  const planned: Planned[] = []
  for (const a of reading.redbeamAnnots) {
    const text = a.label.trim()
    const color = a.color ?? '#888888'
    const outline = a.rings[0]
    if (a.subtype === 'Polygon') {
      if (outline === undefined || outline.length < 3 || !a.rings.every(finiteRing)) return null
      if (DEDUCTION.test(text)) {
        planned.push({ pageIndex: a.pageIndex, kind: 'cutout', label: text.replace(DEDUCTION, '').trim(), color, rings: [outline] })
      } else {
        planned.push({ pageIndex: a.pageIndex, kind: 'area', label: text, color, rings: [outline, ...a.rings.slice(1).filter((r) => r.length >= 3)] })
      }
    } else if (a.subtype === 'PolyLine') {
      if (outline === undefined || outline.length < 2 || !finiteRing(outline)) return null
      planned.push({ pageIndex: a.pageIndex, kind: 'polyline', label: text, color, rings: [outline] })
    } else if (a.subtype === 'Circle') {
      if (a.center === null || !finiteRing([a.center])) return null
      planned.push({ pageIndex: a.pageIndex, kind: 'count', label: text, color, rings: [[a.center]] })
    } else {
      return null
    }
  }
  const sheetAt = new Map(reading.sheets.map((s) => [s.pageIndex, s]))
  if (planned.some((m) => !sheetAt.has(m.pageIndex))) return null

  const out: RebuiltTakeoff = { markups: 0, scopes: 0, unscaled: 0 }
  const now = new Date().toISOString()
  await db.exec('BEGIN')
  try {
    // Scopes, by the name each annotation carries. A deduction never names the type.
    const have = await db.all<{ id: string, label: string }>('SELECT id, label FROM scopes WHERE archived_at IS NULL')
    const byName = new Map(have.map((r) => [r.label.trim().toLowerCase(), r.id]))
    const typeOf: Record<string, string> = { area: 'area', polyline: 'linear', count: 'count' }
    const scopeIdFor = async (m: Planned): Promise<string | null> => {
      if (m.label === '' || m.label.toLowerCase() === 'unassigned') return null
      const key = m.label.toLowerCase()
      const here = byName.get(key)
      if (here !== undefined) return here
      const lead = planned.find((p) => p.kind !== 'cutout' && p.label.toLowerCase() === key) ?? m
      const id = `sc-${crypto.randomUUID()}`
      await db.run(
        `INSERT INTO scopes(id, label, scope_type, color, specifications_json, archived_at, created_at, updated_at)
         VALUES(?,?,?,?,?,NULL,?,?)`,
        [id, m.label, typeOf[lead.kind] ?? 'area', lead.color, '{}', now, now])
      byName.set(key, id)
      out.scopes++
      return id
    }

    for (const sheet of reading.sheets) {
      const pageId = pageIdFor(documentId, sheet.pageIndex)
      await db.run(
        `INSERT OR IGNORE INTO pages(id, document_id, page_number, width_pdf_points, height_pdf_points, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?)`, [pageId, documentId, sheet.pageIndex, sheet.width, sheet.height, now, now])
      const whole = sheet.scales.find((s) => s.rect === null)
      if (whole !== undefined) {
        await db.run(
          `INSERT OR IGNORE INTO calibrations(id, document_id, page_id, feet_per_pdf_point, source, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?)`, [`cal-${crypto.randomUUID()}`, documentId, pageId, whole.feetPerPoint, 'manual', now, now])
      }
      const regioned = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM scale_regions WHERE page_id = ?', [pageId])
      if ((regioned[0]?.n ?? 0) === 0) {
        for (const s of sheet.scales) {
          if (s.rect === null) continue
          await db.run(
            `INSERT INTO scale_regions(id, document_id, page_id, label, x0, y0, x1, y1, feet_per_pdf_point, source, created_at, updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
            [`sr-${crypto.randomUUID()}`, documentId, pageId, s.label, s.rect.x0, s.rect.y0, s.rect.x1, s.rect.y1, s.feetPerPoint, 'manual', now, now])
        }
      }
      const measured = planned.some((m) => m.pageIndex === sheet.pageIndex && m.kind !== 'count')
      const scaled = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM calibrations WHERE page_id = ?', [pageId])
      if (measured && (scaled[0]?.n ?? 0) === 0) out.unscaled++
    }

    for (const m of planned) {
      await db.run(
        `INSERT INTO markups(id, document_id, page_id, scope_id, kind, geometry_json, style_json, content_json, origin, review_state, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [crypto.randomUUID(), documentId, pageIdFor(documentId, m.pageIndex), await scopeIdFor(m), m.kind, JSON.stringify(m.rings),
          '{}', '{}', 'user', 'accepted', now, now])
      out.markups++
    }
    await db.exec('COMMIT')
  } catch (err) {
    await db.exec('ROLLBACK')
    throw err
  }
  return out
}

/** What to tell the user about a takeoff rebuilt from its annotations. */
export function rebuiltStatus(result: RebuiltTakeoff, name: string): string {
  const parts = [
    `${name} was saved by another app that dropped REDBEAM's takeoff detail. REDBEAM rebuilt ${result.markups} markup${result.markups === 1 ? '' : 's'} in ${result.scopes} scope${result.scopes === 1 ? '' : 's'} from the markups the PDF still shows, and the next save puts the detail back.`,
    'Product details on the scopes were not in the markups, so they need entering again.',
  ]
  if (result.unscaled > 0) {
    parts.push(`${result.unscaled} sheet${result.unscaled === 1 ? ' has' : 's have'} lost ${result.unscaled === 1 ? 'its' : 'their'} scale and need${result.unscaled === 1 ? 's' : ''} it set again.`)
  }
  return parts.join(' ')
}

/**
 * Bring a drawing's embedded takeoff into a database that has none for it.
 *
 * Only ever ADDS: rows that already exist are kept as they are (INSERT OR
 * IGNORE), because redbeam.db is the record and the embed is a copy. A
 * database that already has markups on this drawing is not touched at all.
 */
export async function importSlice(
  db: SqlDriver,
  documentId: string,
  slice: SheetSlice,
): Promise<ImportOutcome | null> {
  const existing = await db.all<{ n: number }>(
    'SELECT COUNT(*) AS n FROM markups WHERE document_id = ? AND deleted_at IS NULL', [documentId])
  if ((existing[0]?.n ?? 0) > 0) return null

  // Pages must exist for markups to reference; they are normally created when
  // the drawing is opened, so only missing ones are added.
  const tables: Array<readonly [string, Array<Record<string, unknown>>]> = [
    ['pages', slice.tables.pages ?? []],
    ...IMPORT_ORDER.map((t) => [t, slice.tables[t] ?? []] as const),
  ]
  let markups = 0
  let scopes = 0
  let skipped = 0
  await db.exec('BEGIN')
  try {
    for (const [table, rows] of tables) {
      for (const raw of rows) {
        const row = rekey(raw, slice.documentId, documentId)
        const cols = Object.keys(row).filter((c) => IDENT.test(c))
        if (cols.length === 0) continue
        const sql = `INSERT OR IGNORE INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`
        try {
          await db.run(sql, cols.map((c) => row[c]))
        } catch {
          // A column this database does not have (an older schema) or a row
          // whose parent is missing: skip the row, keep the rest. What was
          // drawn or set by hand is counted, so a Light file is not then
          // saved without it; runs and layouts are worked out again anyway.
          if (HAND_MADE.has(table)) skipped++
          continue
        }
        if (table === 'markups') markups++
        if (table === 'scopes') scopes++
      }
    }
    await db.exec('COMMIT')
  } catch (err) {
    await db.exec('ROLLBACK')
    throw err
  }
  return { markups, scopes, ...(skipped > 0 ? { skipped } : {}) }
}

/**
 * Take a drawing's embedded takeoff when it is NEWER than the project's.
 *
 * `importSlice` only fills a database that has nothing on the drawing. That
 * was enough while REDBEAM itself was the only writer, but a Light-mode user
 * (or a second Pro project) can now change the takeoff inside the PDF while
 * this project still holds the older one. Without this, opening the job in
 * Pro showed the stale takeoff and leaving the drawing wrote it back over the
 * newer one.
 *
 * Newer means: written after the last change this database made to the
 * drawing's markups, AND saying something different (a Pro save of the same
 * takeoff writes the same markups and is not a reason to touch anything).
 * Then the slice wins for this drawing: its markups and scopes are upserted,
 * and markups the database has that the slice does not are soft-deleted.
 * Nothing is hard-deleted, so the old takeoff can still be recovered.
 */
export async function takeNewerSlice(
  db: SqlDriver,
  documentId: string,
  slice: SheetSlice,
): Promise<ImportOutcome | null> {
  const mine = await db.all<{ id: string, updated_at: string, deleted_at: string | null }>(
    'SELECT id, updated_at, deleted_at FROM markups WHERE document_id = ?', [documentId])
  if (mine.length === 0) return null
  let last = ''
  for (const m of mine) {
    if (m.updated_at > last) last = m.updated_at
    if (m.deleted_at !== null && m.deleted_at > last) last = m.deleted_at
  }
  if (!(slice.writtenAt > last)) return null

  const live = new Map(mine.filter((m) => m.deleted_at === null).map((m) => [m.id, m.updated_at]))
  const theirs = (slice.tables.markups ?? []).map((r) => rekey(r, slice.documentId, documentId))
  const same = theirs.length === live.size
    && theirs.every((r) => live.get(String(r.id)) === String(r.updated_at))
  if (same) return null

  const keep = new Set(theirs.map((r) => String(r.id)))
  const now = new Date().toISOString()
  let markups = 0
  let scopes = 0
  await db.exec('BEGIN')
  try {
    for (const id of live.keys()) {
      if (!keep.has(id)) await db.run('UPDATE markups SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id])
    }
    const upsert = async (table: string, raw: Record<string, unknown>): Promise<boolean> => {
      const row = rekey(raw, slice.documentId, documentId)
      const cols = Object.keys(row).filter((c) => IDENT.test(c))
      if (!cols.includes('id')) return false
      const sets = cols.filter((c) => c !== 'id').map((c) => `${c}=excluded.${c}`).join(',')
      const sql = `INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`
        + (sets === '' ? ' ON CONFLICT(id) DO NOTHING' : ` ON CONFLICT(id) DO UPDATE SET ${sets}`)
      try {
        await db.run(sql, cols.map((c) => row[c]))
        return true
      } catch {
        return false
      }
    }
    for (const raw of slice.tables.pages ?? []) {
      const row = rekey(raw, slice.documentId, documentId)
      const cols = Object.keys(row).filter((c) => IDENT.test(c))
      try {
        await db.run(`INSERT OR IGNORE INTO pages(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`,
          cols.map((c) => row[c]))
      } catch { /* the page is already there under its own row */ }
    }
    for (const raw of slice.tables.scopes ?? []) if (await upsert('scopes', raw)) scopes++
    for (const table of ['calibrations', 'scale_regions'] as const) {
      for (const raw of slice.tables[table] ?? []) await upsert(table, raw)
    }
    for (const raw of slice.tables.markups ?? []) if (await upsert('markups', raw)) markups++
    await db.exec('COMMIT')
  } catch (err) {
    await db.exec('ROLLBACK')
    throw err
  }
  return { markups, scopes }
}

/**
 * Light mode: the one bidding round a file's takeoff lands in.
 *
 * The workspace puts every takeoff in a round. A Light file has no rounds to
 * choose between, so it gets one, named after the drawing, and every scope in
 * the file belongs to it, including scopes that just came in from the PDF.
 * The store is in memory, so none of this is ever written anywhere.
 */
export async function ensureFileRound(db: SqlDriver, name: string): Promise<string> {
  const rows = await db.all<{ id: string }>('SELECT id FROM estimates ORDER BY created_at LIMIT 1')
  let id = rows[0]?.id
  if (id === undefined) {
    id = `estimate-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    await db.run(
      `INSERT INTO estimates(id, name, state, notes_json, created_at, updated_at) VALUES(?,?,'working','{}',?,?)`,
      [id, name.trim() === '' ? 'Takeoff' : name.trim(), now, now])
  }
  await db.run(
    `INSERT OR IGNORE INTO estimate_scopes(estimate_id, scope_id, position, created_at)
     SELECT ?, s.id, (SELECT COUNT(*) FROM estimate_scopes), ? FROM scopes s
      WHERE NOT EXISTS (SELECT 1 FROM estimate_scopes es WHERE es.scope_id = s.id)`,
    [id, new Date().toISOString()])
  return id
}

export interface ScopeImport { added: string[], skipped: string[] }

/**
 * Bring another PDF's scopes into this file: names, colours and
 * specifications, without its markups or results.
 *
 * Aaron, 2026-11-18: "import scopes from a previous PDF file into a new PDF
 * file. This will be used for rounds of bidding." Each copy gets a new id, so
 * the two files never share a row, and a scope whose name this file already
 * has is left alone rather than duplicated.
 */
export async function importScopesFromSlice(db: SqlDriver, slice: SheetSlice): Promise<ScopeImport> {
  const have = await db.all<{ label: string }>('SELECT label FROM scopes WHERE archived_at IS NULL')
  const taken = new Set(have.map((r) => r.label.trim().toLowerCase()))
  const out: ScopeImport = { added: [], skipped: [] }
  const now = new Date().toISOString()
  for (const raw of slice.tables.scopes ?? []) {
    if (raw.archived_at !== null && raw.archived_at !== undefined) continue
    const label = String(raw.label ?? '').trim()
    if (label === '') continue
    if (taken.has(label.toLowerCase())) { out.skipped.push(label); continue }
    await db.run(
      `INSERT INTO scopes(id, label, scope_type, color, specifications_json, archived_at, created_at, updated_at)
       VALUES(?,?,?,?,?,NULL,?,?)`,
      [`sc-${crypto.randomUUID()}`, label, String(raw.scope_type ?? 'area'), String(raw.color ?? '#888888'),
        typeof raw.specifications_json === 'string' ? raw.specifications_json : '{}', now, now])
    taken.add(label.toLowerCase())
    out.added.push(label)
  }
  return out
}

export interface TakeoffImport extends ScopeImport {
  /** Markups copied onto this file's sheets. */
  markups: number
  /** How many sheets they landed on. */
  sheets: number
  /** Markups already here, exactly as they are in the other PDF. */
  already: number
  /** Markups whose sheet this file does not have at the same size. */
  unplaced: number
}

/** A sheet's size in PDF points, by zero-based sheet number. Null where it is not known. */
export type SheetSizes = ReadonlyArray<{ width: number, height: number } | null>

const sameSheet = (a: { width: number, height: number }, w: number, h: number): boolean =>
  (Math.abs(a.width - w) <= 1 && Math.abs(a.height - h) <= 1) || (Math.abs(a.width - h) <= 1 && Math.abs(a.height - w) <= 1)

/**
 * Start this file from another PDF's takeoff: its scopes AND its markups.
 *
 * Aaron, 2026-11-19: "copying markups and scope information from one set to
 * another in Light mode is, in essence, copying an old estimate to a new
 * estimate in Pro mode." A revised drawing set arrives as a new PDF; the
 * takeoff drawn on the last one is the starting point for this one.
 *
 * A markup goes to the sheet with the same number, and only when that sheet is
 * the same size here as it was there: markups are stored as fractions of the
 * sheet, so on a sheet of another size they would land somewhere else and
 * measure wrong. Those are counted, not guessed at. A sheet's scale comes
 * across where this file has none for it. Everything copied gets a new id, so
 * the two files never share a row; a scope this file already has by name is
 * used rather than duplicated, and a markup already here is not added twice.
 */
export async function importTakeoffFromSlice(
  db: SqlDriver,
  documentId: string,
  slice: SheetSlice,
  sheets: SheetSizes,
): Promise<TakeoffImport> {
  const out: TakeoffImport = { added: [], skipped: [], markups: 0, sheets: 0, already: 0, unplaced: 0 }
  const now = new Date().toISOString()
  await db.exec('BEGIN')
  try {
    // Scopes: a new row each, or the one this file already has by that name.
    const have = await db.all<{ id: string, label: string }>('SELECT id, label FROM scopes WHERE archived_at IS NULL')
    const byName = new Map(have.map((r) => [r.label.trim().toLowerCase(), r.id]))
    const scopeFor = new Map<string, string>()
    for (const raw of slice.tables.scopes ?? []) {
      if (raw.archived_at !== null && raw.archived_at !== undefined) continue
      const label = String(raw.label ?? '').trim()
      if (label === '') continue
      const here = byName.get(label.toLowerCase())
      if (here !== undefined) { scopeFor.set(String(raw.id), here); out.skipped.push(label); continue }
      const id = `sc-${crypto.randomUUID()}`
      await db.run(
        `INSERT INTO scopes(id, label, scope_type, color, specifications_json, archived_at, created_at, updated_at)
         VALUES(?,?,?,?,?,NULL,?,?)`,
        [id, label, String(raw.scope_type ?? 'area'), String(raw.color ?? '#888888'),
          typeof raw.specifications_json === 'string' ? raw.specifications_json : '{}', now, now])
      byName.set(label.toLowerCase(), id)
      scopeFor.set(String(raw.id), id)
      out.added.push(label)
    }

    // Sheets: the other PDF's page id -> this file's, where the sheet matches.
    const mine = await db.all<{ id: string, page_number: number, w: number | null, h: number | null }>(
      'SELECT id, page_number, width_pdf_points AS w, height_pdf_points AS h FROM pages WHERE document_id = ?', [documentId])
    const mineByNumber = new Map(mine.map((p) => [Number(p.page_number), p]))
    const pageFor = new Map<string, string>()
    for (const raw of slice.tables.pages ?? []) {
      const n = Number(raw.page_number)
      const w = Number(raw.width_pdf_points)
      const h = Number(raw.height_pdf_points)
      if (!Number.isInteger(n) || !(w > 0) || !(h > 0)) continue
      const row = mineByNumber.get(n)
      if (row !== undefined) {
        if (row.w !== null && row.h !== null && sameSheet({ width: row.w, height: row.h }, w, h)) pageFor.set(String(raw.id), row.id)
        continue
      }
      const size = sheets[n]
      if (size === null || size === undefined || !sameSheet(size, w, h)) continue
      // Not visited in this window yet. Same sheet, so the box the other file measured is this one's.
      const id = `${documentId}-p${n}`
      await db.run(
        `INSERT OR IGNORE INTO pages(id, document_id, page_number, width_pdf_points, height_pdf_points, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?)`, [id, documentId, n, w, h, now, now])
      pageFor.set(String(raw.id), id)
    }

    // Scales, where this file has none for the sheet.
    for (const raw of slice.tables.calibrations ?? []) {
      const pageId = pageFor.get(String(raw.page_id))
      if (pageId === undefined) continue
      await db.run(
        `INSERT OR IGNORE INTO calibrations(id, document_id, page_id, feet_per_pdf_point, source, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?)`,
        [`cal-${crypto.randomUUID()}`, documentId, pageId, Number(raw.feet_per_pdf_point), String(raw.source ?? 'manual'), now, now])
    }
    const regioned = new Set((await db.all<{ page_id: string }>(
      'SELECT DISTINCT page_id FROM scale_regions WHERE document_id = ?', [documentId])).map((r) => r.page_id))
    for (const raw of slice.tables.scale_regions ?? []) {
      const pageId = pageFor.get(String(raw.page_id))
      if (pageId === undefined || regioned.has(pageId)) continue
      await db.run(
        `INSERT INTO scale_regions(id, document_id, page_id, label, x0, y0, x1, y1, feet_per_pdf_point, source, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [`sr-${crypto.randomUUID()}`, documentId, pageId, String(raw.label ?? ''), Number(raw.x0), Number(raw.y0), Number(raw.x1), Number(raw.y1),
          Number(raw.feet_per_pdf_point), String(raw.source ?? 'manual'), now, now])
    }

    // Markups.
    const existing = await db.all<{ page_id: string, scope_id: string | null, kind: string, geometry_json: string }>(
      'SELECT page_id, scope_id, kind, geometry_json FROM markups WHERE document_id = ? AND deleted_at IS NULL', [documentId])
    const key = (pageId: string, scopeId: string | null, kind: string, geometry: string) => `${pageId}|${scopeId ?? ''}|${kind}|${geometry}`
    const here = new Set(existing.map((m) => key(m.page_id, m.scope_id, m.kind, m.geometry_json)))
    const landed = new Set<string>()
    for (const raw of slice.tables.markups ?? []) {
      if (raw.deleted_at !== null && raw.deleted_at !== undefined) continue
      const pageId = pageFor.get(String(raw.page_id))
      if (pageId === undefined) { out.unplaced++; continue }
      const scopeId = raw.scope_id === null || raw.scope_id === undefined ? null : scopeFor.get(String(raw.scope_id)) ?? null
      const kind = String(raw.kind)
      const geometry = String(raw.geometry_json)
      const k = key(pageId, scopeId, kind, geometry)
      if (here.has(k)) { out.already++; continue }
      await db.run(
        `INSERT INTO markups(id, document_id, page_id, scope_id, kind, geometry_json, style_json, content_json, origin, review_state, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [crypto.randomUUID(), documentId, pageId, scopeId, kind, geometry,
          typeof raw.style_json === 'string' ? raw.style_json : '{}', typeof raw.content_json === 'string' ? raw.content_json : '{}',
          String(raw.origin ?? 'user'), String(raw.review_state ?? 'accepted'), now, now])
      here.add(k)
      landed.add(pageId)
      out.markups++
    }
    out.sheets = landed.size
    await db.exec('COMMIT')
  } catch (err) {
    await db.exec('ROLLBACK')
    throw err
  }
  return out
}

/** What to say after starting a file from another PDF's takeoff. */
export function takeoffImportStatus(result: TakeoffImport, from: string): string {
  const scopes = result.added.length + result.skipped.length
  if (scopes === 0 && result.markups + result.already + result.unplaced === 0) return `${from} carries no REDBEAM takeoff`
  const parts: string[] = []
  if (result.markups > 0) {
    parts.push(`${result.markups} markup${result.markups === 1 ? '' : 's'} on ${result.sheets} sheet${result.sheets === 1 ? '' : 's'} copied from ${from}`)
  }
  if (result.added.length > 0) parts.push(`${result.added.length} scope${result.added.length === 1 ? '' : 's'} added`)
  if (result.markups === 0 && result.added.length === 0) parts.push(`nothing new in ${from}`)
  if (result.already > 0) parts.push(`${result.already} markup${result.already === 1 ? ' was' : 's were'} already here`)
  if (result.unplaced > 0) {
    parts.push(`${result.unplaced} markup${result.unplaced === 1 ? ' was' : 's were'} left behind: ${result.unplaced === 1 ? 'its sheet is' : 'their sheets are'} missing or a different size in this PDF`)
  }
  return parts.join(', ')
}

/** What to say after importing scopes from another PDF. */
export function scopeImportStatus(result: ScopeImport, from: string): string {
  if (result.added.length === 0 && result.skipped.length === 0) return `${from} carries no REDBEAM scopes`
  const parts: string[] = []
  if (result.added.length > 0) parts.push(`${result.added.length} scope${result.added.length === 1 ? '' : 's'} imported from ${from}`)
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} already here by name`)
  return parts.join(', ')
}

/**
 * Light mode: why leaving this file now would lose work, or null when it is
 * safe to leave. `editsMade` is how many undoable edits this window holds.
 *
 * A save that was held back loses something only if something was made here:
 * a file that was opened and looked at has nothing of its own to lose.
 */
export function unsavedReason(outcome: EmbedOutcome, editsMade: number): string | null {
  switch (outcome.kind) {
    case 'busy':
      return 'The PDF changed on disk or is open in another app, so the takeoff could not be saved into it.'
    case 'failed':
      return `The takeoff could not be saved into the PDF: ${outcome.message}`
    case 'elsewhere':
      // Nothing made here, nothing of ours to lose: theirs simply stays.
      if (editsMade <= 0) return null
      return 'Someone else saved a different takeoff into this PDF after you opened it (another REDBEAM window, or a synced copy). Saving here would replace theirs, so REDBEAM has not. Save yours as a copy, or leave without saving and reopen the PDF to see theirs.'
    case 'held':
      if (editsMade <= 0) return null
      return outcome.reason ?? 'The PDF\u2019s own takeoff had not finished loading, so what was drawn here has not been saved into it.'
    default:
      return null
  }
}

/** A short line for the status bar after an embed, or null for silence. */
export function embedStatus(outcome: EmbedOutcome, name: string): string | null {
  switch (outcome.kind) {
    case 'written':
      return outcome.editedElsewhere.length > 0
        ? `takeoff saved into ${name}. ${outcome.editedElsewhere.length} markup(s) changed in another app were left as that app saved them`
        : `takeoff saved into ${name}`
    case 'busy':
      return `${name} changed on disk (open in Bluebeam?), so its takeoff was not saved into it this time`
    case 'failed':
      return `could not save the takeoff into ${name}: ${outcome.message}`
    case 'elsewhere':
      return `${name} now carries a takeoff someone else saved after you opened it, so yours was not saved over it. Ctrl+S for the choices`
    case 'held':
      return outcome.reason
    default:
      return null
  }
}

/** What to tell the user after Bluebeam's edits were brought in, or null. */
export function foreignEditsStatus(pulled: ForeignEdits, name: string): string | null {
  const parts: string[] = []
  if (pulled.edits.length > 0) {
    parts.push(`${pulled.edits.length} markup${pulled.edits.length === 1 ? '' : 's'} changed in Bluebeam brought into ${name} (Ctrl+Z undoes)`)
  }
  if (pulled.conflicts.length > 0) {
    parts.push(`${pulled.conflicts.length} markup${pulled.conflicts.length === 1 ? ' was' : 's were'} changed both here and in Bluebeam; REDBEAM's version is kept`)
  }
  return parts.length === 0 ? null : parts.join('. ')
}

/** What to tell the user when a drawing is opened, or null. */
export function openingStatus(reading: SheetEmbedReading, imported: ImportOutcome | null, name: string): string | null {
  if (imported !== null && imported.markups > 0) {
    return `loaded ${imported.markups} markup(s) and ${imported.scopes} scope(s) carried inside ${name}`
  }
  if (reading.privateDataLost) {
    return `${name} was saved by another app that dropped REDBEAM's scope detail. Its markups are still in redbeam.db`
  }
  return null
}
