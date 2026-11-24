/**
 * The snapshot pages of the estimate PDF: one picture per takeoff area.
 *
 * Each picture is a window on the sheet, drawn from the sheet's own vectors
 * (sheetForms.ts) and dimmed under a white veil, so the drawing reads as
 * quiet context. Over it the takeoff is drawn in its scope's colour, in this
 * order, because that order IS the emphasis Aaron asked for:
 *
 *  1. every stock piece laid out for the area, whole, at 40% — what hangs
 *     past the edge (the offcut) is all that stays visible of this layer;
 *  2. the same pieces at full strength, clipped to the area as measured —
 *     the installed product, bright and bold, with a hairline of paper
 *     between pieces so each one can be counted;
 *  3. the area's edge, a thin grey hairline: it says where the cut is
 *     without competing with the product.
 *
 * An area whose scope has no layout (custom work, a scope missing a size or
 * a direction) has nothing to put in it, so the area itself is the takeoff
 * and is drawn as a wash with a solid edge. Runs and counts are drawn as
 * lines and dots.
 *
 * Pictures are grouped by scope, a section per scope, and set in an even
 * grid: every row runs the full measure, and a picture fills its place by
 * showing more of the sheet around it, never by changing its scale. Their
 * scales come from the plan, which keeps to one for the whole export (and one
 * larger for takeoff too small to read), so the pictures show the areas in
 * proportion to one another.
 *
 * The same sheets also make the key plan on the cover: the sheet with the
 * most takeoff on it, every scope in its colour.
 */
import {
  PDFName, PDFNumber, PDFOperator, PDFRef, rgb,
  type PDFDocument, type PDFOperatorNames, type PDFPage, type RGB,
} from 'pdf-lib'
import { BRAND, FOLIO_Y, M, PAGE, fit, fmt, hex, kicker, wordmark, type Fonts, type Pen } from './pdfBrand.js'
import { embedSheets, windowForm, windowMatrix, type SheetForm } from './sheetForms.js'
import {
  scaleBarFeet, type NormBox, type NormPoint, type NormRing, type SnapshotBand, type SnapshotCard,
} from './snapshotPlan.js'

/** Where pictures may go on a snapshot page. */
const TOP = PAGE.h - M.top - 64
const BOTTOM = FOLIO_Y + 24
const CAPTION = 30
const GUTTER_X = 18
const GUTTER_Y = 12

/** The largest picture a snapshot page can hold. The planner sizes to this. */
export const SNAPSHOT_FRAME = { width: PAGE.w - M.left - M.right, height: TOP - BOTTOM - CAPTION } as const
/** The smallest: the caption under it needs the width. */
export const SNAPSHOT_MIN = { width: 176, height: 96 } as const

/** How much of the drawing the veil takes away. 0.72 leaves black linework a light grey. */
const DIM = 0.72
/** The offcut, past the area's edge (Aaron: "thirty to fifty percent"). */
const OFFCUT = 0.4
/** The scope's colour laid under its product inside the area, so thin stock still reads as the area. */
const TINT = 0.16
/** Inside the area the drawing is dimmed again by this much: the product is the subject there. */
const KNOCK = 0.6
/** The narrowest a run's piece is drawn, points: a 2" baffle at 1/16" is 0.75. */
const MIN_BAND = 0.9
/** A scope's area on the key plan: its colour, the drawing just showing through. */
const PLAN = 0.82
/** A run, drawn: its line and the dot at each end, points. */
const RUN = 2.4
const RUN_END = 2.1
/** The band along a run where the drawing is dimmed again, points. */
const RUN_ROOM = 14
/** Perimeter trim on an area's edge, and the tick where one length meets the next, points. */
const TRIM = 1.7
const TRIM_TICK = 8
const TRIM_TICK_W = 1
const PAPER = rgb(1, 1, 1)
const EDGE = hex('#4A5058')

/** The scope's colour, deepened toward Maxxit Black: trim, which runs along its product's edge. */
const deep = (c: RGB): RGB => rgb(
  c.red * 0.6 + BRAND.ink.red * 0.4, c.green * 0.6 + BRAND.ink.green * 0.4, c.blue * 0.6 + BRAND.ink.blue * 0.4,
)

export interface SnapshotScope {
  id: string
  label: string
  product: string
  color: string
}

export interface SnapshotSection {
  cards: readonly SnapshotCard[]
  /** The scale the pictures share, for the section headers. */
  baseLabel: string | null
  /** The one larger scale small takeoff is printed at, if any. */
  detailLabel?: string | null
}

export interface SnapshotInput {
  section: SnapshotSection
  /** Scopes in the export's order, with the names as edited for the client. */
  scopes: readonly SnapshotScope[]
}

/** The sheets the pictures are drawn from, carried into the export once. */
export interface SheetSet {
  forms: Map<string, Map<number, SheetForm>>
  /** A drawing that would not open, said so. */
  notes: string[]
}

// ------------------------------------------------------------- operators --

const r2 = (n: number) => Math.round(n * 100) / 100
const r5 = (n: number) => Math.round(n * 100000) / 100000

