/**
 * Where on the sheet a piece of text is, for an agent.
 *
 * Full-text search says WHICH sheets mention "C-7". An agent that has to look
 * at the tag also needs to know WHERE it is, so it can zoom to it or render a
 * close-up of it. The positions are not stored: PDFium already gives every
 * word's box when a page's text is read (the same boxes Select text and the
 * search highlight use), so they are read on demand and cost nothing on disk.
 *
 * Pure: everything arrives as arguments, so it is tested without a viewer.
 */
import type { NormBox, TextRun } from '@redbeam/viewer'

export interface TextMatch {
  /** The words the match falls in, as they read on the sheet. */
  text: string
  /** Normalized [0,1] page box around the match, y down. */
  box: NormBox
  /** The box's centre, the point to aim at. */
  center: { x: number; y: number }
}

export interface FindOptions {
  caseSensitive?: boolean
  /** Only matches that are a whole word: "C-7" but not "C-70". */
  wholeWord?: boolean
  /** Stop after this many on the page. */
  limit?: number
  /** Pass over this many matches first: where the last answer left off on this page. */
  skip?: number
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c)

/**
 * Every occurrence of `query` in one page's text, with its box.
 *
 * Linear in the page: a one-letter query on a sheet of forty thousand words
 * has tens of thousands of matches, and looking through every run for each
 * of them froze the window. Matches come in text order and so do the runs,
 * so one cursor walks the runs alongside.
 */
export function findInPageText(
  page: { text: string; runs: readonly TextRun[] },
  query: string,
  opts: FindOptions = {},
): TextMatch[] {
  const q = query.trim()
  if (q === '' || page.text === '') return []
  const fold = opts.caseSensitive !== true
  // Lower-casing can change a string's length outside ASCII, which would
  // throw every run offset off. Fold only when it is length-preserving.
  const hay0 = fold ? page.text.toLowerCase() : page.text
  const needle0 = fold ? q.toLowerCase() : q
  const safe = hay0.length === page.text.length && needle0.length === q.length
  const hay = safe ? hay0 : page.text
  const needle = safe ? needle0 : q
  const limit = opts.limit ?? 500
  let skip = Math.max(0, opts.skip ?? 0)
  const out: TextMatch[] = []
  const runs = inTextOrder(page.runs)

  let from = 0
  let first = 0
  while (out.length < limit) {
    const at = hay.indexOf(needle, from)
    if (at < 0) break
    from = at + Math.max(1, needle.length)
    const end = at + needle.length
    if (opts.wholeWord === true && (isWordChar(page.text[at - 1]) || isWordChar(page.text[end]))) continue
    // Runs that end before this match end before every later one too.
    while (first < runs.length && runs[first]!.start + runs[first]!.length <= at) first++
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    const words: string[] = []
    for (let i = first; i < runs.length && runs[i]!.start < end; i++) {
      const r = runs[i]!
      if (r.start + r.length <= at) continue
      x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1)
      words.push(page.text.slice(r.start, r.start + r.length))
    }
    if (words.length === 0) continue
    if (skip > 0) { skip--; continue }
    out.push({
      text: words.join(' ').trim(),
      box: roundBox({ x0, y0, x1, y1 }),
      center: { x: round((x0 + x1) / 2), y: round((y0 + y1) / 2) },
    })
  }
  return out
}

/** The runs by where they start in the text. They nearly always are already. */
function inTextOrder(runs: readonly TextRun[]): readonly TextRun[] {
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.start < runs[i - 1]!.start) return [...runs].sort((a, b) => a.start - b.start)
  }
  return runs
}

/** The words on a page, optionally only those whose centre is in `within`. */
export function wordsOnPage(
  page: { text: string; runs: readonly TextRun[] },
  within?: NormBox,
): Array<{ text: string; box: NormBox }> {
  const bx = within === undefined ? null : {
    x0: Math.min(within.x0, within.x1), x1: Math.max(within.x0, within.x1),
    y0: Math.min(within.y0, within.y1), y1: Math.max(within.y0, within.y1),
  }
  const out: Array<{ text: string; box: NormBox }> = []
  for (const r of page.runs) {
    const t = page.text.slice(r.start, r.start + r.length).trim()
    if (t === '') continue
    if (bx !== null) {
      const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2
      if (cx < bx.x0 || cx > bx.x1 || cy < bx.y0 || cy > bx.y1) continue
    }
    out.push({ text: t, box: roundBox(r) })
  }
  return out
}

/** Five decimals: about a hundredth of a point on an E-size sheet. */
function round(n: number): number { return Math.round(n * 1e5) / 1e5 }
function roundBox(b: NormBox): NormBox {
  return { x0: round(b.x0), y0: round(b.y0), x1: round(b.x1), y1: round(b.y1) }
}

/** A sheet code reduced to what identifies it: "A.4.0", "A4.0" and "a-4-0" are one sheet. */
export function sheetKey(code: string): string {
  return code.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * The page a sheet code names, from the sheet index. Exact first, then with
 * punctuation and case ignored. Null when no sheet or more than one matches.
 */
export function pageForSheet(rows: ReadonlyArray<{ page: number; number: string }>, code: string): number | null {
  const exact = rows.filter((r) => r.number === code.trim())
  if (exact.length === 1) return exact[0]!.page
  const k = sheetKey(code)
  if (k === '') return null
  const loose = rows.filter((r) => sheetKey(r.number) === k)
  return loose.length === 1 ? loose[0]!.page : null
}
