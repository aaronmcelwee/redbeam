/**
 * The scope pane follows the estimator (Aaron, 2026-11-19): "upon scope
 * creation, scope setup is prioritized. Once setup is confirmed, the UI shifts
 * and prioritizes what's next for takeoff. Once takeoff appears to be
 * complete, what's prioritized is the markups list."
 *
 * The stage is read off state the app already has. There is no signal that a
 * takeoff is finished, only that the estimator left takeoff mode, so Review
 * begins there.
 */
export type ScopeStage = 'setup' | 'takeoff' | 'review'

export function scopeStage(s: { takingOff: boolean; markups: number; missing: number }): ScopeStage {
  if (s.takingOff) return 'takeoff'
  if (s.missing > 0 || s.markups === 0) return 'setup'
  return 'review'
}

/** Which of the two folding sections stand open when a stage begins. */
export function openFor(stage: ScopeStage, markups: number): { setup: boolean; markups: boolean } {
  if (stage === 'setup') return { setup: true, markups: markups > 0 }
  return { setup: false, markups: true }
}

/**
 * One line of the summary card: a measurement or a part, the way the card
 * shows it. A null quantity is one the scope cannot count yet.
 */
export interface SummaryLine { label: string; unit: string; quantity: number | null }

/** "Area (SF)", "Panels 2′ 0″ × 2′ 0″ (EA)". The unit rides with the name so the number stays a number. */
export const summaryLabel = (l: SummaryLine): string => (l.unit === '' ? l.label : `${l.label} (${l.unit})`)

/** Tabs and newlines cannot be escaped in a pasted table; they become spaces. */
const cell = (v: string): string => v.replace(/[\t\r\n]+/g, ' ')

/** A number the way a spreadsheet wants it: no thousands separators, no unit. */
const cellNumber = (n: number | null): string => (n === null ? '' : String(Math.round(n * 100) / 100))

/**
 * The summary card as a two-column table, for pasting into an estimate form
 * (Aaron, 2026-11-19: "a simple list of items with the numerical values to
 * the right, just a two-column table"). Tab-separated, as Excel reads a paste.
 */
export function summaryToTsv(lines: readonly SummaryLine[]): string {
  return lines.map((l) => `${cell(summaryLabel(l))}\t${cellNumber(l.quantity)}`).join('\r\n') + '\r\n'
}
