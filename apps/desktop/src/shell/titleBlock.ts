/**
 * Sheet names read from two boxes on the title block.
 *
 * The automatic reading (`sheetFromText`) guesses where the sheet number is.
 * On a set whose title block prints a contract number in the same style as a
 * sheet number, it guesses wrong on every sheet: the Newark AirTrain set read
 * "EWR-154.945 NEWARK LIBERTY" on most of its 264 pages and "Page N" on the
 * rest (Aaron, 2026-11-25). The estimator knows where the number is. So they
 * draw one box around it and one around the title, once, and every sheet is
 * read in the same two places.
 *
 * The boxes are normalized to the sheet as displayed, the same space PDFium's
 * word boxes are in, so a set whose sheets share a title block reads the same
 * spot on every sheet whatever its size in points.
 *
 * Pure: the words arrive as arguments, so it is tested without a viewer.
 */
import type { NormBox, TextRun } from '@redbeam/viewer'

export interface TitleBlockRegions {
  /** Around the drawing (sheet) number. */
  number: NormBox
  /** Around the drawing title. Null when the estimator only wanted numbers. */
  title: NormBox | null
}

export interface ReadName {
  number: string
  title: string
}

/** The redbeam_meta key holding the boxes. Travels in the PDF with the takeoff. */
export const TITLE_REGIONS_KEY = 'sheet_name_regions'
/** The redbeam_meta key holding each page's label as written into /PageLabels. */
export const SHEET_LABELS_KEY = 'sheet_labels'
/**
 * The redbeam_meta key holding names set one sheet at a time (by an agent
 * that read the sheet, or by hand): page index to name. They beat the boxes.
 */
export const SHEET_OVERRIDES_KEY = 'sheet_name_overrides'

function ordered(b: NormBox): NormBox {
  return {
    x0: Math.min(b.x0, b.x1), x1: Math.max(b.x0, b.x1),
    y0: Math.min(b.y0, b.y1), y1: Math.max(b.y0, b.y1),
  }
}

/**
 * The words whose centre is inside `box`, as they read: top line first, each
 * line left to right, joined by single spaces.
 *
 * Text order is the order the drawing program wrote the words, which is not
 * reading order on a title block (the Newark set writes the title's lines
 * after the stamp beside them), so the lines are rebuilt from the boxes.
 */
