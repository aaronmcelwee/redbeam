/**
 * "Link detail callouts": find every reference to another sheet on every
 * sheet, and offer each as a link (Kenneth, 2026-11-26, item 12).
 *
 * A detail bubble is a detail number over a sheet number ("3" over "A5.01"),
 * sometimes written on one line as "3/A5.01". A section mark, an elevation
 * tag and the drawing list on the cover carry the same sheet numbers. Any word
 * that IS another sheet's number is a candidate; one with a detail number
 * just above, below or before it is a callout, which is what Kenneth asked
 * for, and is ticked. A bare mention of a distinctive number (A5.01, A-501)
 * is ticked too; a short one that could be a room or a grid (A101, E2) waits
 * for a tick. Nothing is written until the person approves the list.
 *
 * Pure: words in, candidates out. Geometry is normalized, y down.
 */
import { sheetKey } from './links.js'

export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface Word extends Box { text: string }

export interface Candidate {
  /** Sheet the link goes on. */
  page: number
  /** Sheet it jumps to. */
  toPage: number
  /** Where the link sits: the sheet number, with its detail number, a little padded. */
  rect: Box
  /** As written: "3/A5.01", or "A5.01". */
  text: string
  /** The detail number, when one was found beside the sheet number. */
  detail: string | null
  kind: 'callout' | 'mention'
  /** Ticked in the review list to begin with. */
  checked: boolean
}

/** A detail number or letter in a bubble: 3, 12, A, 3A. */
const DETAIL = /^[A-Z]?\d{1,3}[A-Z]?$|^[A-Z]$/

/** True when a sheet number is unlikely to be anything else: it has a stop, a dash or two letters. */
export function distinctive(number: string): boolean {
  return /[.\-]/.test(number) || /^[A-Z]{2,}/.test(sheetKey(number))
}

const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
const union = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) })

/** The detail number beside a sheet number: just above, below or before it, about its size. */
function detailFor(w: Word, words: readonly Word[]): Word | null {
  const h = w.y1 - w.y0
  const cx = (w.x0 + w.x1) / 2
  const width = Math.max(w.x1 - w.x0, h)
  let best: Word | null = null
  let bestD = Infinity
  for (const o of words) {
    if (o === w || !DETAIL.test(o.text)) continue
    const oh = o.y1 - o.y0
    if (!(oh > h * 0.5 && oh < h * 2.5)) continue
    const ocx = (o.x0 + o.x1) / 2, ocy = (o.y0 + o.y1) / 2
    // Stacked: centred over or under it, within two and a half lines.
    const stacked = Math.abs(ocx - cx) < width * 0.75 && Math.abs(ocy - (w.y0 + w.y1) / 2) < h * 2.5
    // Side by side: on its line, just before it.
    const before = Math.abs(ocy - (w.y0 + w.y1) / 2) < h * 0.6 && o.x1 <= w.x0 + h * 0.2 && w.x0 - o.x1 < h * 1.5
    if (!stacked && !before) continue
    const d = Math.hypot(ocx - cx, ocy - (w.y0 + w.y1) / 2)
    if (d < bestD) { best = o; bestD = d }
  }
  return best
}

/**
 * Candidates on one sheet.
 *
 * `sheets` is the set's sheet index; numbers the index only guessed ("Page
 * 40") are left out, and so is a number two sheets share, which says
 * nothing about where to go. `existing` is the boxes of links already on the
 * sheet, the PDF's own and REDBEAM's: a reference already linked is skipped.
 */
export function findCallouts(
  page: number,
  words: readonly Word[],
  sheets: ReadonlyArray<{ page: number; number: string }>,
  existing: readonly Box[] = [],
): Candidate[] {
  const byKey = new Map<string, number | null>()
  for (const s of sheets) {
    const k = sheetKey(s.number)
    if (k === '' || /^PAGE\d+$/.test(k)) continue
    byKey.set(k, byKey.has(k) ? null : s.page)
  }
  const out: Candidate[] = []
  for (const w of words) {
    const parts = w.text.split('/')
    const numberPart = parts[parts.length - 1] ?? ''
    const toPage = byKey.get(sheetKey(numberPart))
    if (toPage === undefined || toPage === null || toPage === page) continue
    const inline = parts.length === 2 && DETAIL.test(sheetKey(parts[0]!)) ? sheetKey(parts[0]!) : null
    const beside = inline === null ? detailFor(w, words) : null
    const detail = inline ?? beside?.text ?? null
    const h = w.y1 - w.y0
    const core = beside === null ? { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 } : union(w, beside)
    const pad = h * 0.25
    const rect = { x0: Math.max(0, core.x0 - pad), y0: Math.max(0, core.y0 - pad), x1: Math.min(1, core.x1 + pad), y1: Math.min(1, core.y1 + pad) }
    if (existing.some((e) => overlaps(e, { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }))) continue
    if (out.some((c) => c.toPage === toPage && overlaps(c.rect, rect))) continue
    const kind = detail === null ? 'mention' : 'callout'
    out.push({
      page, toPage, rect,
      text: detail === null ? numberPart : `${detail}/${numberPart}`,
      detail, kind,
      checked: kind === 'callout' || distinctive(numberPart),
    })
  }
  return out
}
