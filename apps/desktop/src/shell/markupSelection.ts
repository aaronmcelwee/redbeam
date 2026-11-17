/**
 * Selecting rows in a scope's markup list: Ctrl toggles, Shift takes a range,
 * a plain click picks one. The list's selection is the canvas's selection, so
 * whatever is picked here is what Delete, Ctrl+D and the right-click menu act on.
 */

export interface RowClick {
  /** Ctrl on Windows, Cmd on a Mac: toggles one row. */
  toggle: boolean
  /** Shift: every row between the anchor and this one, as the list shows them. */
  range: boolean
}

/**
 * The selection after a click on a row of a markup list.
 *
 * `visible` is the rows in the order they are on screen (grouping changes it),
 * which is what a Shift range means. Rows outside the list (markups selected
 * on the canvas in another scope) are kept by a toggle and dropped by a plain
 * click or a range, the way a list replaces its own selection.
 */
export function clickMarkupRow(
  selected: readonly string[],
  anchor: string | null,
  id: string,
  mods: RowClick,
  visible: readonly string[],
): { selected: string[]; anchor: string | null } {
  if (mods.range && anchor !== null) {
    const from = visible.indexOf(anchor)
    const to = visible.indexOf(id)
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      const span = visible.slice(lo, hi + 1)
      // Ctrl+Shift adds the range to what is there; Shift alone replaces it.
      if (mods.toggle) return { selected: [...selected, ...span.filter((x) => !selected.includes(x))], anchor }
      return { selected: span, anchor }
    }
  }
  if (mods.toggle) {
    return {
      selected: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id],
      anchor: id,
    }
  }
  return { selected: [id], anchor: id }
}
