/**
 * The estimate as a PDF somebody can put in front of a client.
 *
 * Built with pdf-lib rather than printed from HTML because the app has no
 * print path — a WebView2 print dialog is not an export — and because a PDF
 * whose layout depends on which browser rendered it is not the same PDF
 * twice. Every page here is placed by hand, in points.
 *
 * The package, in the order a reader needs it:
 *
 *  1. the cover: what and for whom, a key plan of the sheet with the most
 *     takeoff on it, and the contents — each scope with its headline
 *     quantity and the page its pictures start on;
 *  2. the quantities, scope by scope: what was measured and what it orders,
 *     with the lines not yet proven marked;
 *  3. the takeoff snapshots, a section per scope (snapshotPages.ts);
 *  4. notes, when something could not be shown.
 *
 * BRANDING follows the Maxxit brand skill, as a print document (pdfBrand.ts):
 * white paper, Maxxit Black type and wordmark, ONE accent, AERO:Form Orange,
 * for ONE meaning — "not ready to send", an unverified or blocked line — and
 * as the kicker's rule. Scope colours identify scopes, on the pictures and
 * in their dots, and nowhere else. Sentence-case headlines; uppercase only on
 * tracked labels.
 *
 * Letter, landscape: a takeoff picture is wider than it is tall.
 */
import { PDFDocument, StandardFonts, type PDFPage } from 'pdf-lib'
import {
  BRAND, FOLIO_Y, M, PAGE, fit, fmt, folio, hex, kicker, tracked, trackedWidth, winAnsi, wordmark, wordmarkHeight, wrap,
  wrapLines, type Fonts, type Pen,
} from './pdfBrand.js'
import type { EstimateExport, ExportScope } from './estimateExport.js'
import {
  addSnapshotPages, drawKeyPlan, embedDrawings, keyPlanSubject, scaleBar,
  type Frame, type SheetSet, type SnapshotSection,
} from './snapshotPages.js'

export interface EstimatePdfInput {
  estimate: EstimateExport
  /** One picture per takeoff area, planned (snapshotPlan.ts). */
  snapshots?: SnapshotSection
  /** The drawings those pictures come from, parsed, by document id. */
  drawings?: ReadonlyMap<string, PDFDocument>
  /** A document id's name, for a note about a drawing that would not open. */
  documentName?: (documentId: string) => string
  /** Something went wrong producing a picture; said on the page, not hidden. */
  notes?: readonly string[]
}

/** A place on a quantities page where a scope's snapshot pages are named, once they are known. */
interface PageRef { page: PDFPage; right: number; y: number; scopeId: string }

const pageRange = (numbers: number[]) =>
  numbers.length === 0 ? '' : numbers.length === 1 ? `${numbers[0]}` : `${numbers[0]}–${numbers[numbers.length - 1]}`

// ------------------------------------------------------------------ cover --

interface ContentsRow { scope: ExportScope | null; label: string; quantity: string; pages: string }

const ROW = 15
/** Where text on the cover may come down to. */
const COVER_FLOOR = FOLIO_Y + 22
/** A takeoff this much wider than tall gets the cover's full width. */
const WIDE = 1.9

/**
 * The name the document goes by, and a second only when it adds something.
 *
 * A file's estimate is named after the file, so the project and the estimate
 * are often the same long name, and the cover set it twice, large and small,
 * and both ran off the page (Kenneth, 2026-11-24). One name that holds the
 * other is said once: the longer.
 */
export function documentNames(e: Pick<EstimateExport, 'projectName' | 'estimateName'>): { title: string; second: string } {
  const project = e.projectName.replace(/\s+/g, ' ').trim()
  const estimate = e.estimateName.replace(/\s+/g, ' ').trim()
  const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const p = key(project), q = key(estimate)
  if (q === '' || p.includes(q)) return { title: project || estimate || 'Takeoff', second: '' }
  if (p === '' || q.includes(p)) return { title: estimate, second: '' }
  return { title: project, second: estimate }
}

/** The running title: what the folio and the file's own title say. */
export function runningTitle(e: Pick<EstimateExport, 'projectName' | 'estimateName'>): string {
  const { title, second } = documentNames(e)
  return second === '' ? title : `${title} · ${second}`
}

/** The title's sizes, largest first, and the lines each may take: a long name steps down rather than run off the page. */
const TITLE_STEPS = [[26, 2], [21, 3], [17, 3], [14, 4]] as const

