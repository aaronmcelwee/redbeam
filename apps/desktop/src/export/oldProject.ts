/**
 * Moving an older project's takeoff out of redbeam.db and into its PDFs, once.
 *
 * Aaron, 2026-11-19: "the PDF becomes the only truth. If you open a file with
 * an adjacent DB file, transfer the DB file once to the PDF, and then mark the
 * DB file as superseded. ... if you have to open multiple PDF files to
 * transfer the metadata from the DB file to the PDF file, offer to do so as a
 * one-time event."
 *
 * This file is the part that decides what goes into each PDF. It reads the
 * old database and writes drawings through the same guarded write as every
 * other save; it never deletes anything. Setting the database aside once every
 * drawing is done is the caller's, because that is a move on disk.
 *
 * Which side wins for one drawing:
 * - The PDF carries no takeoff: the database's goes in.
 * - The PDF's takeoff was written after the database last changed that
 *   drawing AND says something different: someone has worked on the PDF since
 *   (in Light mode, or from another job folder). The PDF is already the truth
 *   and is left exactly as it is.
 * - Otherwise the database's goes in, which is what leaving the drawing in a
 *   project window would have written anyway.
 */
import type { SqlDriver } from '@redbeam/store'
import { embedMarkupsFor, sliceTables, type DrawingFile } from './drawingEmbed.js'
import { embedSheet, readSheetEmbed, type SliceTables } from './sheetEmbed.js'

/** The redbeam_meta key, in the OLD database, listing drawings already moved. */
export const TRANSFERRED_KEY = 'light_transferred'
/** Set, in the OLD database, once the scopes nothing was drawn in have gone into a PDF. */
export const UNDRAWN_MOVED_KEY = 'light_transferred_undrawn_scopes'

export interface OldDrawing { id: string, relativePath: string, displayName: string }

export type TransferOutcome =
  /** The PDF now holds the database's takeoff for this drawing. */
  | { kind: 'written' }
  /** The PDF already held it, or holds a newer one of its own. */
  | { kind: 'current' }
  /** The PDF is no longer in the folder, so there is nothing to move into. */
  | { kind: 'missing' }
  /** Could not be done this time; the database is kept until it can. */
  | { kind: 'retry', why: string }

export interface TransferResult {
  written: string[]
  current: string[]
  missing: string[]
  retry: Array<{ name: string, why: string }>
}

/** Nothing left that a later try could move: the database can be set aside. */
export function transferComplete(result: TransferResult, remaining: number, undrawnLeft = 0): boolean {
  return result.retry.length === 0 && remaining === 0 && undrawnLeft === 0
}

async function readTransferred(old: SqlDriver): Promise<Set<string>> {
  try {
    const rows = await old.all<{ value: string }>('SELECT value FROM redbeam_meta WHERE key = ?', [TRANSFERRED_KEY])
    const v = rows[0] === undefined ? [] : JSON.parse(rows[0].value) as unknown
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/**
 * The drawings whose takeoff is still only in the old database: every drawing
 * with a live markup, a scale set by hand or a scale region, less the ones
 * already moved. A database with no takeoff at all returns an empty list.
 */
export async function drawingsToTransfer(old: SqlDriver): Promise<OldDrawing[]> {
  let rows: Array<{ id: string, relative_path: string, display_name: string | null }>
  try {
    rows = await old.all(
      `SELECT id, relative_path, display_name FROM documents WHERE id IN (
         SELECT document_id FROM markups WHERE deleted_at IS NULL
         UNION SELECT document_id FROM calibrations
         UNION SELECT document_id FROM scale_regions)
       ORDER BY relative_path`)
  } catch {
    return []
  }
  const done = await readTransferred(old)
  return rows.filter((r) => !done.has(r.id)).map((r) => ({
    id: r.id, relativePath: r.relative_path, displayName: r.display_name ?? r.relative_path,
  }))
}

/**
 * Round names, where the old project had more than one round in use.
 *
 * A project splits one job into bidding rounds and a copied round repeats its
 * scope names. A PDF has no rounds, so two rounds drawn on one sheet would
 * arrive as scopes nobody could tell apart. Each scope then carries its round
 * in its name: "ACT-1 Ceiling (Bid 2)". One round in use means no suffix.
 */
export async function roundSuffixes(old: SqlDriver): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const rows = await old.all<{ scope_id: string, name: string }>(
      `SELECT es.scope_id AS scope_id, e.name AS name FROM estimate_scopes es
         JOIN estimates e ON e.id = es.estimate_id
        WHERE es.scope_id IN (SELECT scope_id FROM markups WHERE deleted_at IS NULL AND scope_id IS NOT NULL)`)
    if (new Set(rows.map((r) => r.name)).size < 2) return out
    for (const r of rows) out.set(r.scope_id, r.name)
  } catch {
    // A database from before rounds has none to name.
  }
  return out
}

