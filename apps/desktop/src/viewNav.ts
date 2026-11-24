/**
 * Getting around a sheet the way every PDF viewer does: zoom to a box you drag,
 * and go back to where you were after a jump.
 *
 * Kept out of the workspace so the arithmetic and the history rules can be
 * argued with in a test rather than through a rendered sheet.
 */

import type { Viewport } from '@redbeam/viewer'

/** A box in stage (CSS) pixels, corners in any order. */
export interface ScreenBox { x0: number; y0: number; x1: number; y1: number }

/** Smaller than this either way and the drag was a click. */
export const ZOOM_BOX_MIN_PX = 6

/**
 * The view that fits a dragged box to the stage, centred.
 *
 * The box is in stage pixels at the current view, so its page span is the box
 * divided by the zoom; the new zoom fits that span to the stage on its tighter
 * axis. Null when the box is too small to mean anything.
 */
export function zoomToBox(
  v: Viewport, box: ScreenBox, stage: { width: number; height: number }, maxZoom: number,
): Viewport | null {
  const bw = Math.abs(box.x1 - box.x0)
  const bh = Math.abs(box.y1 - box.y0)
  if (bw < ZOOM_BOX_MIN_PX || bh < ZOOM_BOX_MIN_PX || !(v.zoom > 0)) return null
  if (!(stage.width > 0) || !(stage.height > 0)) return null
  // The box's centre and size in PDF points.
  const cx = (v.ox + (box.x0 + box.x1) / 2) / v.zoom
  const cy = (v.oy + (box.y0 + box.y1) / 2) / v.zoom
  const pw = bw / v.zoom
  const ph = bh / v.zoom
  const zoom = Math.min(maxZoom, Math.min(stage.width / pw, stage.height / ph))
  return { ...v, zoom, ox: cx * zoom - stage.width / 2, oy: cy * zoom - stage.height / 2 }
}

/** A place in the document: the sheet and how it was framed. */
export interface ViewPlace {
  page: number
  zoom: number
  ox: number
  oy: number
}

/*
 * Every place is kept, both ways, for as long as the document is open
 * (Aaron, 2026-11-24: no arbitrary caps). A place is four numbers.
 */

/**
 * Back and forward through the sheets visited, like a browser.
 *
 * A place is recorded when you LEAVE a sheet, so Back returns to the sheet
 * as you last framed it. Going somewhere new clears Forward, as a browser
 * does. Stepping through history does not record a place of its own: the
 * caller says so with `navigating`.
 */
export class ViewHistory {
  private back: ViewPlace[] = []
  private fwd: ViewPlace[] = []

  /** You left `from` for another sheet. */
  leave(from: ViewPlace): void {
    const last = this.back[this.back.length - 1]
    if (last !== undefined && last.page === from.page) this.back[this.back.length - 1] = from
    else this.back.push(from)
    this.fwd = []
  }

  canGoBack(): boolean { return this.back.length > 0 }
  canGoForward(): boolean { return this.fwd.length > 0 }

  /** Where Back goes from `here`, or null. `here` becomes Forward. */
  goBack(here: ViewPlace): ViewPlace | null {
    const to = this.back.pop()
    if (to === undefined) return null
    this.fwd.push(here)
    return to
  }

  /** Where Forward goes from `here`, or null. `here` becomes Back. */
  goForward(here: ViewPlace): ViewPlace | null {
    const to = this.fwd.pop()
    if (to === undefined) return null
    this.back.push(here)
    return to
  }

  clear(): void { this.back = []; this.fwd = [] }
}

/** Alt+Left / Alt+Right, and the mouse's back and forward buttons. */
export function historyStepForKey(
  key: string, mods: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
): -1 | 1 | null {
  if (!mods.altKey || mods.ctrlKey || mods.metaKey || mods.shiftKey) return null
  if (key === 'ArrowLeft') return -1
  if (key === 'ArrowRight') return 1
  return null
}

/** MouseEvent.button 3 is Back and 4 is Forward on a five-button mouse. */
export function historyStepForButton(button: number): -1 | 1 | null {
  return button === 3 ? -1 : button === 4 ? 1 : null
}