/**
 * The title block, measured: each line and its baseline, as a distance down
 * from the block's top, and the room the block takes. Drawing and measuring
 * both read this, so the contents under it cannot be placed for another one.
 */
function titleLayout(fonts: Fonts, e: EstimateExport, width: number) {
  const { title, second } = documentNames(e)
  const [smallest, mostLines] = TITLE_STEPS[TITLE_STEPS.length - 1]!
  let size: number = smallest
  let lines: string[] = []
  for (const [s, max] of TITLE_STEPS) {
    size = s
    lines = wrap(fonts.display, s, title, width)
    if (lines.length <= max) break
  }
  if (lines.length > mostLines) lines = wrapLines(fonts.display, size, title, width, mostLines)
  const lead = Math.round(size * 1.16)
  const set: Array<{ text: string; down: number; size: number; font: 'display' | 'text'; tone: 'ink' | 'dim' | 'faint' }> = []
  let down = 8 + size
  lines.forEach((text, i) => set.push({ text, down: down + i * lead, size, font: 'display', tone: 'ink' }))
  down += (lines.length - 1) * lead + size * 0.25 + 15
  for (const text of second === '' ? [] : wrapLines(fonts.text, 12, second, width, 2)) {
    set.push({ text, down, size: 12, font: 'text', tone: 'dim' })
    down += 16
  }
  const subtitle = e.subtitle.trim()
  if (subtitle !== '') {
    set.push({ text: fit(fonts.text, 9.5, subtitle, width), down: down - 1, size: 9.5, font: 'text', tone: 'faint' })
    down += 15
  }
  return { set, height: set[set.length - 1]!.down + 17 }
}

const titleHeight = (fonts: Fonts, e: EstimateExport, width: number) => titleLayout(fonts, e, width).height

/** What and for whom: the kicker, the name, a second name when there is one, the subtitle. */
function titleBlock(pen: Pen, e: EstimateExport, x: number, top: number, width: number): void {
  kicker(pen, x, top, 'Takeoff estimate')
  const tones = { ink: BRAND.ink, dim: BRAND.inkDim, faint: BRAND.inkFaint }
  for (const l of titleLayout(pen, e, width).set) {
    pen.page.drawText(l.text, { x, y: top - l.down, size: l.size, font: l.font === 'display' ? pen.display : pen.text, color: tones[l.tone] })
  }
}

const contentsHeight = (rows: readonly ContentsRow[]) => 8 + rows.length * ROW + 6

/**
 * Every scope with its headline quantity and the pages its pictures are on.
 * What does not fit above `floor` is counted on the last line instead.
 */
function contentsList(pen: Pen, rows: readonly ContentsRow[], x: number, top: number, width: number, floor: number): void {
  const { page } = pen
  tracked(pen, x, top, 'CONTENTS', 6.5, pen.bold, BRAND.inkFaint, 0.9)
  let y = top - 8
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.6, color: BRAND.ruleStrong })
  const pageCol = x + width
  const qtyCol = pageCol - 34
  const room = Math.max(1, Math.floor((y - floor) / ROW))
  for (const [i, row] of rows.entries()) {
    y -= ROW
    if (rows.length > room && i === room - 1) {
      const more = rows.length - i
      page.drawText(`${more} more in the quantities`, { x, y, size: 8.5, font: pen.text, color: BRAND.inkFaint })
      break
    }
    const font = row.scope !== null ? pen.bold : pen.text
    const indent = row.scope !== null ? 12 : 0
    if (row.scope !== null) page.drawCircle({ x: x + 3.5, y: y + 3, size: 3.2, color: hex(row.scope.color) })
    const labelW = qtyCol - x - indent - pen.text.widthOfTextAtSize(row.quantity, 8.5) - 10
    page.drawText(fit(font, 8.5, row.label, labelW), { x: x + indent, y, size: 8.5, font, color: BRAND.ink })
    page.drawText(row.quantity, { x: qtyCol - pen.text.widthOfTextAtSize(row.quantity, 8.5), y, size: 8.5, font: pen.text, color: BRAND.inkDim })
    page.drawText(row.pages, { x: pageCol - pen.text.widthOfTextAtSize(row.pages, 8.5), y, size: 8.5, font: pen.text, color: BRAND.inkFaint })
    page.drawLine({ start: { x, y: y - 5 }, end: { x: x + width, y: y - 5 }, thickness: 0.4, color: BRAND.rule })
  }
}