/** A content stream built by hand: pdf-lib's drawing calls cannot clip. */
class Ink {
  readonly ops: PDFOperator[] = []
  private op(name: string, args: Array<number | PDFName> = [], round: (n: number) => number = r2): this {
    this.ops.push(PDFOperator.of(name as PDFOperatorNames, args.map((a) => (typeof a === 'number' ? PDFNumber.of(round(a)) : a))))
    return this
  }
  save() { return this.op('q') }
  restore() { return this.op('Q') }
  state(gs: PDFName) { return this.op('gs', [gs]) }
  fillColor(c: RGB) { return this.op('rg', [c.red, c.green, c.blue], r5) }
  strokeColor(c: RGB) { return this.op('RG', [c.red, c.green, c.blue], r5) }
  width(w: number) { return this.op('w', [w], r5) }
  round() { return this.op('J', [1]).op('j', [1]) }
  rect(x: number, y: number, w: number, h: number) { return this.op('re', [x, y, w, h]) }
  move(x: number, y: number) { return this.op('m', [x, y]) }
  line(x: number, y: number) { return this.op('l', [x, y]) }
  curve(a: number, b: number, c: number, d: number, e: number, f: number) { return this.op('c', [a, b, c, d, e, f]) }
  close() { return this.op('h') }
  fill() { return this.op('f') }
  fillEvenOdd() { return this.op('f*') }
  stroke() { return this.op('S') }
  clip() { return this.op('W').op('n') }
  clipEvenOdd() { return this.op('W*').op('n') }
  transform(m: readonly number[]) { return this.op('cm', [...m], r5) }
  paint(xobject: PDFName) { return this.op('Do', [xobject]) }
}

interface States { grey: PDFName; veil: PDFName; knock: PDFName; fade: PDFName; edge: PDFName; wash: PDFName; tint: PDFName; plan: PDFName }

const stateRefs = new WeakMap<PDFDocument, Record<keyof States, PDFRef>>()

/** The graphics states a page draws pictures with, made once per document. */
function statesFor(doc: PDFDocument, page: PDFPage): States {
  const refs = stateRefs.get(doc) ?? makeStates(doc)
  stateRefs.set(doc, refs)
  const out = {} as States
  for (const k of Object.keys(refs) as Array<keyof States>) out[k] = page.node.newExtGState('GS', refs[k])
  return out
}

function makeStates(doc: PDFDocument): Record<keyof States, PDFRef> {
  const gs = (o: Record<string, number | string>) => doc.context.register(doc.context.obj({ Type: 'ExtGState', ...o }))
  return {
    plan: gs({ ca: PLAN }),
    // Grey painted in the Saturation blend mode keeps what is beneath it and
    // takes its colour away: a drawing's red clouds and yellow highlights
    // would otherwise read as takeoff.
    grey: gs({ BM: 'Saturation' }),
    veil: gs({ ca: DIM }),
    knock: gs({ ca: KNOCK, CA: KNOCK }),
    fade: gs({ ca: OFFCUT, CA: OFFCUT }),
    edge: gs({ CA: 0.6 }),
    wash: gs({ ca: 0.42 }),
    tint: gs({ ca: TINT }),
  }
}

// ----------------------------------------------------------------- cards --

export interface Frame { x: number; y: number; w: number; h: number }

/** Paper, then the sheet through the window, its colour taken out, then the veil that dims it. */
function paintSheet(ink: Ink, at: Frame, view: NormBox, sheet: { form: SheetForm; name: PDFName } | null, gs: States): void {
  const { x, y, w, h } = at
  ink.save().fillColor(PAPER).rect(x, y, w, h).fill().restore()
  if (sheet === null) return
  ink.save().rect(x, y, w, h).clip()
    .transform(windowMatrix(sheet.form, view, { x, y, width: w, height: h }))
    .paint(sheet.name)
    .restore()
  ink.save().state(gs.grey).fillColor(rgb(0.5, 0.5, 0.5)).rect(x, y, w, h).fill().restore()
  ink.save().state(gs.veil).fillColor(PAPER).rect(x, y, w, h).fill().restore()
}

/** The hairline that holds a picture on white paper. */
function frameLine(ink: Ink, at: Frame): void {
  ink.save().strokeColor(BRAND.ruleStrong).width(0.6).rect(at.x, at.y, at.w, at.h).stroke().restore()
}

