/**
 * The drawing's single-key shortcuts, decided apart from the listener so they
 * can be tested without a window.
 */

export type ToolKey =
  | 'select' | 'pan' | 'area' | 'polyline' | 'count' | 'cutout' | 'shape'
  | 'calibrate' | 'scale-region' | 'text' | 'dimension' | 'origin'
  | 'callout' | 'rect' | 'ellipse' | 'polygon' | 'pen'

export interface KeyMods {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

const TOOL_KEYS: Record<string, ToolKey> = {
  v: 'select', h: 'pan', a: 'area', l: 'polyline', c: 'count', x: 'cutout',
  s: 'shape', k: 'calibrate', K: 'scale-region', t: 'text',
  // Dimension had no key at all, and the Origin tool is new (#68, #69).
  d: 'dimension', o: 'origin',
  // The note tools, on Revu's letters where ours are free (Kenneth,
  // 2026-11-26): Q callout, R rectangle, E ellipse, N polygon, P pen. Revu's
  // C, A and L are Count, Area and Linear here, so Cloud, Arrow and Line
  // are in the Markup menu.
  q: 'callout', r: 'rect', e: 'ellipse', n: 'polygon', p: 'pen',
}

/**
 * The key that arms a tool, as a tooltip writes it: "A", or "Shift+K".
 *
 * Read off the same table the listener uses, so a tooltip cannot name a key
 * that does something else. The dock's tooltips named the shortcut for Pan,
 * Select and Text only; nobody could find the other seven (#68).
 */
export function shortcutFor(tool: string): string | null {
  for (const [key, t] of Object.entries(TOOL_KEYS)) {
    if (t !== tool) continue
    return key === key.toLowerCase() ? key.toUpperCase() : `Shift+${key}`
  }
  return null
}

/**
 * The tool a bare letter arms, or null.
 *
 * Only a BARE letter. Ctrl+K opens the command palette, and the same keydown
 * also reached this table as "k", so every Ctrl+K armed Calibrate underneath
 * the palette: close it and the sheet had a crosshair nobody chose (#29).
 * Ctrl+L, Ctrl+H and Ctrl+X did the same to Polyline, Pan and Cutout.
 */
export function toolForKey(key: string, mods: KeyMods): ToolKey | null {
  if (mods.ctrlKey || mods.metaKey || mods.altKey) return null
  return TOOL_KEYS[key] ?? null
}

/**
 * Which way a key steps through the sheets: -1, +1, or null (#30).
 *
 * Left and Right, and PgUp and PgDn, which the dock's ⋯ menu has always
 * named as the shortcuts for Previous and Next sheet without either being
 * wired. Bare keys only, so Alt+Left and friends stay with the system.
 */
export function pageStepForKey(key: string, mods: KeyMods & { shiftKey: boolean }): -1 | 1 | null {
  if (mods.ctrlKey || mods.metaKey || mods.altKey || mods.shiftKey) return null
  if (key === 'ArrowLeft' || key === 'PageUp') return -1
  if (key === 'ArrowRight' || key === 'PageDown') return 1
  return null
}

/** The page a step lands on, or null at either end. Stepping does not wrap. */
export function steppedPage(page: number, pageCount: number, step: -1 | 1): number | null {
  const next = page + step
  return next >= 0 && next < pageCount ? next : null
}