/** Provenance, set up from the foot of the page. Returns the top of what it set. */
function facts(pen: Pen, e: EstimateExport, x: number, width: number, draw = true): number {
  const rows: Array<[string, string]> = [
    ['Prepared', e.generatedAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })],
    [e.documents.length === 1 ? 'Drawing' : 'Drawings', e.documents.join(', ') || 'None'],
  ]
  let y = FOLIO_Y + 6
  let top = y
  for (const [label, value] of [...rows].reverse()) {
    const lines = wrapLines(pen.text, 7.5, value, width - 62, 2)
    top = y + (lines.length - 1) * 10
    if (draw) {
      tracked(pen, x, top, label.toUpperCase(), 6, pen.bold, BRAND.inkFaint, 0.8)
      lines.forEach((line, i) => pen.page.drawText(line, { x: x + 62, y: top - i * 10, size: 7.5, font: pen.text, color: BRAND.inkDim }))
    }
    y = top + 16
  }
  return top + 8
}

/** "Key plan · A1.203", its scale bar, and what else the snapshots show. */
function planCaption(pen: Pen, frame: Frame, shown: { sheetLabel: string; pointsPerFoot: number | null }, others: number): void {
  const y = frame.y - 14
  const right = PAGE.w - M.right
  // A sheet can be named for its whole file: it gives way to the scale bar.
  const head = fit(pen.text, 7.5, `Key plan  ·  ${shown.sheetLabel}`, Math.max(140, right - frame.x - 260))
  pen.page.drawText(head, { x: frame.x, y, size: 7.5, font: pen.text, color: BRAND.inkFaint })
  let x = frame.x + pen.text.widthOfTextAtSize(head, 7.5) + 10
  if (shown.pointsPerFoot !== null && shown.pointsPerFoot > 0) x = scaleBar(pen, x, y, shown.pointsPerFoot) + 10
  if (others > 0 && right - x > 40) {
    const tail = `·  ${others} more sheet${others === 1 ? '' : 's'} in the snapshots`
    pen.page.drawText(fit(pen.text, 7.5, tail, right - x), { x, y, size: 7.5, font: pen.text, color: BRAND.inkFaint })
  }
}

/**
 * The cover. The key plan is its picture, so the plan decides the layout: a
 * takeoff that runs wide across a floor gets the page's full width over the
 * title and contents; any other sits right of them, as large as it fits.
 */
async function cover(
  doc: PDFDocument, fonts: Fonts, e: EstimateExport, sheets: SheetSet | null, input: EstimatePdfInput,
  contents: readonly ContentsRow[],
): Promise<PDFPage> {
  const page = doc.insertPage(0, [PAGE.w, PAGE.h])
  const pen: Pen = { page, ...fonts }
  const measure = PAGE.w - M.left - M.right
  const markTop = M.top + 4
  wordmark(page, M.left, markTop, 128)

  const subject = sheets !== null && input.snapshots !== undefined ? keyPlanSubject(input.snapshots.cards) : null
  const colorOf = (id: string) => e.scopes.find((s) => s.id === id)?.color
  const plan = async (frame: Frame) => {
    const shown = await drawKeyPlan(doc, page, sheets!, subject!, colorOf, frame)
    planCaption(pen, frame, shown, subject!.others)
  }

  // Wide: the plan across the top, the title under it left, the contents right.
  if (subject !== null && subject.aspect >= WIDE) {
    const leftW = 380
    const rightX = M.left + leftW + 40
    const rightW = PAGE.w - M.right - rightX
    const planTop = PAGE.h - markTop - wordmarkHeight(128) - 28
    const text = Math.max(titleHeight(fonts, e, leftW) + 24 + (facts(pen, e, M.left, leftW, false) - COVER_FLOOR), contentsHeight(contents))
    const planH = Math.min(measure / subject.aspect, planTop - COVER_FLOOR - text - 14 - 40)
    if (planH >= 150) {
      // Full width unless that would show the sheet's border and title block
      // to fill it: then the plan keeps to the takeoff and the paper shows.
      const frame = { x: M.left, y: planTop - planH, w: Math.min(measure, planH * subject.aspect * 1.12), h: planH }
      await plan(frame)
      const top = frame.y - 14 - 40
      titleBlock(pen, e, M.left, top, leftW)
      contentsList(pen, contents, rightX, top, rightW, COVER_FLOOR - 16)
      facts(pen, e, M.left, leftW)
      return page
    }
  }

  // Otherwise: the title and contents in a column, the plan right of them.
  const colW = subject !== null ? 250 : 420
  if (subject !== null) {
    const x = M.left + colW + 36
    const w = PAGE.w - M.right - x
    const top = PAGE.h - markTop
    const bottom = FOLIO_Y + 46
    const h = Math.min(top - bottom, w / subject.aspect)
    const fw = Math.min(w, h * subject.aspect)
    await plan({ x: x + (w - fw) / 2, y: (top + bottom) / 2 - h / 2, w: fw, h })
  }
  const top = PAGE.h - M.top - 128
  titleBlock(pen, e, M.left, top, colW)
  const factsTop = facts(pen, e, M.left, colW)
  contentsList(pen, contents, M.left, top - titleHeight(fonts, e, colW) - 26, colW, factsTop + 18)
  return page
}