function drawCard(
  ink: Ink, card: SnapshotCard, at: Frame, view: NormBox, color: RGB,
  sheet: { form: SheetForm; name: PDFName } | null, gs: States,
): void {
  const { x, y, w, h } = at
  const fx = card.sheetWidth * card.zoom
  const fy = card.sheetHeight * card.zoom
  const X = (p: NormPoint) => x + (p.x - view.x0) * fx
  const Y = (p: NormPoint) => y + h - (p.y - view.y0) * fy
  const ring = (r: readonly NormPoint[]) => {
    r.forEach((p, i) => (i === 0 ? ink.move(X(p), Y(p)) : ink.line(X(p), Y(p))))
    if (r.length > 2) ink.close()
  }

  paintSheet(ink, at, view, sheet, gs)

  ink.save().rect(x, y, w, h).clip()
  const laidOut = card.pieces.length > 0 || card.bands.length > 0
  if (card.kind === 'area' && laidOut) {
    // The paper between pieces: a hairline, thinner on a thin piece so a
    // narrow plank stays a plank and not a gap.
    const shortest = card.pieces.length === 0 ? 0 : median(card.pieces.map((p) => shortSide(p.ring, fx, fy)))
    const seam = Math.min(0.5, shortest * 0.16)
    // A run's pieces are stroked, never thinner than can be seen.
    const bandWidth = (b: SnapshotBand) => (b.width > 0 ? Math.max(b.width * card.zoom, MIN_BAND) : 1.4)
    const strokeBands = () => {
      let current = -1
      for (const b of card.bands) {
        const wd = bandWidth(b)
        if (Math.abs(wd - current) > 1e-3) {
          if (current >= 0) ink.stroke()
          ink.width(wd)
          current = wd
        }
        ink.move(X(b.a), Y(b.a)).line(X(b.b), Y(b.b))
      }
      if (current >= 0) ink.stroke()
    }

    // 1. Every piece whole, faded: outside the area this is the offcut.
    ink.save().state(gs.fade).fillColor(color).strokeColor(color)
    for (const p of card.pieces) ring(p.ring)
    if (card.pieces.length > 0) ink.fill()
    strokeBands()
    ink.restore()
    if (seam > 0.05 && card.pieces.length > 0) {
      ink.save().strokeColor(PAPER).width(seam)
      for (const p of card.pieces) ring(p.ring)
      ink.stroke().restore()
    }

    // 2. The installed product, full strength, inside the area. The drawing
    // steps further back there, under a tint of the scope's colour, so the
    // area reads as one thing even where the stock is thin.
    ink.save()
    for (const r of card.region) ring(r)
    ink.clipEvenOdd()
    ink.save().state(gs.knock).fillColor(PAPER).rect(x, y, w, h).fill().restore()
    ink.save().state(gs.tint).fillColor(color).rect(x, y, w, h).fill().restore()
    if (card.pieces.length > 0) {
      ink.fillColor(color)
      for (const p of card.pieces) ring(p.ring)
      ink.fill()
      if (seam > 0.05) {
        ink.strokeColor(PAPER).width(seam)
        for (const p of card.pieces) ring(p.ring)
        ink.stroke()
      }
      hatch(ink, card, X, Y)
    }
    if (card.bands.length > 0) {
      ink.strokeColor(color)
      strokeBands()
      // Cut at the factory for a device: a line of paper down the piece.
      const cut = card.bands.filter((b) => b.factoryCut)
      if (cut.length > 0) {
        ink.strokeColor(PAPER).width(0.3)
        for (const b of cut) ink.move(X(b.a), Y(b.a)).line(X(b.b), Y(b.b))
        ink.stroke()
      }
    }
    if (card.seams.length > 0) {
      // A joint: a tick of paper across the run, as wide as the run is drawn.
      let across = 0
      for (const b of card.bands) across = Math.max(across, bandWidth(b))
      ink.strokeColor(PAPER).width(0.35)
      for (const [a, b] of card.seams) {
        const ax = X(a), ay = Y(a), bx = X(b), by = Y(b)
        const len = Math.hypot(bx - ax, by - ay)
        if (!(len > 0)) continue
        const half = Math.max(len, across) / 2 + 0.15
        const ux = (bx - ax) / len, uy = (by - ay) / len
        const mx = (ax + bx) / 2, my = (ay + by) / 2
        ink.move(mx - ux * half, my - uy * half).line(mx + ux * half, my + uy * half)
      }
      ink.stroke()
    }
    ink.restore()

    if (card.trim !== null) {
      // 3. Where the scope counts perimeter trim, the edge IS trim: the
      // takeoff counts it from the area's edge, never as a run of its own.
      // A deeper shade of the scope's colour, and a tick across it wherever
      // one length meets the next, so the lengths can be counted.
      const trim = deep(color)
      ink.save().strokeColor(trim).width(TRIM)
      for (const r of card.region) ring(r)
      ink.stroke().width(TRIM_TICK_W)
      for (const j of card.trim.joints) {
        // Sheet y runs down the page and paper y up it.
        const ux = j.along.x, uy = -j.along.y
        const cx = X(j.at), cy = Y(j.at)
        ink.move(cx + uy * TRIM_TICK / 2, cy - ux * TRIM_TICK / 2).line(cx - uy * TRIM_TICK / 2, cy + ux * TRIM_TICK / 2)
      }
      if (card.trim.joints.length > 0) ink.stroke()
      ink.restore()
    } else {
      // 3. The edge of the area: present, quiet.
      ink.save().state(gs.edge).strokeColor(EDGE).width(0.5)
      for (const r of card.region) ring(r)
      ink.stroke().restore()
    }
  } else if (card.kind === 'area') {
    // Nothing laid out: the measured area is the takeoff.
    ink.save()
    for (const r of card.region) ring(r)
    ink.clipEvenOdd()
    ink.save().state(gs.knock).fillColor(PAPER).rect(x, y, w, h).fill().restore()
    ink.save().state(gs.wash).fillColor(color).rect(x, y, w, h).fill().restore()
    ink.restore()
    ink.save().strokeColor(color).width(1.1)
    for (const r of card.region) ring(r)
    ink.stroke().restore()
  }

  if (card.lines.length > 0) {
    // The drawing steps back along a run the way it does inside an area,
    // then a paper casing keeps the line clear of the linework beneath, and
    // a dot at each end says where the run stops.
    ink.save().state(gs.knock).round().strokeColor(PAPER).width(RUN_ROOM)
    for (const l of card.lines) l.forEach((p, i) => (i === 0 ? ink.move(X(p), Y(p)) : ink.line(X(p), Y(p))))
    ink.stroke().restore()
    for (const [c, wd, dot] of [[PAPER, RUN + 2, RUN_END + 1], [color, RUN, RUN_END]] as const) {
      ink.save().round().strokeColor(c).width(wd)
      for (const l of card.lines) l.forEach((p, i) => (i === 0 ? ink.move(X(p), Y(p)) : ink.line(X(p), Y(p))))
      ink.stroke()
      ink.fillColor(c)
      for (const l of card.lines) {
        if (l.length < 2) continue
        circle(ink, X(l[0]!), Y(l[0]!), dot)
        circle(ink, X(l[l.length - 1]!), Y(l[l.length - 1]!), dot)
      }
      ink.fill().restore()
    }
  }
  if (card.points.length > 0) {
    ink.save().state(gs.knock).fillColor(PAPER)
    for (const p of card.points) circle(ink, X(p), Y(p), RUN_ROOM / 2)
    ink.fill().restore()
    for (const [c, rad] of [[PAPER, 3.8], [color, 2.7]] as const) {
      ink.save().fillColor(c)
      for (const p of card.points) circle(ink, X(p), Y(p), rad)
      ink.fill().restore()
    }
  }
  ink.restore()
  frameLine(ink, at)
}

