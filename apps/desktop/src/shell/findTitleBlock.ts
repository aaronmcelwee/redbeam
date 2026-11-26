/**
 * Find a set's title block on its own: where the sheet number sits, and
 * where its title sits, read from the positions of the words across sheets.
 *
 * NOIC Interior Fit-Up, 2026-11-26: the automatic reading (sheetFromText)
 * left about 150 of 171 sheets unnamed and named others after a tag on the
 * drawing: "CL201", "D6A", "C114", "PT210", "FSC-45G". It reads the text in
 * the order it was written, and a ceiling tag on its own line, followed by a
 * line in capitals, looks exactly like a sheet number followed by its name.
 *
 * What a tag does not do is sit in the same place on sheet after sheet with
 * a different value each time. A sheet number does: the title block is the
 * same block on every sheet of a set. So:
 *
 *  1. On every sheet read, every word shaped like a sheet code is placed in
 *     a coarse grid cell by its centre.
 *  2. The NUMBER box is where a code appears on the most sheets, with a
 *     different code on most of them. A tag lands in a different cell on
 *     each sheet; a project number or a revision letter is the same code
 *     every time; the sheet number is neither.
 *  3. The TITLE box is the words near it that change from sheet to sheet and
 *     read as words. What is printed the same on most sheets (the firm, the
 *     project, "DRAWING TITLE") is the block's furniture and is left out.
 *
 * Nothing is found, rather than a guess, when no cell clears the bar: an
 * honest "Page 14" beats a wrong name (see sheetFromText). The boxes found
 * are handed to readSheetName, the same reader the boxes a person draws use,
 * and redbeam_list_sheets reports them so an agent can check and keep them.
 */
import type { NormBox, TextRun } from '@redbeam/viewer'
import type { TitleBlockRegions } from './titleBlock.js'

type Page = { text: string; runs: readonly TextRun[] }

/**
 * A word that could be a sheet number: "A101", "A-101", "A1.01", "ID-201",
 * "S2.1A", "E0.00", and the NOIC set's "IB4.LL1" and "IC8.0L1B", whose part
 * after the dot names a level in letters and figures.
 */
const CODE = /^[A-Z]{1,4}[-. ]?\d{1,4}(?:[-.](?=[0-9A-Z]*\d)[0-9A-Z]{1,5}){0,2}[A-Z]?$/
/** Shaped like a code but never a sheet: a revision mark, a grid line, a level. */
const NOT_A_SHEET = /^(?:R|REV|L|LVL|LEVEL|NO|N|S|E|W)[-. ]?\d{1,2}$/

/** Grid cell size, as a fraction of the page: about 0.9 in on an E-size sheet. */
const CELL = 0.025

export interface FoundTitleBlock {
  regions: TitleBlockRegions
  /** Sheets that have a code in the number box, of the sheets looked at. */
  sheets: number
  looked: number
}

interface Word { t: string; box: NormBox; cx: number; cy: number }

function words(page: Page): Word[] {
  const out: Word[] = []
  for (const r of page.runs) {
    const t = page.text.slice(r.start, r.start + r.length).trim()
    if (t === '') continue
    const box = { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) }
    out.push({ t, box, cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2 })
  }
  return out
}

