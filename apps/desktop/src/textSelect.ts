/**
 * Selecting the sheet's text with a box, and copying it as it reads.
 *
 * A drawing's text is not in reading order: CAD writes notes, tags and title
 * block in whatever order the layers were plotted, so a selection from one
 * character to another (the way a document viewer does it) jumps across the
 * sheet. A box is what an estimator means: "this note block", "this schedule".
 * The words inside it are laid back out into lines, top to bottom and left to
 * right, which is the order a person reads them in.
 */

import type { NormBox, TextRun } from '@redbeam/viewer'

/** A selected word: its box and its text. */
export interface PickedWord extends NormBox { text: string }

/** The words whose centre falls inside the box (normalized, corners in any order). */
export function wordsInBox(text: string, runs: readonly TextRun[], box: NormBox): PickedWord[] {
  const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1)
  const y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1)
  const out: PickedWord[] = []
  for (const r of runs) {
    const cx = (r.x0 + r.x1) / 2
    const cy = (r.y0 + r.y1) / 2
    if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue
    const t = text.slice(r.start, r.start + r.length)
    if (t.trim() === '') continue
    out.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, text: t })
  }
  return out
}

/**
 * The words as text: one line per visual row, rows top to bottom, words left
 * to right with a space between.
 *
 * Two words share a row when their vertical spans overlap by at least half the
 * shorter one, so a superscript or a slightly lower word stays on its line but
 * two lines of a note do not merge.
 */
export function wordsAsText(words: readonly PickedWord[]): string {
  const sorted = [...words].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))
  const rows: PickedWord[][] = []
  for (const w of sorted) {
    const row = rows.find((r) => r.some((o) => sameRow(o, w)))
    if (row) row.push(w)
    else rows.push([w])
  }
  return rows
    .map((r) => r.sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(' '))
    .join('\n')
}

function sameRow(a: NormBox, b: NormBox): boolean {
  const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  const shorter = Math.min(a.y1 - a.y0, b.y1 - b.y0)
  return shorter > 0 && overlap >= shorter / 2
}