/** Live scopes nothing was ever drawn in: set up, with their specifications, and not yet used. */
export async function undrawnScopes(old: SqlDriver): Promise<Array<Record<string, unknown>>> {
  try {
    return await old.all<Record<string, unknown>>(
      `SELECT * FROM scopes WHERE archived_at IS NULL
          AND id NOT IN (SELECT scope_id FROM markups WHERE deleted_at IS NULL AND scope_id IS NOT NULL)`)
  } catch {
    return []
  }
}

/** The undrawn scopes that have not yet gone into any PDF. */
export async function undrawnPending(old: SqlDriver): Promise<Array<Record<string, unknown>>> {
  try {
    const moved = await old.all<{ value: string }>('SELECT value FROM redbeam_meta WHERE key = ?', [UNDRAWN_MOVED_KEY])
    return moved.length === 0 ? await undrawnScopes(old) : []
  } catch {
    return []
  }
}

/**
 * The old project's drawing at a path, whether or not it has takeoff. For the
 * PDF being opened when the only thing left to move is undrawn scopes.
 */
export async function oldDrawingAt(old: SqlDriver, relativePath: string): Promise<OldDrawing | undefined> {
  try {
    const rows = await old.all<{ id: string, relative_path: string, display_name: string | null }>(
      'SELECT id, relative_path, display_name FROM documents WHERE lower(relative_path) = lower(?)', [relativePath])
    const r = rows[0]
    return r === undefined ? undefined : { id: r.id, relativePath: r.relative_path, displayName: r.display_name ?? r.relative_path }
  } catch {
    return undefined
  }
}

const isMissing = (message: string): boolean =>
  /os error [23]\b|no such file|cannot find the (file|path)|not a file/i.test(message)

