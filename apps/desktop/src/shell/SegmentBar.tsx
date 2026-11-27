/**
 * Line, Arc or Circle: how the next click joins a trace in Area, Cutout and
 * Linear (Kenneth, 2026-11-26, item 8). It floats just above the dock while
 * one of those tools is in hand, the way Fluent puts a tool's options on a
 * secondary command bar beside the tool rather than in a dialog.
 *
 * The keys are named in each button's tooltip: A mid-trace for an arc,
 * Shift+C for circles. The caption says what the next click does, because a
 * three-point arc is a gesture people know from CAD but not from a PDF app.
 */
import { CircleSeg, Glyph, LinkIcon, Polyline } from './icons.js'
import type { SegmentMode } from '../tools/curves.js'

/** Fluent ships no arc glyph; this is drawn on the same 16px grid and stroke. */
function ArcGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none">
      <path d="M2.5 12.5 A 6.2 6.2 0 0 1 13.5 12.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <circle cx="2.5" cy="12.5" r="1.25" fill="currentColor" />
      <circle cx="13.5" cy="12.5" r="1.25" fill="currentColor" />
    </svg>
  )
}

/** What the next click does, in a few words. */
export function segmentCaption(mode: SegmentMode, placed: number, pivot: boolean, tool: string): string {
  if (mode === 'circle') return pivot ? 'Click a point on the edge' : 'Click the centre'
  if (mode === 'arc') {
    if (placed === 0) return 'Click where the arc starts'
    return pivot ? (tool === 'polyline' ? 'Click where the arc ends' : 'Click where the arc ends, or Enter to close') : 'Click a point the arc passes through'
  }
  return placed === 0 ? 'Click to start · A mid-trace for an arc · Shift+C for a circle' : 'A for an arc, Enter to finish'
}

export function SegmentBar({ mode, caption, onMode }: {
  mode: SegmentMode
  caption: string
  onMode: (mode: SegmentMode) => void
}) {
  const btn = (m: SegmentMode, label: string, title: string, icon: React.ReactNode) => (
    <button
      type="button"
      className="dockbtn segbtn"
      aria-pressed={mode === m}
      title={title}
      // Never takes focus from the drawing: the keys keep working mid-trace.
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => onMode(m)}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
  return (
    <div className="segbar dockgroup" role="toolbar" aria-label="Segment">
      {btn('line', 'Line', 'Straight segments', <Glyph icon={Polyline} role="inline" />)}
      {btn('arc', 'Arc', 'Arc: a point it passes through, then its end (A)', <ArcGlyph />)}
      {btn('circle', 'Circle', 'Circle: the centre, then a point on the edge (Shift+C)', <Glyph icon={CircleSeg} role="inline" />)}
      <span className="segcaption" aria-live="polite">{caption}</span>
    </div>
  )
}

/**
 * The Link tool's bar, in the same place: what to do, and the way to have
 * every callout in the set found instead of drawing them one by one.
 */
export function LinkBar({ onFind }: { onFind: () => void }) {
  return (
    <div className="segbar dockgroup" role="toolbar" aria-label="Link">
      <span className="segcaption first">Drag a box over a callout, then pick its sheet</span>
      <button
        type="button"
        className="dockbtn segbtn"
        title="Find every reference to another sheet in this set, and choose which to link"
        onPointerDown={(e) => e.preventDefault()}
        onClick={onFind}
      >
        <Glyph icon={LinkIcon} role="inline" />
        <span>Link all detail callouts…</span>
      </button>
    </div>
  )
}
