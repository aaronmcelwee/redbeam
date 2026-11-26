/**
 * How big a thumbnail is drawn, and at how many pixels it is rendered.
 *
 * Kenneth, 2026-11-26: "Make the thumbnails easier to see and read. They're
 * really muddy. Make them load faster too." They were rendered 80 pixels wide
 * and shown 80 CSS pixels wide in a pane three columns across, so on a 150%
 * or 4K screen every thumbnail was stretched from a third or half of the
 * pixels it needed. Now a thumbnail fills its column and is rendered at the
 * screen's own density; Ctrl+wheel over the pane changes how many columns
 * there are (1 to 4), and the choice is remembered.
 */

export const MIN_COLUMNS = 1
export const MAX_COLUMNS = 4
export const DEFAULT_COLUMNS = 3
export const COLUMNS_KEY = 'redbeam.thumb-columns'

/** A stored column count, or the default when there is none or it is not one. */
export function parseColumns(raw: string | null): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10)
  return Number.isInteger(n) && n >= MIN_COLUMNS && n <= MAX_COLUMNS ? n : DEFAULT_COLUMNS
}

/** One wheel notch: up makes them bigger (fewer columns), down smaller. */
export function stepColumns(columns: number, deltaY: number): number {
  if (deltaY === 0) return columns
  const next = columns + (deltaY < 0 ? -1 : 1)
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, next))
}

/**
 * The CSS width of one thumbnail's image in a pane `paneWidth` wide.
 * `chrome` is what each cell spends on its own border and padding.
 */
export function cellWidth(paneWidth: number, columns: number, gap: number, padding: number, chrome: number): number {
  const inner = paneWidth - padding * 2 - gap * (columns - 1)
  return Math.max(24, Math.floor(inner / columns) - chrome)
}

/**
 * Pixels to render for a thumbnail shown `cssWidth` wide at `dpr`: rounded up
 * to a step of 32, so dragging the pane a few pixels wider does not render
 * every thumbnail again.
 */
export function renderWidth(cssWidth: number, dpr: number): number {
  const px = Math.max(1, cssWidth * (Number.isFinite(dpr) && dpr > 0 ? dpr : 1))
  return Math.ceil(px / 32) * 32
}