// ------------------------------------------------------------- quantities --

/** A line's standing, in a word; why, when there is a why, is its footnote. */
const STANDING: Record<ExportScope['components'][number]['confidence'], string> = {
  verified: 'Verified',
  unverified: 'Not verified',
  blocked: 'Blocked',
}

function quantityPages(doc: PDFDocument, fonts: Fonts, e: EstimateExport): { pages: PDFPage[]; refs: PageRef[] } {
  const pages: PDFPage[] = []
  const refs: PageRef[] = []
  const right = PAGE.w - M.right
  const cols = { item: M.left + 17, qty: M.left + 470, unit: M.left + 480, standing: M.left + 520 }
  const rowH = 15
  const top = PAGE.h - M.top - 78
  const bottom = FOLIO_Y + 34

  let page!: PDFPage
  let pen!: Pen
  let y = 0
  const newPage = () => {
    page = doc.addPage([PAGE.w, PAGE.h])
    pen = { page, ...fonts }
    wordmark(page, right - 78, M.top + 1, 78)
    kicker(pen, M.left, PAGE.h - M.top - 8, pages.length === 0 ? 'Quantities' : 'Quantities, continued')
    page.drawText('What each scope measured, and what it orders', {
      x: M.left, y: PAGE.h - M.top - 34, size: 17, font: fonts.display, color: BRAND.ink,
    })
    for (const [label, x, alignRight] of [['Item', cols.item, false], ['Qty', cols.qty, true], ['Unit', cols.unit, false], ['Standing', cols.standing, false]] as const) {
      const w = trackedWidth(fonts.bold, 6, label.toUpperCase(), 0.8)
      tracked(pen, alignRight ? x - w : x, top, label.toUpperCase(), 6, fonts.bold, BRAND.inkFaint, 0.8)
    }
    page.drawLine({ start: { x: M.left, y: top - 6 }, end: { x: right, y: top - 6 }, thickness: 0.6, color: BRAND.ruleStrong })
    y = top - 6
    pages.push(page)
  }
  newPage()

  /** A scope's heading: a band with its dot, its name, its product, and where its pictures are. */
  const heading = (s: ExportScope) => {
    // Never a heading alone at the foot of a page: two of its rows go with it.
    const rows = Math.max(1, s.quantities.length + s.components.length)
    if (y - 30 - rowH * Math.min(2, rows) < bottom) newPage()
    y -= 22
    page.drawRectangle({ x: M.left, y: y - 6, width: right - M.left, height: 20, color: BRAND.surface })
    page.drawCircle({ x: M.left + 8, y: y + 3.5, size: 3.5, color: hex(s.color) })
    page.drawText(fit(fonts.bold, 9.5, s.label, 300), { x: cols.item, y, size: 9.5, font: fonts.bold, color: BRAND.ink })
    const labelW = fonts.bold.widthOfTextAtSize(fit(fonts.bold, 9.5, s.label, 300), 9.5)
    const where = s.sheets.length <= 3 ? s.sheets : [...s.sheets.slice(0, 2), `${s.sheets.length - 2} more sheets`]
    page.drawText(fit(fonts.text, 8, [s.product, where.join(', ')].filter((t) => t !== '').join('  ·  '), cols.qty - cols.item - labelW - 60), {
      x: cols.item + labelW + 10, y, size: 8, font: fonts.text, color: BRAND.inkDim,
    })
    refs.push({ page, right: right - 8, y, scopeId: s.id })
    y -= 8
  }

  const row = (item: string, qty: string, unit: string, standing: string, flagged: boolean, mark: string) => {
    if (y - rowH < bottom) newPage()
    y -= rowH
    if (flagged) page.drawRectangle({ x: M.left + 6, y: y - 3, width: 1.6, height: rowH - 4, color: BRAND.accent })
    page.drawText(fit(fonts.text, 8.5, item, cols.qty - cols.item - 60), { x: cols.item, y, size: 8.5, font: fonts.text, color: BRAND.ink })
    page.drawText(qty, { x: cols.qty - fonts.bold.widthOfTextAtSize(qty, 8.5), y, size: 8.5, font: fonts.bold, color: BRAND.ink })
    page.drawText(winAnsi(unit), { x: cols.unit, y, size: 8, font: fonts.text, color: BRAND.inkDim })
    const tone = flagged ? BRAND.accentInk : BRAND.inkFaint
    page.drawText(standing, { x: cols.standing, y, size: 7.5, font: fonts.text, color: tone })
    if (mark !== '') {
      // The note's number, raised, the way a footnote is called.
      const at = cols.standing + fonts.text.widthOfTextAtSize(standing, 7.5) + 1.5
      page.drawText(mark, { x: at, y: y + 3, size: 5.5, font: fonts.bold, color: tone })
    }
    page.drawLine({ start: { x: cols.item, y: y - 5 }, end: { x: right, y: y - 5 }, thickness: 0.4, color: BRAND.rule })
  }

  /** A scope's notes, numbered, under its rows: said once, not cut off in a column. */
  const footnotes = (notes: string[]) => {
    if (notes.length === 0) return
    y -= 3
    notes.forEach((n, k) => {
      wrap(fonts.text, 7, n, right - cols.standing + cols.qty - cols.item - 60).forEach((line, i) => {
        if (y - 10 < bottom) newPage()
        y -= 10
        if (i === 0) page.drawText(`${k + 1}`, { x: cols.item, y: y + 1, size: 5.5, font: fonts.bold, color: BRAND.inkFaint })
        page.drawText(line, { x: cols.item + 8, y, size: 7, font: fonts.text, color: BRAND.inkDim })
      })
    })
  }

  for (const s of e.scopes) {
    heading(s)
    const unscaled = s.unscaledSheets ?? []
    if (s.quantities.length === 0 && s.components.length === 0 && unscaled.length === 0) row('No takeoff yet', '—', '', '', false, '')
    for (const q of s.quantities) row(q.label, fmt(q.quantity), q.unit, 'Measured', false, '')
    const notes: string[] = []
    for (const c of s.components) {
      const note = c.note?.trim() ?? ''
      let mark = ''
      if (note !== '') {
        if (!notes.includes(note)) notes.push(note)
        mark = `${notes.indexOf(note) + 1}`
      }
      row(c.label, c.quantity === null ? '—' : fmt(c.quantity), c.unit, STANDING[c.confidence], c.confidence !== 'verified', mark)
    }
    if (unscaled.length > 0) {
      // Drawn, and in no number above: a quantity that silently leaves part
      // of the takeoff out is the expensive kind of wrong.
      const where = unscaled.length <= 2 ? unscaled.join(' and ') : `${unscaled.length} sheets`
      notes.push(`Takeoff on ${unscaled.length <= 2 ? where : `${where} (${unscaled.join(', ')})`} is not in these quantities: nothing gives ${unscaled.length === 1 ? 'that sheet' : 'those sheets'} a scale yet.`)
      row(`Not measured: ${where}`, '—', '', 'No scale', true, `${notes.length}`)
    }
    footnotes(notes)
    if (s.note.trim() !== '') {
      y -= 4
      for (const line of wrap(fonts.text, 7.5, s.note.trim(), right - cols.item)) {
        if (y - 11 < bottom) newPage()
        y -= 11
        page.drawText(line, { x: cols.item, y, size: 7.5, font: fonts.text, color: BRAND.inkDim })
      }
    }
    y -= 6
  }

  const attention = e.scopes.reduce((n, s) =>
    n + s.components.filter((c) => c.confidence !== 'verified').length + ((s.unscaledSheets ?? []).length > 0 ? 1 : 0), 0)
  if (attention > 0) {
    const text = `${attention} line${attention === 1 ? '' : 's'} marked. A marked line is blocked, not measured, or produced by an engine no golden fixture reproduces yet; the quantity may be right, and it has not been proven.`
    const lines = wrap(fonts.text, 7.5, text, right - M.left - 24)
    if (y - 18 - lines.length * 11 < bottom) newPage()
    y -= 18
    const from = y + 9
    for (const line of lines) {
      page.drawText(line, { x: M.left + 14, y, size: 7.5, font: fonts.text, color: BRAND.inkDim })
      y -= 11
    }
    page.drawRectangle({ x: M.left + 6, y: y + 8, width: 1.6, height: from - y - 8, color: BRAND.accent })
  }
  return { pages, refs }
}

