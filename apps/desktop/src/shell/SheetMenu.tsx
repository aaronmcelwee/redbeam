/**
 * What can be done to a selection of sheets: the right-click menu shared by
 * the Contents list and the Thumbnails strip.
 *
 * Both panels select the same way (sheetSelection.ts) and act the same way,
 * so a sheet picked in one is not a different kind of thing in the other.
 */
import { Glyph, Print, RotateSheetCcw, RotateSheetCw } from './icons.js'
import { useClampedPopover } from './popover.js'

/** The actions a host offers on selected sheets. Each is left out of the menu when absent. */
export interface SheetActions {
  /** Set one scale across the sheets. */
  onSetScale?: (pages: number[]) => void
  /** Turn the sheets by clockwise quarter turns: 1, 2 (180°) or 3 (counterclockwise). */
  onRotate?: (pages: number[], turns: 1 | 2 | 3) => void
  /** Print the sheets. */
  onPrint?: (pages: number[]) => void
}

export function hasSheetActions(a: SheetActions): boolean {
  return a.onSetScale !== undefined || a.onRotate !== undefined || a.onPrint !== undefined
}

export function SheetMenu({
  at, pages, heading, actions, onClose,
}: {
  at: { x: number, y: number }
  pages: number[]
  heading: string
  actions: SheetActions
  onClose: () => void
}) {
  const clamp = useClampedPopover<HTMLDivElement>(true)
  const act = (f: () => void) => () => { f(); onClose() }
  const { onSetScale, onRotate, onPrint } = actions
  return (
    <>
      {/* A scrim, so the next click anywhere dismisses the menu rather than
          also landing on whatever is underneath it. */}
      <div
        className="menuscrim"
        onPointerDown={(e) => { e.stopPropagation(); onClose() }}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      {/* `sheetmenu`, not a bare `dockmenu`: see SheetIndex. */}
      <div className="dockmenu sheetmenu" role="menu" ref={clamp.ref} style={{ left: at.x, top: at.y, ...clamp.style }}>
        <div className="menuhead">{heading}</div>
        {onRotate !== undefined && (
          <>
            <button className="menuitem" role="menuitem" onClick={act(() => onRotate(pages, 1))}>
              <Glyph icon={RotateSheetCw} role="inline" />
              <span className="grow">Rotate clockwise</span>
            </button>
            <button className="menuitem" role="menuitem" onClick={act(() => onRotate(pages, 3))}>
              <Glyph icon={RotateSheetCcw} role="inline" />
              <span className="grow">Rotate counterclockwise</span>
            </button>
            <button className="menuitem" role="menuitem" onClick={act(() => onRotate(pages, 2))}>
              <Glyph icon={RotateSheetCw} role="inline" />
              <span className="grow">Rotate 180°</span>
            </button>
          </>
        )}
        {onPrint !== undefined && (
          <button className="menuitem" role="menuitem" onClick={act(() => onPrint(pages))}>
            <Glyph icon={Print} role="inline" />
            <span className="grow">Print…</span>
          </button>
        )}
        {onSetScale !== undefined && (
          <>
            {(onRotate !== undefined || onPrint !== undefined) && <div className="menusep" />}
            <button className="menuitem" role="menuitem" onClick={act(() => onSetScale(pages))}>
              <span className="grow">Set scale…</span>
            </button>
          </>
        )}
      </div>
    </>
  )
}
