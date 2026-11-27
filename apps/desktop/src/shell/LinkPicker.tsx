/**
 * Where a drawn link goes: the sheet list, filtered as you type, with the
 * sheet the box sits on top when its words name one (tools/links.ts
 * `suggestTargets`). Enter takes the first row, Escape drops the box.
 *
 * A flyout on the box, like the markup menu, rather than a dialog: the person
 * is looking at the callout, and the answer is one click.
 */
import { useMemo, useState } from 'react'
import { Glyph, LinkIcon } from './icons.js'
import { useClampedPopover } from './popover.js'

export interface PickerSheet { page: number; number: string; title: string }

export function LinkPicker({ x, y, sheets, suggested, fromPage, onPick, onCancel }: {
  x: number
  y: number
  sheets: readonly PickerSheet[]
  suggested: readonly number[]
  fromPage: number
  onPick: (page: number) => void
  onCancel: () => void
}) {
  const [filter, setFilter] = useState('')
  const clamp = useClampedPopover<HTMLDivElement>(true, [filter])
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const others = sheets.filter((s) => s.page !== fromPage)
    const hit = q === '' ? others : others.filter((s) => `${s.number} ${s.title}`.toLowerCase().includes(q))
    const first = suggested.map((p) => hit.find((s) => s.page === p)).filter((s): s is PickerSheet => s !== undefined)
    return [...first, ...hit.filter((s) => !suggested.includes(s.page))]
  }, [sheets, suggested, filter, fromPage])
  return (
    <>
      <div
        className="menuscrim"
        onPointerDown={(e) => { e.stopPropagation(); onCancel() }}
        onContextMenu={(e) => { e.preventDefault(); onCancel() }}
      />
      <div ref={clamp.ref} className="dockmenu markupmenu linkpicker" role="dialog" aria-label="Link to a sheet" style={{ left: x, top: y, ...clamp.style }}>
        <div className="menuhead">Link to a sheet</div>
        <input
          className="kvcontrol linkfilter"
          placeholder="Sheet number or name"
          value={filter}
          autoFocus
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && rows[0] !== undefined) { e.preventDefault(); onPick(rows[0].page) }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
          }}
        />
        <div className="linkrows" role="listbox">
          {rows.length === 0 && <div className="menuhead">No sheet matches</div>}
          {rows.map((s, i) => (
            <button key={s.page} type="button" className="menuitem" role="option" aria-selected={i === 0} onClick={() => onPick(s.page)}>
              <Glyph icon={LinkIcon} role="row" />
              <span className="linknum">{s.number}</span>
              <span className="grow linktitle">{s.title}</span>
              {suggested.includes(s.page) && <span className="hint">in box</span>}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