/** Cross-hatch the pieces cut at the factory, inside the area. */
function hatch(ink: Ink, card: SnapshotCard, X: (p: NormPoint) => number, Y: (p: NormPoint) => number): void {
  const cut = card.pieces.filter((p) => p.factoryCut)
  if (cut.length === 0) return
  ink.save().strokeColor(PAPER).width(0.35)
  for (const p of cut) {
    const xs = p.ring.map(X), ys = p.ring.map(Y)
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
    ink.save()
    p.ring.forEach((q, i) => (i === 0 ? ink.move(X(q), Y(q)) : ink.line(X(q), Y(q))))
    ink.close().clip()
    const span = (x1 - x0) + (y1 - y0)
    for (let d = 0; d <= span; d += 2.4) {
      ink.move(x0 + d, y0).line(x0 + d - (y1 - y0), y1)
      ink.move(x1 - d, y0).line(x1 - d + (y1 - y0), y1)
    }
    ink.stroke().restore()
  }
  ink.restore()
}

function circle(ink: Ink, cx: number, cy: number, r: number): void {
  const k = 0.5523 * r
  ink.move(cx + r, cy)
    .curve(cx + r, cy + k, cx + k, cy + r, cx, cy + r)
    .curve(cx - k, cy + r, cx - r, cy + k, cx - r, cy)
    .curve(cx - r, cy - k, cx - k, cy - r, cx, cy - r)
    .curve(cx + k, cy - r, cx + r, cy - k, cx + r, cy)
    .close()
}

function shortSide(r: NormRing, fx: number, fy: number): number {
  let best = Infinity
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!, b = r[(i + 1) % r.length]!
    const len = Math.hypot((b.x - a.x) * fx, (b.y - a.y) * fy)
    if (len > 1e-6 && len < best) best = len
  }
  return Number.isFinite(best) ? best : 0
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!
}

// --------------------------------------------------------------- captions --

const noun = (kind: SnapshotCard['kind'], n: number) =>
  kind === 'count' ? `${n} count${n === 1 ? '' : 's'}` : `${n} run${n === 1 ? '' : 's'}`

function caption(pen: Pen, card: SnapshotCard, at: Frame, color: RGB): void {
  const { page } = pen
  const y1 = at.y - 11
  const y2 = at.y - 23
  page.drawCircle({ x: at.x + 3, y: y1 + 3, size: 3, color })
  const qty = card.quantity === null ? '' : `${fmt(card.quantity.value)} ${card.quantity.unit}`
  const qtyW = pen.bold.widthOfTextAtSize(qty, 8.5)
  page.drawText(qty, { x: at.x + at.w - qtyW, y: y1, size: 8.5, font: pen.bold, color: BRAND.ink })
  // The sheet's name can be a whole file name: it takes what room is left.
  const title = fit(pen.bold, 8.5, card.title, at.w - 11 - qtyW - 10)
  page.drawText(title, { x: at.x + 11, y: y1, size: 8.5, font: pen.bold, color: BRAND.ink })
  const titleW = pen.bold.widthOfTextAtSize(title, 8.5)
  const room = at.w - 11 - titleW - qtyW - 14
  if (room > 20) {
    page.drawText(fit(pen.text, 8, card.sheetLabel, room), { x: at.x + 11 + titleW + 6, y: y1, size: 8, font: pen.text, color: BRAND.inkDim })
  }

  // The scale, said and drawn: a bar reads at any print size. A group says
  // how many runs or counts it holds first; an area, the trim on its edge.
  const label = fit(pen.text, 7, [
    card.kind === 'area' ? '' : noun(card.kind, card.members),
    card.scale === null ? 'Not to scale' : card.scale.label,
    card.trim === null ? '' : `${card.trim.pieces} length${card.trim.pieces === 1 ? '' : 's'} of trim`,
  ].filter((t) => t !== '').join('  ·  '), at.w - 11)
  page.drawText(label, { x: at.x + 11, y: y2, size: 7, font: pen.text, color: BRAND.inkFaint })
  if (card.scale === null) return
  const bx = at.x + 11 + pen.text.widthOfTextAtSize(label, 7) + 10
  if (bx + scaleBarFeet(card.scale.pointsPerFoot) * card.scale.pointsPerFoot + 30 > at.x + at.w) return
  scaleBar(pen, bx, y2, card.scale.pointsPerFoot)
}