/** The code a word holds, if it is one: a printed "NO." before it is dropped. */
export function codeOf(t: string): string | null {
  const s = t.toUpperCase().replace(/^(?:SHEET|DRAWING|DWG)?\.?\s*(?:NO|NUMBER|#)\.?\s*:?\s*/, '').trim()
  if (s.length < 2 || s.length > 12 || !CODE.test(s) || NOT_A_SHEET.test(s)) return null
  return s
}

const key = (cx: number, cy: number) => `${Math.floor(cx / CELL)},${Math.floor(cy / CELL)}`
const pad = (b: NormBox, by: number): NormBox => ({
  x0: Math.max(0, b.x0 - by), y0: Math.max(0, b.y0 - by), x1: Math.min(1, b.x1 + by), y1: Math.min(1, b.y1 + by),
})
const union = (a: NormBox | null, b: NormBox): NormBox => (a === null ? { ...b } : {
  x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
})

/** A run of words that reads as a sheet's name rather than a date, a scale or a number. */
function nameLike(t: string): boolean {
  if (!/[A-Za-z]{3}/.test(t)) return false
  if (codeOf(t) !== null) return false
  if (/^(?:SCALE|DATE|DRAWN|CHECKED|PROJECT|JOB|SHEET|DRAWING|DWG|REV|ISSUE|NO\.?|NORTH|KEY ?PLAN|SEAL|STAMP)\b/i.test(t)) return false
  if (/\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|\d+"\s*=|=\s*1'-0"/.test(t)) return false
  return true
}

/**
 * The number and title boxes of the set's title block, or null when the
 * sheets do not show one clearly. `pages` may be any sample of the set's
 * sheets (sparse pages are skipped); more sheets make a surer answer.
 */
export function findTitleBlock(pages: ReadonlyArray<Page | null | undefined>): FoundTitleBlock | null {
  const read = pages.filter((p): p is Page => p !== null && p !== undefined && p.runs.length > 0)
  const P = read.length
  if (P < 2) return null
  const pageWords = read.map(words)

  // 1. Every code-shaped word, by cell.
  const cells = new Map<string, { pages: Map<number, { code: string; box: NormBox }> }>()
  pageWords.forEach((ws, p) => {
    for (const w of ws) {
      const code = codeOf(w.t)
      if (code === null) continue
      const k = key(w.cx, w.cy)
      let c = cells.get(k)
      if (c === undefined) { c = { pages: new Map() }; cells.set(k, c) }
      // One per sheet per cell: the lowest-right one, as a title block's number usually is.
      const had = c.pages.get(p)
      if (had === undefined || w.cy + w.cx > (had.box.y0 + had.box.x0)) c.pages.set(p, { code, box: w.box })
    }
  })

  // 2. The cell (with its neighbours, for jitter) on the most sheets with the most different codes.
  let best: { score: number; sheets: number; box: NormBox; at: { x: number; y: number } } | null = null
  for (const k of cells.keys()) {
    const [ix, iy] = k.split(',').map(Number) as [number, number]
    const onPage = new Map<number, { code: string; box: NormBox }>()
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const c = cells.get(`${ix + dx},${iy + dy}`)
        if (c === undefined) continue
        for (const [p, v] of c.pages) if (!onPage.has(p)) onPage.set(p, v)
      }
    }
    const n = onPage.size
    const distinct = new Set([...onPage.values()].map((v) => v.code)).size
    if (n < Math.max(2, Math.ceil(P * 0.3))) continue
    // A project number or a fixed label repeats; a sheet number does not.
    if (distinct / n < 0.6) continue
    // Ties go to the lower right, where title blocks sit.
    const score = n * (distinct / n) + (ix + iy) * CELL * 0.01
    if (best === null || score > best.score) {
      let box: NormBox | null = null
      for (const v of onPage.values()) box = union(box, v.box)
      best = { score, sheets: n, box: box!, at: { x: ix, y: iy } }
    }
  }
  if (best === null) return null
  const number = pad(best.box, 0.004)

  // 3. Words near the number that change from sheet to sheet and read as a name.
  const near = (w: Word) => w.cx >= number.x0 - 0.3 && w.cx <= number.x1 + 0.12
    && w.cy >= number.y0 - 0.2 && w.cy <= number.y1 + 0.06
    && !(w.cx >= number.x0 && w.cx <= number.x1 && w.cy >= number.y0 && w.cy <= number.y1)
  // Furniture is the same words in the same place: "PLAN" ends half the titles of a set, each time somewhere else.
  const spot = (w: Word) => `${w.t.toUpperCase()}@${key(w.cx, w.cy)}`
  const seenOn = new Map<string, number>()
  for (const ws of pageWords) {
    for (const t of new Set(ws.filter(near).map(spot))) seenOn.set(t, (seenOn.get(t) ?? 0) + 1)
  }
  const furniture = (w: Word) => (seenOn.get(spot(w)) ?? 0) > Math.max(1, P * 0.7)
  const titleCells = new Map<string, { pages: Set<number>; box: NormBox | null }>()
  pageWords.forEach((ws, p) => {
    for (const w of ws) {
      if (!near(w) || furniture(w) || !nameLike(w.t)) continue
      const k = key(w.cx, w.cy)
      let c = titleCells.get(k)
      if (c === undefined) { c = { pages: new Set(), box: null }; titleCells.set(k, c) }
      c.pages.add(p)
      c.box = union(c.box, w.box)
    }
  })
  /*
   * The cells that clear the bar, gathered into touching clusters, and the
   * cluster nearest the number is the title. On a whole set the window round
   * the number also takes in the drawing's own changing words (room names,
   * finish tags), and a union of every cell made a box half the sheet wide
   * (NOIC Interior Fit-Up, 2026-11-26).
   */
  const bar = Math.max(2, Math.ceil(P * 0.3))
  const good = new Map<string, NormBox>()
  for (const [k, c] of titleCells) if (c.pages.size >= bar && c.box !== null) good.set(k, c.box)
  const seen = new Set<string>()
  let title: NormBox | null = null
  let nearest = Infinity
  for (const start of good.keys()) {
    if (seen.has(start)) continue
    let box: NormBox | null = null
    const todo = [start]
    seen.add(start)
    while (todo.length > 0) {
      const k = todo.pop()!
      box = union(box, good.get(k)!)
      const [ix, iy] = k.split(',').map(Number) as [number, number]
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const n = `${ix + dx},${iy + dy}`
          if (!seen.has(n) && good.has(n)) { seen.add(n); todo.push(n) }
        }
      }
    }
    const gap = Math.hypot(
      Math.max(0, box!.x0 - number.x1, number.x0 - box!.x1),
      Math.max(0, box!.y0 - number.y1, number.y0 - box!.y1),
    )
    if (gap < nearest) { nearest = gap; title = box }
  }
  /*
   * Then out along its lines: a long title's last word sits in a cell few
   * sheets reach ("REFLECTED CEILING PLAN" lost "PLAN", SLS 2026-11-26), so
   * any changing word on the box's lines, just past either end, widens it.
   */
  if (title !== null) {
    // Never far: a line of the drawing at the same height is not the title (NOIC, 2026-11-26).
    const core: NormBox = title
    const reach: NormBox = { x0: core.x0 - 0.06, y0: core.y0, x1: core.x1 + 0.06, y1: core.y1 }
    /*
     * Each sheet grows its own line from the core by its own words, a word's
     * gap at a time, and the box takes an end that two sheets reach: one
     * sheet's drawing label beside its title is that sheet's, not the block's.
     */
    const lefts: number[] = []
    const rights: number[] = []
    for (const ws of pageWords) {
      let t: NormBox = core
      for (let grew = true; grew;) {
        grew = false
        for (const w of ws) {
          if (!near(w) || furniture(w) || w.cy < core.y0 || w.cy > core.y1) continue
          if (w.box.x0 >= t.x0 && w.box.x1 <= t.x1) continue
          // A word's gap, not a column's: NOIC's legends sit six letters' height left of the title and are not it.
          const gap = Math.max(0.006, 2.5 * (w.box.y1 - w.box.y0))
          if (w.box.x0 > t.x1 + gap || w.box.x1 < t.x0 - gap) continue
          if (w.box.x0 < reach.x0 || w.box.x1 > reach.x1) continue
          // Never into the number box.
          if (w.cx >= number.x0 && w.cx <= number.x1 && w.cy >= number.y0 && w.cy <= number.y1) continue
          t = { ...union(t, w.box), y0: core.y0, y1: core.y1 }
          grew = true
        }
      }
      lefts.push(t.x0)
      rights.push(t.x1)
    }
    lefts.sort((a, b) => a - b)
    rights.sort((a, b) => b - a)
    const k = Math.min(1, lefts.length - 1)
    title = { x0: Math.min(core.x0, lefts[k]!), y0: core.y0, x1: Math.max(core.x1, rights[k]!), y1: core.y1 }
  }
  return {
    regions: { number, title: title === null ? null : pad(title, 0.003) },
    sheets: best.sheets,
    looked: P,
  }
}