export function textInBox(page: { text: string; runs: readonly TextRun[] }, box: NormBox, opts: { wrapped?: boolean } = {}): string {
  const b = ordered(box)
  const words: Array<{ t: string; cx: number; cy: number; h: number }> = []
  const outside: typeof words = []
  for (const r of page.runs) {
    const t = page.text.slice(r.start, r.start + r.length).trim()
    if (t === '') continue
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2
    const w = { t, cx, cy, h: Math.abs(r.y1 - r.y0) }
    if (cx < b.x0 || cx > b.x1 || cy < b.y0 || cy > b.y1) outside.push(w)
    else words.push(w)
  }
  if (words.length === 0) return ''
  /*
   * A title that wraps: the next line, in the same lettering, just above or
   * below the box, belongs to it (Coinbase blind test, 2026-11-27: a box
   * drawn round "REFLECTED CEILING" left "PLAN - FLOOR 7" outside). Taken
   * one line at a time while each is within a line and a half of the last.
   */
  if (opts.wrapped === true) {
    const h = words.reduce((n, w) => n + w.h, 0) / words.length
    const like = outside.filter((w) => w.cx >= b.x0 && w.cx <= b.x1 && w.h >= 0.7 * h && w.h <= 1.4 * h)
    for (let grew = true; grew;) {
      grew = false
      const top = Math.min(...words.map((w) => w.cy)), bottom = Math.max(...words.map((w) => w.cy))
      for (let i = like.length - 1; i >= 0; i--) {
        const w = like[i]!
        const gap = w.cy > bottom ? w.cy - bottom : w.cy < top ? top - w.cy : 0
        if (gap > 0.4 * h && gap <= 1.5 * h) { words.push(w); like.splice(i, 1); grew = true }
      }
    }
  }
  words.sort((a, c) => a.cy - c.cy)
  const lines: Array<typeof words> = []
  for (const w of words) {
    const line = lines[lines.length - 1]
    const last = line?.[line.length - 1]
    // Same line when the centres are within half a word's height.
    if (line !== undefined && last !== undefined && Math.abs(w.cy - last.cy) <= Math.max(w.h, last.h) * 0.5) line.push(w)
    else lines.push([w])
  }
  return lines
    .map((l) => l.sort((a, c) => a.cx - c.cx).map((w) => w.t).join(' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A field's printed label, when the box took it in with the value. */
const NUMBER_LABEL = /^(?:(?:DRAWING|DWG|SHEET)\.?\s*(?:NO|NUMBER|NUM|#)\.?|NO\.|NUMBER)\s*:?\s*/i
const TITLE_LABEL = /^(?:(?:(?:DRAWING|DWG|SHEET)\.?\s*)?(?:TITLE|NAME)|DESCRIPTION)\s*:?\s*/i

/** What the two boxes say on one sheet, or null when the number box is empty. */
export function readSheetName(
  page: { text: string; runs: readonly TextRun[] },
  regions: TitleBlockRegions,
): ReadName | null {
  const number = textInBox(page, regions.number).replace(NUMBER_LABEL, '').trim()
  if (number === '') return null
  const title = regions.title === null ? '' : textInBox(page, regions.title, { wrapped: true }).replace(TITLE_LABEL, '').trim()
  return { number, title }
}

/** The page label written into the PDF, which Bluebeam shows as the page's name. */
export function labelOf(name: ReadName): string {
  return name.title === '' ? name.number : `${name.number} - ${name.title}`
}

/**
 * Each page's label for /PageLabels: what the boxes read, else the file's own
 * label, else null (written as the page's number). Null overall when the boxes
 * read nothing anywhere, so a file is never relabelled with only its old labels.
 */
export function labelsToWrite(
  pageCount: number,
  named: ReadonlyArray<ReadName | null>,
  own: ReadonlyArray<string | null>,
): Array<string | null> | null {
  if (!named.some((n) => n !== null && n !== undefined)) return null
  const out: Array<string | null> = []
  for (let i = 0; i < pageCount; i++) {
    const n = named[i] ?? null
    const o = own[i] ?? null
    out.push(n !== null ? labelOf(n) : (o !== null && o.trim() !== '' ? o : null))
  }
  return out
}

function isBox(v: unknown): v is NormBox {
  if (typeof v !== 'object' || v === null) return false
  const b = v as Record<string, unknown>
  return ['x0', 'y0', 'x1', 'y1'].every((k) => typeof b[k] === 'number' && Number.isFinite(b[k]) && (b[k] as number) >= 0 && (b[k] as number) <= 1)
}

/** The stored boxes, or null for none or anything unreadable. */
export function parseRegions(json: string | null | undefined): TitleBlockRegions | null {
  if (json === null || json === undefined || json === '') return null
  try {
    const v = JSON.parse(json) as unknown
    if (typeof v !== 'object' || v === null) return null
    const r = v as Record<string, unknown>
    if (!isBox(r['number'])) return null
    return { number: ordered(r['number']), title: isBox(r['title']) ? ordered(r['title']) : null }
  } catch {
    return null
  }
}

/** A box too small to have been meant: a click, not a drag. */
export function isTinyBox(b: NormBox): boolean {
  return Math.abs(b.x1 - b.x0) < 0.002 || Math.abs(b.y1 - b.y0) < 0.002
}

/** Names set one sheet at a time, by page index. Anything unreadable is left out. */
export function parseOverrides(json: string | null | undefined): Map<number, ReadName> {
  const out = new Map<number, ReadName>()
  if (json === null || json === undefined || json === '') return out
  try {
    const v = JSON.parse(json) as unknown
    if (typeof v !== 'object' || v === null) return out
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      const page = Number(k)
      if (!Number.isInteger(page) || page < 0 || typeof n !== 'object' || n === null) continue
      const { number, title } = n as Record<string, unknown>
      if (typeof number !== 'string' || number.trim() === '') continue
      out.set(page, { number: number.trim(), title: typeof title === 'string' ? title.trim() : '' })
    }
  } catch { /* none */ }
  return out
}

/** Each page's name: one set for that sheet, else what the boxes read. */
export function mergeNames(
  pageCount: number,
  read: ReadonlyArray<ReadName | null>,
  overrides: ReadonlyMap<number, ReadName>,
): Array<ReadName | null> {
  const out: Array<ReadName | null> = []
  for (let i = 0; i < pageCount; i++) out.push(overrides.get(i) ?? read[i] ?? null)
  return out
}

/**
 * Whether the file's bookmarks already list every sheet name, each pointing at
 * its page. A file named before names became bookmarks (0.3.84 to 0.3.89) has
 * only the page labels, and is saved once more to add them.
 */
export function bookmarksHaveLabels(
  outline: ReadonlyArray<{ title: string; page: number | null; children: ReadonlyArray<unknown> }>,
  labels: ReadonlyArray<string | null>,
): boolean {
  const seen = new Set<string>()
  const walk = (nodes: ReadonlyArray<{ title: string; page: number | null; children: ReadonlyArray<unknown> }>): void => {
    for (const n of nodes) {
      seen.add(`${n.page}|${n.title.trim()}`)
      walk(n.children as typeof nodes)
    }
  }
  walk(outline)
  return labels.every((l, i) => l === null || l.trim() === '' || seen.has(`${i}|${l.trim()}`))
}