// ----------------------------------------------------------------- pages --

/** What the section's pictures add up to, for its header. */
function tally(cards: readonly SnapshotCard[]): string[] {
  const out: string[] = []
  const sum = (kind: SnapshotCard['kind'], unit: string) =>
    cards.filter((c) => c.kind === kind).reduce((n, c) => n + (c.quantity?.unit === unit ? c.quantity.value : 0), 0)
  const areas = cards.filter((c) => c.kind === 'area').length
  if (areas > 0) out.push(`${areas} area${areas === 1 ? '' : 's'}`, ...(sum('area', 'SF') > 0 ? [`${fmt(sum('area', 'SF'))} SF`] : []))
  const runs = cards.filter((c) => c.kind === 'line').reduce((n, c) => n + c.members, 0)
  if (runs > 0) out.push(noun('line', runs), ...(sum('line', 'LF') > 0 ? [`${fmt(sum('line', 'LF'))} LF`] : []))
  const counts = cards.filter((c) => c.kind === 'count').reduce((n, c) => n + c.members, 0)
  if (counts > 0) out.push(`${fmt(counts)} EA`)
  return out
}

/** How the section's pictures are scaled, in words. */
function scaleWords(cards: readonly SnapshotCard[]): string {
  const ppf = new Map<string, number>()
  let unscaled = false
  for (const c of cards) {
    if (c.scale === null) unscaled = true
    else ppf.set(c.scale.label, c.scale.pointsPerFoot)
  }
  const labels = [...ppf.keys()].sort((a, b) => ppf.get(a)! - ppf.get(b)!)
  const small = cards.every((c) => c.kind === 'area') ? 'small areas' : 'small takeoff'
  const said = labels.length === 0
    ? 'not to scale'
    : labels.length === 1
      ? `all at ${labels[0]}`
      : `at ${labels[0]}, ${small} at ${labels.slice(1).join(', ')}`
  return unscaled && labels.length > 0 ? `${said}; some not to scale` : said
}

function header(pen: Pen, scope: SnapshotScope, cards: readonly SnapshotCard[], continued: boolean): void {
  const { page } = pen
  wordmark(page, PAGE.w - M.right - 78, M.top + 1, 78)
  kicker(pen, M.left, PAGE.h - M.top - 8, continued ? 'Takeoff snapshots, continued' : 'Takeoff snapshots')
  const color = hex(scope.color)
  const ty = PAGE.h - M.top - 34

  // The key to the emphasis, in the scope's own colour, right of the title.
  const keys: Array<{ label: string; draw: (x: number, y: number) => void }> = []
  const tone = (opacity: number) =>
    rgb(color.red * opacity + 1 - opacity, color.green * opacity + 1 - opacity, color.blue * opacity + 1 - opacity)
  const swatch = (opacity: number) => (x: number, y: number) =>
    page.drawRectangle({ x, y: y - 1, width: 11, height: 7, color: tone(opacity) })
  const areas = cards.filter((c) => c.kind === 'area')
  if (areas.some((c) => c.pieces.length > 0 || c.bands.length > 0)) {
    keys.push({ label: 'Installed', draw: swatch(1) })
    keys.push({ label: 'Offcut past the edge', draw: swatch(OFFCUT) })
    if (areas.some((c) => c.trim === null && (c.pieces.length > 0 || c.bands.length > 0))) {
      keys.push({
        label: 'Area edge',
        draw: (x, y) => page.drawLine({ start: { x, y: y + 2.5 }, end: { x: x + 11, y: y + 2.5 }, thickness: 0.6, color: EDGE }),
      })
    }
    if (areas.some((c) => c.trim !== null)) {
      keys.push({
        label: 'Perimeter trim',
        draw: (x, y) => {
          page.drawLine({ start: { x, y: y + 2.5 }, end: { x: x + 13, y: y + 2.5 }, thickness: TRIM, color: deep(color) })
          page.drawLine({ start: { x: x + 6.5, y: y + 2.5 - TRIM_TICK / 2 }, end: { x: x + 6.5, y: y + 2.5 + TRIM_TICK / 2 }, thickness: TRIM_TICK_W, color: deep(color) })
        },
      })
    }
  } else if (areas.length > 0) {
    keys.push({ label: 'Measured area', draw: swatch(0.6) })
  }
  if (cards.some((c) => c.kind === 'line')) {
    keys.push({
      label: 'Run',
      draw: (x, y) => {
        page.drawLine({ start: { x: x + 1, y: y + 2.5 }, end: { x: x + 10, y: y + 2.5 }, thickness: RUN, color })
        page.drawCircle({ x: x + 1, y: y + 2.5, size: RUN_END, color })
        page.drawCircle({ x: x + 10, y: y + 2.5, size: RUN_END, color })
      },
    })
  }
  if (cards.some((c) => c.kind === 'count')) {
    keys.push({ label: 'Count', draw: (x, y) => page.drawCircle({ x: x + 5.5, y: y + 2.5, size: 2.7, color }) })
  }
  keys.push({
    label: 'Drawing, dimmed',
    draw: (x, y) => {
      page.drawRectangle({ x, y: y - 1, width: 11, height: 7, color: PAPER, borderColor: BRAND.ruleStrong, borderWidth: 0.5 })
      page.drawLine({ start: { x: x + 2, y: y + 2.5 }, end: { x: x + 9, y: y + 2.5 }, thickness: 0.6, color: hex('#B5B9BE') })
    },
  })
  const keyW = keys.reduce((n, k) => n + 16 + pen.text.widthOfTextAtSize(k.label, 7), 0) + (keys.length - 1) * 14
  let kx = PAGE.w - M.right - keyW
  const ky = ty - 17
  for (const k of keys) {
    k.draw(kx, ky)
    page.drawText(k.label, { x: kx + 16, y: ky, size: 7, font: pen.text, color: BRAND.inkDim })
    kx += 16 + pen.text.widthOfTextAtSize(k.label, 7) + 14
  }

  page.drawCircle({ x: M.left + 5, y: ty + 5.5, size: 5, color })
  page.drawText(fit(pen.display, 17, scope.label, PAGE.w - M.left - M.right - 120), {
    x: M.left + 17, y: ty, size: 17, font: pen.display, color: BRAND.ink,
  })
  const parts = [scope.product, ...tally(cards), scaleWords(cards)].filter((p) => p !== '')
  page.drawText(fit(pen.text, 8.5, parts.join('  ·  '), PAGE.w - M.left - M.right - keyW - 40), {
    x: M.left + 17, y: ky, size: 8.5, font: pen.text, color: BRAND.inkDim,
  })
}

