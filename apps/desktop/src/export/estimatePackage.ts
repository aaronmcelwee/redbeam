/**
 * The estimate PDF from plain data, so it can be built off the window's thread.
 *
 * The package draws each drawing's sheets as vectors (sheetForms.ts), which
 * means parsing the drawing, indexing the content of every sheet with takeoff
 * on it and writing it all back out: a second or several, for a big set, that
 * would freeze the window. Everything here therefore arrives as data a worker
 * can be handed (estimatePdfWorker.ts): the drawings as bytes, the takeoff,
 * the piece layouts and the sheet facts as the workspace measured them. Where
 * no worker can be started the same function runs on the window's thread.
 */
import { PDFDocument, degrees } from 'pdf-lib'
import type { EstimateExport } from './estimateExport.js'
import { renderEstimatePdf } from './estimatePdf.js'
import { displayedSize } from './sheetForms.js'
import { SNAPSHOT_FRAME, SNAPSHOT_MIN } from './snapshotPages.js'
import {
  pageIndexOf, planSnapshots, type PlanMarkup, type PlanPieces, type PlanScope, type PlanSheet,
} from './snapshotPlan.js'

export interface EstimateDrawing {
  documentId: string
  /** As the project lists it, for notes. */
  name: string
  /** The file, or null when it could not be read: its snapshots then show the takeoff alone. */
  bytes: Uint8Array | null
  /** Sheets turned in the window and not yet saved into the file: page index to degrees. */
  rotations: Array<[number, number]>
}

export interface EstimatePdfRequest {
  estimate: EstimateExport
  /** False for a quantities-only export. */
  snapshots: boolean
  scopes: PlanScope[]
  /** Takeoff markups of the export's scopes. */
  markups: PlanMarkup[]
  pieces: PlanPieces[]
  /** Each sheet with takeoff on it, as the workspace measured it. A sheet missing here is measured from its drawing. */
  sheets: Array<[string, PlanSheet]>
  /** Each sheet's label, by page id. */
  labels: Array<[string, string]>
  /** In the order the project lists them. */
  drawings: EstimateDrawing[]
  notes: string[]
}

const TAKEOFF = new Set(['area', 'cutout', 'polyline', 'count'])

/** Only what a snapshot is drawn from: takeoff of the export's scopes. */
export function takeoffFor<M extends PlanMarkup>(markups: readonly M[], scopeIds: ReadonlySet<string>): M[] {
  return markups.filter((m) => m.scopeId !== null && scopeIds.has(m.scopeId) && TAKEOFF.has(m.kind))
}

/** Render the estimate PDF. Returns its bytes. */
export async function buildEstimatePdf(req: EstimatePdfRequest): Promise<Uint8Array> {
  if (!req.snapshots || req.markups.length === 0) {
    return renderEstimatePdf({ estimate: req.estimate, notes: req.notes })
  }

  // The drawings, parsed, turned the way the window shows them.
  const drawings = new Map<string, PDFDocument>()
  for (const d of req.drawings) {
    if (d.bytes === null) continue
    try {
      const doc = await PDFDocument.load(d.bytes, { updateMetadata: false, throwOnInvalidObject: false, ignoreEncryption: true })
      const pages = doc.getPages()
      for (const [index, deg] of d.rotations) {
        const page = pages[index]
        if (page !== undefined && Number.isFinite(deg)) page.setRotation(degrees(((Math.round(deg / 90) * 90) % 360 + 360) % 360))
      }
      drawings.set(d.documentId, doc)
    } catch (err) {
      // Said in the notes by the composer: a drawing it is not given is one it could not read.
      console.warn(`[estimate] could not read ${d.name}:`, err)
    }
  }

  const sheets = new Map(req.sheets)
  const labels = new Map(req.labels)
  const docOrder = new Map(req.drawings.map((d, i) => [d.documentId, i]))
  const unmeasured = new Set<string>()
  const plan = planSnapshots({
    scopes: req.scopes,
    markups: req.markups,
    pieces: req.pieces,
    sheet: (pageId) => {
      const known = sheets.get(pageId)
      if (known !== undefined && known.width > 0 && known.height > 0) return known
      // Not measured by the window: the drawing says how big the sheet is.
      const docId = pageId.replace(/-p\d+$/, '')
      const index = pageIndexOf(pageId)
      const page = index === null ? undefined : drawings.get(docId)?.getPages()[index]
      if (page === undefined) {
        unmeasured.add(pageId)
        return null
      }
      return { ...displayedSize(page), feetPerPoint: known?.feetPerPoint ?? null, ...(known?.regions !== undefined ? { regions: known.regions } : {}) }
    },
    sheetLabelFor: (pageId) => labels.get(pageId) ?? pageId,
    documentOrder: (documentId) => docOrder.get(documentId) ?? docOrder.size,
    frame: SNAPSHOT_FRAME,
    minPicture: SNAPSHOT_MIN,
  })

  const names = new Map(req.drawings.map((d) => [d.documentId, d.name]))
  // A sheet neither the window nor its drawing can size has nowhere to put a
  // picture: said, rather than its takeoff quietly missing from the pages.
  const notes = [...req.notes]
  for (const [documentId, pages] of groupBy([...unmeasured], (pageId) => pageId.replace(/-p\d+$/, ''))) {
    const sheetNames = pages.map((pageId) => labels.get(pageId) ?? pageId)
    notes.push(`${names.get(documentId) ?? documentId}: ${sheetNames.length === 1 ? sheetNames[0] : `${sheetNames.length} sheets (${sheetNames.join(', ')})`} could not be read, so ${sheetNames.length === 1 ? 'its' : 'their'} takeoff has no snapshot.`)
  }
  return renderEstimatePdf({
    estimate: req.estimate,
    snapshots: { cards: plan.cards, baseLabel: plan.base?.label ?? null, detailLabel: plan.detail?.label ?? null },
    drawings,
    documentName: (id) => names.get(id) ?? id,
    notes,
  })
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item])
  return out
}
