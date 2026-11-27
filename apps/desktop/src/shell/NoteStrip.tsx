/**
 * The note properties: colour, line width, fill, line ends and font size,
 * on a small strip over the dock.
 *
 * It shows while a note tool is in hand (it sets what the tool draws next)
 * and while notes are selected (it changes them). Only what the shape has is
 * offered: ends on a line and a leader; a font size wherever there is text;
 * fill on closed shapes. Nothing else is on it, so it stays one row.
 */
import { useState } from 'react'
import { useDismiss } from './dismiss.js'
import { useClampedPopover } from './popover.js'
import { Check, ChevronDown, FillColor, FontSize, Glyph, LineWidth } from './icons.js'
import {
  LINE_ENDS, NOTE_COLORS, NOTE_FONT_SIZES, NOTE_WIDTHS, hasEnds, hasText, isClosedShape,
  type LineEnd, type NoteContent,
} from '../tools/noteGeometry.js'

export type NotePatch = Partial<Pick<NoteContent, 'color' | 'width' | 'fill' | 'fillOpacity' | 'ends' | 'fontPt'>>

export interface NoteStripProps {
  /** What the controls show: the tool's style, or the first selected note's. */
  content: NoteContent
  /** What is being changed, for the strip's label. */
  target: 'tool' | 'selection'
  /** How many notes are selected, when the target is the selection. */
  count?: number
  onChange: (patch: NotePatch) => void
}

const END_LABEL: Record<LineEnd, string> = { arrow: 'Arrow', open: 'Open arrow', dot: 'Dot', none: 'None' }

/** A small picture of a line end, drawn the way the sheet draws it. */
function EndGlyph({ end, flip = false }: { end: LineEnd; flip?: boolean }) {
  return (
    <svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true" style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <line x1="4" y1="6" x2="21" y2="6" stroke="currentColor" strokeWidth="1.5" />
      {end === 'arrow' && <path d="M1 6 L9 2 L9 10 Z" fill="currentColor" />}
      {end === 'open' && <path d="M9 2 L1 6 L9 10" fill="none" stroke="currentColor" strokeWidth="1.5" />}
      {end === 'dot' && <circle cx="4" cy="6" r="3" fill="currentColor" />}
    </svg>
  )
}

function Menu<T extends string | number>({
  label, title, icon, value, options, render, onPick,
}: {
  label: string
  title: string
  icon?: React.ReactNode
  value: T
  options: readonly T[]
  render: (v: T) => React.ReactNode
  onPick: (v: T) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const clamp = useClampedPopover<HTMLDivElement>(open)
  return (
    <div ref={ref} className="notestripwrap">
      <button
        className="dockbtn notestripbtn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
        <span className="notestripvalue">{render(value)}</span>
        <Glyph icon={ChevronDown} role="small" style={{ transform: 'rotate(180deg)' }} />
      </button>
      {open && (
        <div className="dockmenu left notestripmenu" role="listbox" aria-label={label} ref={clamp.ref} style={clamp.style}>
          {options.map((o) => (
            <button
              key={String(o)}
              className="menuitem"
              role="option"
              aria-selected={o === value}
              onClick={() => { onPick(o); setOpen(false) }}
            >
              <span className="grow">{render(o)}</span>
              {o === value && <span className="dockcheck"><Glyph icon={Check} role="small" filled /></span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function NoteStrip({ content: c, target, count = 0, onChange }: NoteStripProps) {
  const closed = isClosedShape(c.shape)
  const filled = c.fill !== null && c.fillOpacity > 0
  return (
    <div
      className="dockgroup notestrip"
      role="toolbar"
      aria-label={target === 'tool' ? 'Markup properties' : `Properties of ${count} selected markup${count === 1 ? '' : 's'}`}
    >
      <div className="noteswatches" role="radiogroup" aria-label="Colour">
        {NOTE_COLORS.map((col) => (
          <button
            key={col}
            className="noteswatch"
            role="radio"
            aria-checked={c.color.toLowerCase() === col}
            aria-label={col}
            title="Colour"
            style={{ background: col }}
            onClick={() => onChange({ color: col, ...(c.shape !== 'text' && c.fill !== null ? { fill: col } : {}) })}
          />
        ))}
      </div>
      <span className="dockrule" aria-hidden="true" />
      <Menu
        label="Line width"
        title="Line width"
        icon={<Glyph icon={LineWidth} role="inline" />}
        value={c.width}
        options={c.shape === 'text' ? [0, ...NOTE_WIDTHS] : NOTE_WIDTHS}
        render={(w) => (w === 0 ? 'No border' : `${w} pt`)}
        onPick={(w) => onChange({ width: w })}
      />
      {closed && (
        <button
          className="dockbtn notestripbtn"
          aria-pressed={filled}
          title={filled ? 'Fill: on' : 'Fill: off'}
          aria-label="Fill"
          onClick={() => onChange(filled
            ? { fill: null }
            : c.shape === 'text' ? { fill: '#ffffff', fillOpacity: 1 } : { fill: c.color, fillOpacity: 0.25 })}
        >
          <Glyph icon={FillColor} role="inline" filled={filled} />
          <span className="notestripvalue">Fill</span>
        </button>
      )}
      {hasEnds(c.shape) && (
        <Menu
          label={c.shape === 'line' ? 'Start' : 'Leader end'}
          title={c.shape === 'line' ? 'The end you started from' : 'The end that points at the thing'}
          value={c.ends[0]}
          options={LINE_ENDS}
          render={(e) => <span className="noteend"><EndGlyph end={e} />{END_LABEL[e]}</span>}
          onPick={(e) => onChange({ ends: [e, c.ends[1]] })}
        />
      )}
      {c.shape === 'line' && (
        <Menu
          label="End"
          title="The end you finished at"
          value={c.ends[1]}
          options={LINE_ENDS}
          render={(e) => <span className="noteend"><EndGlyph end={e} flip />{END_LABEL[e]}</span>}
          onPick={(e) => onChange({ ends: [c.ends[0], e] })}
        />
      )}
      {hasText(c.shape) && (
        <Menu
          label="Font size"
          title="Font size"
          icon={<Glyph icon={FontSize} role="inline" />}
          value={c.fontPt}
          options={NOTE_FONT_SIZES}
          render={(s) => `${s} pt`}
          onPick={(s) => onChange({ fontPt: s })}
        />
      )}
    </div>
  )
}