// ------------------------------------------------------------------ notes --

function notesPage(doc: PDFDocument, fonts: Fonts, notes: readonly string[]): PDFPage {
  const page = doc.addPage([PAGE.w, PAGE.h])
  const pen = { page, ...fonts }
  wordmark(page, PAGE.w - M.right - 78, M.top + 1, 78)
  kicker(pen, M.left, PAGE.h - M.top - 8, 'Notes')
  page.drawText('What this document could not show', {
    x: M.left, y: PAGE.h - M.top - 34, size: 17, font: fonts.display, color: BRAND.ink,
  })
  let y = PAGE.h - M.top - 66
  for (const n of notes) {
    const lines = wrap(fonts.text, 9, n, PAGE.w - M.left - M.right - 14)
    page.drawCircle({ x: M.left + 3, y: y + 3, size: 1.6, color: BRAND.inkDim })
    for (const line of lines) {
      page.drawText(line, { x: M.left + 14, y, size: 9, font: fonts.text, color: BRAND.inkDim })
      y -= 13
    }
    y -= 5
  }
  return page
}

// --------------------------------------------------------------- document --

/** Render the whole document. Returns the PDF bytes. */
export async function renderEstimatePdf(input: EstimatePdfInput): Promise<Uint8Array> {
  const { estimate: e } = input
  const doc = await PDFDocument.create()
  doc.setTitle(runningTitle(e))
  doc.setAuthor('Maxxit')
  doc.setProducer('REDBEAM')
  doc.setCreationDate(e.generatedAt)
  const fonts = {
    text: await doc.embedFont(StandardFonts.Helvetica),
    display: await doc.embedFont(StandardFonts.HelveticaBold),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  }

  // Everything after the cover first: the cover's contents need its pages.
  const quantities = quantityPages(doc, fonts, e)
  const notes = [...(input.notes ?? [])]
  let sheets: SheetSet | null = null
  let sections = new Map<string, PDFPage[]>()
  if (input.snapshots !== undefined && input.snapshots.cards.length > 0) {
    sheets = await embedDrawings(doc, input.snapshots.cards, input.drawings ?? new Map(), input.documentName)
    notes.push(...sheets.notes)
    sections = (await addSnapshotPages(doc, fonts, {
      section: input.snapshots,
      scopes: e.scopes.map((s) => ({ id: s.id, label: s.label, product: s.product, color: s.color })),
    }, sheets)).sections
  }
  const notesAt = notes.length > 0 ? notesPage(doc, fonts, notes) : null

  // Page numbers count the cover, which goes in front.
  const numberOf = (p: PDFPage) => doc.getPages().indexOf(p) + 2
  const contents: ContentsRow[] = [
    { scope: null, label: 'Quantities by scope', quantity: '', pages: pageRange(quantities.pages.map(numberOf)) },
  ]
  for (const s of e.scopes) {
    const head = s.quantities[0]
    contents.push({
      scope: s,
      label: s.label,
      quantity: head !== undefined ? `${fmt(head.quantity)} ${head.unit}` : (s.unscaledSheets ?? []).length > 0 ? 'No scale' : 'No takeoff yet',
      pages: pageRange((sections.get(s.id) ?? []).map(numberOf)),
    })
  }
  if (notesAt !== null) contents.push({ scope: null, label: 'Notes', quantity: '', pages: `${numberOf(notesAt)}` })
  await cover(doc, fonts, e, sheets, input, contents)

  // Each scope's heading in the quantities says where its pictures are.
  for (const ref of quantities.refs) {
    const pages = (sections.get(ref.scopeId) ?? []).map((p) => doc.getPages().indexOf(p) + 1)
    if (pages.length === 0) continue
    const text = `Snapshots  p. ${pageRange(pages)}`
    ref.page.drawText(text, { x: ref.right - fonts.text.widthOfTextAtSize(text, 7.5), y: ref.y + 0.5, size: 7.5, font: fonts.text, color: BRAND.inkFaint })
  }

  // Folios, once every page exists. The cover has none.
  const all = doc.getPages()
  const running = runningTitle(e)
  all.forEach((page, i) => {
    if (i === 0) return
    folio({ page, ...fonts }, running, i + 1, all.length)
  })
  return doc.save()
}