interface Placed { card: SnapshotCard; at: Frame; view: NormBox }

/** Where a window `size` long starts on a sheet one long: on it if it can be, centred if not. */
const placeOn = (centre: number, size: number) =>
  size >= 1 ? (1 - size) / 2 : Math.min(Math.max(centre - size / 2, 0), 1 - size)

/** The window a card shows when its picture is `w` by `h` points: its own scale, more drawing around it. */
function widen(card: SnapshotCard, w: number, h: number): NormBox {
  const wn = w / card.zoom / card.sheetWidth
  const hn = h / card.zoom / card.sheetHeight
  const x0 = placeOn(card.focus.x, wn)
  const y0 = placeOn(card.focus.y, hn)
  return { x0, y0, x1: x0 + wn, y1: y0 + hn }
}

/**
 * Break the pictures into rows the way a paragraph is broken into lines.
 * Every row is stretched to the measure, so the breaks are chosen to stretch
 * the rows evenly, and to keep pictures of a height together, rather than
 * fill each row greedily and leave one picture alone on the last.
 */
function breakRows(cards: readonly SnapshotCard[], measure: number): SnapshotCard[][] {
  const n = cards.length
  const best = new Array<number>(n + 1).fill(Infinity)
  const from = new Array<number>(n + 1).fill(0)
  best[0] = 0
  for (let j = 1; j <= n; j++) {
    let width = -GUTTER_X
    let tallest = 0
    for (let i = j - 1; i >= 0; i--) {
      width += GUTTER_X + cards[i]!.width
      if (width > measure + 0.5 && i < j - 1) break
      tallest = Math.max(tallest, cards[i]!.height)
      let mismatch = 0
      for (let k = i; k < j; k++) mismatch += (1 - cards[k]!.height / tallest) ** 2
      const stretch = measure / Math.max(width, 1) - 1
      const cost = best[i]! + stretch * stretch + 0.5 * mismatch
      if (cost < best[j]!) {
        best[j] = cost
        from[j] = i
      }
    }
  }
  const rows: SnapshotCard[][] = []
  for (let j = n; j > 0; j = from[j]!) rows.unshift(cards.slice(from[j]!, j))
  return rows
}

/**
 * Rows in print order, then rows onto pages, then every row stretched to the
 * full measure and, on every page but the last, the rows stretched to the
 * full page. A picture is never rescaled to fill its place; its window on the
 * sheet grows instead, so the grid is even and the scale stays the scale.
 */
function layout(cards: readonly SnapshotCard[]): Placed[][] {
  const measure = PAGE.w - M.left - M.right
  const rows = breakRows(cards, measure)

  const depth = TOP - BOTTOM
  const pages: SnapshotCard[][][] = []
  let onPage: SnapshotCard[][] = []
  let usedH = 0
  for (const r of rows) {
    const need = Math.max(...r.map((c) => c.height)) + CAPTION
    if (onPage.length > 0 && usedH + GUTTER_Y + need > depth + 0.5) {
      pages.push(onPage)
      onPage = []
      usedH = 0
    }
    usedH += (onPage.length > 0 ? GUTTER_Y : 0) + need
    onPage.push(r)
  }
  if (onPage.length > 0) pages.push(onPage)

  return pages.map((rs, i) => {
    const natural = rs.map((r) => Math.max(...r.map((c) => c.height)))
    const total = natural.reduce((a, b) => a + b, 0)
    const spare = depth - total - rs.length * CAPTION - (rs.length - 1) * GUTTER_Y
    const last = i === pages.length - 1
    const placed: Placed[] = []
    let top = TOP
    rs.forEach((r, k) => {
      const h = last ? natural[k]! : natural[k]! + spare * (natural[k]! / total)
      const widths = r.map((c) => c.width)
      const sum = widths.reduce((a, b) => a + b, 0)
      const extra = measure - sum - (r.length - 1) * GUTTER_X
      let x = M.left
      r.forEach((c, j) => {
        const w = widths[j]! + extra * (widths[j]! / sum)
        placed.push({ card: c, at: { x, y: top - h, w, h }, view: widen(c, w, h) })
        x += w + GUTTER_X
      })
      top -= h + CAPTION + GUTTER_Y
    })
    return placed
  })
}