/** One drawing: put the old database's takeoff for it into its PDF, unless the PDF's is newer. */
export async function transferDrawing(opts: {
  old: SqlDriver
  doc: OldDrawing
  appVersion: string
  file: DrawingFile
  /** From `roundSuffixes`. */
  rounds?: ReadonlyMap<string, string>
  /** Scope rows to carry in this PDF besides the ones drawn on it. */
  extraScopes?: ReadonlyArray<Record<string, unknown>>
}): Promise<TransferOutcome> {
  let current: { bytes: Uint8Array, version: string }
  try {
    current = await opts.file.read()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return isMissing(message) ? { kind: 'missing' } : { kind: 'retry', why: message }
  }
  try {
    const reading = await readSheetEmbed(current.bytes)
    if (reading.sliceTooNew) {
      return { kind: 'retry', why: 'it was saved by a newer REDBEAM than this one' }
    }
    if (reading.slice !== null) {
      const mine = await opts.old.all<{ id: string, updated_at: string, deleted_at: string | null }>(
        'SELECT id, updated_at, deleted_at FROM markups WHERE document_id = ?', [opts.doc.id])
      let last = ''
      for (const m of mine) {
        if (m.updated_at > last) last = m.updated_at
        if (m.deleted_at !== null && m.deleted_at > last) last = m.deleted_at
      }
      const live = new Map(mine.filter((m) => m.deleted_at === null).map((m) => [m.id, m.updated_at]))
      const theirs = reading.slice.tables.markups ?? []
      const same = theirs.length === live.size
        && theirs.every((r) => live.get(String(r.id)) === String(r.updated_at))
      // Worked on since the database last was: the PDF already is the record.
      if (reading.slice.writtenAt > last && !same) return { kind: 'current' }
    }

    const tables: SliceTables = await sliceTables(opts.old, opts.doc.id)
    const have = new Set((tables.scopes ?? []).map((s) => String(s.id)))
    const scopes = [
      ...(tables.scopes ?? []),
      ...(opts.extraScopes ?? []).filter((s) => !have.has(String(s.id))),
    ].map((s) => {
      const round = opts.rounds?.get(String(s.id))
      return round === undefined ? s : { ...s, label: `${String(s.label ?? '')} (${round})` }
    })
    if (scopes.length > 0) tables.scopes = scopes

    const { markups, pageScales, pageRegions } = embedMarkupsFor(tables, opts.doc.id)
    const result = await embedSheet(current.bytes, {
      documentId: opts.doc.id,
      // A Light window knows a PDF by its own name, not by where a project kept it.
      relativePath: opts.doc.relativePath.replace(/^.*\//, ''),
      displayName: opts.doc.displayName,
      appVersion: opts.appVersion,
      tables, markups, pageScales, pageRegions,
    })
    if (result.bytes === null) return { kind: 'current' }
    const ok = await opts.file.write(result.bytes, current.version)
    return ok ? { kind: 'written' } : { kind: 'retry', why: 'it changed on disk or is open in another app' }
  } catch (err) {
    return { kind: 'retry', why: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Move the takeoff of `drawings` out of the old database into their PDFs.
 *
 * A drawing is recorded as moved once its PDF holds the takeoff, already held
 * a newer one, or is gone; one that could not be written stays on the list for
 * next time. Recorded after every drawing, so stopping halfway keeps what was
 * done. Running it twice is harmless.
 *
 * Scopes that were set up and never drawn in belong to no drawing, and a PDF
 * is now the only place a scope can live. They ride in the first PDF this
 * writes (the one being opened, when it is among them), once.
 */
export async function transferOldProject(opts: {
  old: SqlDriver
  drawings: readonly OldDrawing[]
  appVersion: string
  fileFor: (doc: OldDrawing) => DrawingFile
  cancelled?: () => boolean
}): Promise<TransferResult> {
  const result: TransferResult = { written: [], current: [], missing: [], retry: [] }
  if (opts.drawings.length === 0) return result
  const rounds = await roundSuffixes(opts.old)
  const done = await readTransferred(opts.old)
  const setMeta = (key: string, value: string) =>
    opts.old.run('INSERT OR REPLACE INTO redbeam_meta(key, value) VALUES(?, ?)', [key, value])
  let undrawn = await undrawnPending(opts.old)
  for (const doc of opts.drawings) {
    if (opts.cancelled?.() === true) break
    const outcome = await transferDrawing({
      old: opts.old, doc, appVersion: opts.appVersion, file: opts.fileFor(doc), rounds,
      ...(undrawn.length > 0 ? { extraScopes: undrawn } : {}),
    })
    if (outcome.kind === 'retry') {
      result.retry.push({ name: doc.displayName, why: outcome.why })
      continue
    }
    result[outcome.kind].push(doc.displayName)
    if (outcome.kind === 'written' && undrawn.length > 0) {
      undrawn = []
      await setMeta(UNDRAWN_MOVED_KEY, new Date().toISOString())
    }
    done.add(doc.id)
    await setMeta(TRANSFERRED_KEY, JSON.stringify([...done].sort()))
  }
  return result
}

/** What to say after a transfer, or null for silence. */
export function transferStatus(result: TransferResult, setAside: boolean): string | null {
  const parts: string[] = []
  const moved = result.written.length
  if (moved === 1) parts.push(`the older project's takeoff was moved into ${result.written[0]}`)
  else if (moved > 1) parts.push(`the older project's takeoff was moved into ${moved} PDFs`)
  if (result.retry.length > 0) {
    const first = result.retry[0]!
    parts.push(result.retry.length === 1
      ? `${first.name} could not take its takeoff yet (${first.why}); the older project is kept until it can`
      : `${result.retry.length} PDFs could not take their takeoff yet (open in another app?); the older project is kept until they can`)
  }
  if (result.missing.length > 0 && moved + result.retry.length > 0) {
    parts.push(`${result.missing.length} drawing${result.missing.length === 1 ? ' is' : 's are'} no longer in the folder`)
  }
  if (setAside && moved > 0) parts.push('redbeam.db was set aside in .redbeam, not deleted')
  return parts.length === 0 ? null : parts.join('. ')
}

/** The offer shown when other PDFs' takeoff is still in the old project. */
export function transferOffer(others: number): string {
  return others === 1
    ? 'An older REDBEAM project in this folder still holds the takeoff for 1 other PDF. REDBEAM now keeps a takeoff inside its PDF, so it can be moved there once.'
    : `An older REDBEAM project in this folder still holds the takeoff for ${others} other PDFs. REDBEAM now keeps a takeoff inside its PDF, so they can all be moved there once.`
}
