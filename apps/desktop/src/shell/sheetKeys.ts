/**
 * The drawing's single-key shortcuts, decided apart from the listener so they
 * can be tested without a window.
 */

export type ToolKey =
  | 'select' | 'pan' | 'area' | 'polyline' | 'count' | 'cutout' | 'shape'
  | 'calibrate' | 'scale-region'

export interface KeyMods {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

const TOOL_KEYS: Record<string, ToolKey> = {
  v: 'select', h: 'pan', a: 'area', l: 'polyline', c: 'count', x: 'cutout',
  s: 'shape', k: 'calibrate', K: 'scale-region',
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