/**
 * Carry every sheet the pictures need into `doc`, once. A drawing that will
 * not open leaves its pictures without the sheet, and a note says so.
 */
export async function embedDrawings(
  doc: PDFDocument,
  cards: readonly SnapshotCard[],
  drawings: ReadonlyMap<string, PDFDocument>,
  documentName?: (documentId: string) => string,
): Promise<SheetSet> {
  const notes: string[] = []
  const forms = new Map<string, Map<number, SheetForm>>()
  for (const documentId of new Set(cards.map((c) => c.documentId))) {
    const source = drawings.get(documentId)
    const name = documentName?.(documentId) ?? documentId
    if (source === undefined) {
      notes.push(`${name}: the drawing could not be read, so its snapshots show the takeoff without the sheet.`)
      continue
    }
    try {
      const indexes = cards.filter((c) => c.documentId === documentId).map((c) => c.pageIndex)
      forms.set(documentId, await embedSheets(doc, source, indexes))
    } catch (err) {
      notes.push(`${name}: ${err instanceof Error ? err.message : String(err)}; its snapshots show the takeoff without the sheet.`)
    }
  }
  return { forms, notes }
}

/** A sheet for a picture: its form, cut to the window, named on the page. */
async function sheetFor(
  doc: PDFDocument, page: PDFPage, names: Map<PDFRef, PDFName>, sheets: SheetSet, card: SnapshotCard, view: NormBox,
): Promise<{ form: SheetForm; name: PDFName } | null> {
  const form = sheets.forms.get(card.documentId)?.get(card.pageIndex)
  if (form === undefined) return null
  // Only the part of the sheet this picture shows, so a page of pictures
  // does not cost a viewer a page of whole sheets.
  const ref = await windowForm(doc, form, view)
  let n = names.get(ref)
  if (n === undefined) {
    n = page.node.newXObject('Sheet', ref)
    names.set(ref, n)
  }
  return { form, name: n }
}

/** Push a hand-built content stream onto a page, in slices: a ceiling of panels is more operators than one call may take. */
function commit(page: PDFPage, ink: Ink): void {
  for (let k = 0; k < ink.ops.length; k += 4000) page.pushOperators(...ink.ops.slice(k, k + 4000))
}

/**
 * Add the snapshot pages to `doc`, a section per scope. Returns the pages
 * each scope's section took, for the contents.
 */
export async function addSnapshotPages(
  doc: PDFDocument, fonts: Fonts, input: SnapshotInput, sheets: SheetSet,
): Promise<{ pages: PDFPage[]; sections: Map<string, PDFPage[]> }> {
  const pages: PDFPage[] = []
  const sections = new Map<string, PDFPage[]>()
  const cards = input.section.cards
  for (const scope of input.scopes) {
    const mine = cards.filter((c) => c.scopeId === scope.id)
    if (mine.length === 0) continue
    const color = hex(scope.color)
    const section: PDFPage[] = []
    for (const [i, placed] of layout(mine).entries()) {
      const page = doc.addPage([PAGE.w, PAGE.h])
      const pen = { page, ...fonts }
      header(pen, scope, mine, i > 0)
      const gs = statesFor(doc, page)
      const names = new Map<PDFRef, PDFName>()
      const ink = new Ink()
      for (const { card, at, view } of placed) {
        drawCard(ink, card, at, view, color, await sheetFor(doc, page, names, sheets, card, view), gs)
      }
      commit(page, ink)
      for (const { card, at } of placed) caption(pen, card, at, color)
      pages.push(page)
      section.push(page)
    }
    sections.set(scope.id, section)
  }
  return { pages, sections }
}

/** The sheet the key plan shows, and the part of it the takeoff covers. */
export interface KeyPlanSubject {
  cards: SnapshotCard[]
  /** The takeoff on that sheet, with room around it, normalized. */
  bounds: NormBox
  /** Width over height of `bounds` on paper, so a page can be laid out around it. */
  aspect: number
  /** How many other sheets the snapshots draw from. */
  others: number
}

/** The least of a sheet the key plan shows, as a fraction of each side. */
const KEY_PLAN_MIN = 0.4

/** A span grown about its middle to at least `min`, kept on the sheet where it can be. */
function atLeast(lo: number, hi: number, min: number): [number, number] {
  const need = min - (hi - lo)
  if (need <= 0) return [lo, hi]
  let a = lo - need / 2, b = hi + need / 2
  if (a < 0) { b = Math.min(1, b - a); a = 0 }
  if (b > 1) { a = Math.max(0, a - (b - 1)); b = 1 }
  return [a, b]
}

