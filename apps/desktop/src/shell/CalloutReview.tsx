/**
 * The list "Link detail callouts" asks about before writing anything
 * (Kenneth, 2026-11-26, item 12; tools/callouts.ts finds them).
 *
 * Grouped by the sheet each link goes on, one row per callout: what it says,
 * and the sheet it would jump to. Clicking a row shows it on the drawing. The
 * likely ones come ticked; Add writes the ticked ones as links in one undo
 * step, and the next save puts them in the PDF.
 *
 * A panel over the right of the drawing rather than a modal, so the sheet
 * under it can still be looked at while the list is checked.
 */
import { useMemo } from 'react'
import type { Candidate } from '../tools/callouts.js'
import { Glyph, LinkIcon, X } from './icons.js'

export interface ReviewState {
  phase: 'reading' | 'ready'
  /** Sheets read so far, and of how many. */
  read: number
  total: number
  candidates: Candidate[]
  /** The row shown on the drawing. */
  focus: number | null
}

export function CalloutReview({ state, sheetLabel, sheetTitle, onToggle, onAll, onFocus, onApply, onCancel }: {
  state: ReviewState
  sheetLabel: (page: number) => string
  sheetTitle: (page: number) => string
  onToggle: (i: number) => void
  onAll: (checked: boolean) => void
  onFocus: (i: number) => void
  onApply: () => void
  onCancel: () => void
}) {
  const groups = useMemo(() => {
    const by = new Map<number, number[]>()
    state.candidates.forEach((c, i) => { const g = by.get(c.page) ?? []; g.push(i); by.set(c.page, g) })
    return [...by.entries()].sort((a, b) => a[0] - b[0])
  }, [state.candidates])
  const ticked = state.candidates.filter((c) => c.checked).length
  const reading = state.phase === 'reading'
  return (
    <aside className="calloutreview" aria-label="Detail callouts">
      <header className="crhead">
        <Glyph icon={LinkIcon} role="inline" />
        <div className="grow">
          <div className="crtitle">Link detail callouts</div>
          <div className="crsub">
            {reading
              ? `Reading sheet ${state.read} of ${state.total} · ${state.candidates.length} found so far`
              : state.candidates.length === 0
                ? `No unlinked references to other sheets on ${state.total} sheets`
                : `${state.candidates.length} references on ${groups.length} sheets · ${ticked} ticked`}
          </div>
          {reading && <progress max={state.total} value={state.read} />}
        </div>
        <button type="button" className="dockbtn dockicon" title="Close without adding links" onClick={onCancel}>
          <Glyph icon={X} role="small" />
        </button>
      </header>
      {state.candidates.length > 0 && (
        <div className="crtools">
          <button type="button" className="ghostbtn small" onClick={() => onAll(true)}>Tick all</button>
          <button type="button" className="ghostbtn small" onClick={() => onAll(false)}>Clear</button>
        </div>
      )}
      <div className="crlist">
        {groups.map(([page, idx]) => (
          <section key={page}>
            <div className="crgroup">{sheetLabel(page)}<span>{sheetTitle(page)}</span></div>
            {idx.map((i) => {
              const c = state.candidates[i]!
              return (
                <div key={i} className="crrow" data-focus={state.focus === i || undefined}>
                  <input type="checkbox" checked={c.checked} aria-label={`Link ${c.text}`} onChange={() => onToggle(i)} />
                  <button type="button" className="crpick" onClick={() => onFocus(i)} title="Show it on the drawing">
                    <span className="crtext">{c.text}</span>
                    <span className="crarrow" aria-hidden="true">→</span>
                    <span className="crto">{sheetLabel(c.toPage)} <span>{sheetTitle(c.toPage)}</span></span>
                    {c.kind === 'mention' && <span className="crkind">mention</span>}
                  </button>
                </div>
              )
            })}
          </section>
        ))}
      </div>
      <footer className="crfoot">
        <button type="button" className="ghostbtn" onClick={onCancel}>Cancel</button>
        <button type="button" className="primarybtn" disabled={reading || ticked === 0} onClick={onApply}>
          {ticked === 1 ? 'Add 1 link' : `Add ${ticked} links`}
        </button>
      </footer>
    </aside>
  )
}