/** The sheet that carries the most takeoff, and where on it the takeoff is. */
export function keyPlanSubject(cards: readonly SnapshotCard[]): KeyPlanSubject | null {
  const bySheet = new Map<string, SnapshotCard[]>()
  for (const c of cards) {
    const key = `${c.documentId}#${c.pageIndex}`
    bySheet.set(key, [...(bySheet.get(key) ?? []), c])
  }
  const weight = (list: SnapshotCard[]) =>
    list.reduce((n, c) => n + 1 + (c.quantity?.unit === 'SF' ? c.quantity.value / 1000 : 0), 0)
  const best = [...bySheet.values()].sort((a, b) => weight(b) - weight(a))[0]
  if (best === undefined) return null
  const first = best[0]!

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const take = (p: NormPoint) => {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
  }
  for (const c of best) {
    for (const r of c.region) r.forEach(take)
    for (const l of c.lines) l.forEach(take)
    c.points.forEach(take)
  }
  if (!(x1 > x0) || !(y1 > y0)) {
    for (const c of best) {
      take({ x: c.window.x0, y: c.window.y0 })
      take({ x: c.window.x1, y: c.window.y1 })
    }
  }
  // Room around the takeoff, so its edge is not the picture's edge, and
  // never less than a good part of the sheet: a key plan answers "where",
  // and one small room filling the frame does not.
  const pad = Math.max((x1 - x0) * first.sheetWidth, (y1 - y0) * first.sheetHeight) * 0.06
  const [bx0, bx1] = atLeast(x0 - pad / first.sheetWidth, x1 + pad / first.sheetWidth, KEY_PLAN_MIN)
  const [by0, by1] = atLeast(y0 - pad / first.sheetHeight, y1 + pad / first.sheetHeight, KEY_PLAN_MIN)
  const bounds = { x0: bx0, y0: by0, x1: bx1, y1: by1 }
  const aspect = ((bounds.x1 - bounds.x0) * first.sheetWidth) / ((bounds.y1 - bounds.y0) * first.sheetHeight)
  return { cards: best, bounds, aspect, others: bySheet.size - 1 }
}

/**
 * The key plan: the subject's sheet, dimmed, with every scope's takeoff on it
 * in its colour, the takeoff fitted to `at` and the drawing filling the rest
 * of it. A key plan answers "where", so it is drawn as large as its place
 * allows rather than at a standard scale; its scale bar says how large.
 */
export async function drawKeyPlan(
  doc: PDFDocument, page: PDFPage, sheets: SheetSet, subject: KeyPlanSubject,
  colorOf: (scopeId: string) => string | undefined, at: Frame,
): Promise<{ sheetLabel: string; pointsPerFoot: number | null }> {
  const first = subject.cards[0]!
  const { bounds } = subject
  const zoom = Math.min(
    at.w / ((bounds.x1 - bounds.x0) * first.sheetWidth),
    at.h / ((bounds.y1 - bounds.y0) * first.sheetHeight),
  )
  const view = widen({ ...first, zoom, focus: { x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2 } }, at.w, at.h)
  const scaled = subject.cards.find((c) => c.scale !== null)
  const pointsPerFoot = scaled?.scale != null ? zoom * (scaled.scale.pointsPerFoot / scaled.zoom) : null

  const gs = statesFor(doc, page)
  const names = new Map<PDFRef, PDFName>()
  const ink = new Ink()
  paintSheet(ink, at, view, await sheetFor(doc, page, names, sheets, first, view), gs)
  const fx = first.sheetWidth * zoom
  const fy = first.sheetHeight * zoom
  const X = (p: NormPoint) => at.x + (p.x - view.x0) * fx
  const Y = (p: NormPoint) => at.y + at.h - (p.y - view.y0) * fy
  ink.save().rect(at.x, at.y, at.w, at.h).clip()
  for (const c of subject.cards) {
    const color = hex(colorOf(c.scopeId) ?? '#888888')
    if (c.region.length > 0) {
      ink.save().state(gs.plan).fillColor(color)
      for (const r of c.region) r.forEach((p, i) => (i === 0 ? ink.move(X(p), Y(p)) : ink.line(X(p), Y(p))))
      ink.fillEvenOdd().restore()
    }
    if (c.lines.length > 0) {
      for (const [col, wd] of [[PAPER, 3.4], [color, 1.8]] as const) {
        ink.save().round().strokeColor(col).width(wd)
        for (const l of c.lines) l.forEach((p, i) => (i === 0 ? ink.move(X(p), Y(p)) : ink.line(X(p), Y(p))))
        ink.stroke().restore()
      }
    }
    if (c.points.length > 0) {
      ink.save().fillColor(color)
      for (const p of c.points) circle(ink, X(p), Y(p), 2)
      ink.fill().restore()
    }
  }
  ink.restore()
  frameLine(ink, at)
  commit(page, ink)
  return { sheetLabel: first.sheetLabel, pointsPerFoot }
}

/** A scale bar: half solid, half open, and its length in feet. Returns where it ends. */
export function scaleBar(pen: Pen, x: number, y: number, pointsPerFoot: number, color: RGB = BRAND.inkDim): number {
  const feet = scaleBarFeet(pointsPerFoot)
  const len = feet * pointsPerFoot
  pen.page.drawRectangle({ x, y: y + 1, width: len / 2, height: 3, color })
  pen.page.drawRectangle({ x: x + len / 2, y: y + 1, width: len / 2, height: 3, borderColor: color, borderWidth: 0.6 })
  const label = `${feet}'`
  pen.page.drawText(label, { x: x + len + 4, y, size: 7, font: pen.text, color: BRAND.inkFaint })
  return x + len + 4 + pen.text.widthOfTextAtSize(label, 7)
}
