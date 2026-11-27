/**
 * A scope's own layout settings (Aaron, 2026-11-27: "these should be
 * per-scope settings").
 *
 * Where each area's pattern starts, whether an automatic start lays each area
 * out on its own, and what the layout preview draws for this scope. They were
 * global settings until 0.3.132. A scope that has never set one reads the
 * value the global setting held, so nothing an existing scope counts or draws
 * changes until someone sets it on the scope.
 *
 * Only the master "Show the layout preview" switch stays global: it is a view
 * toggle, not a property of a scope.
 */
import { isAreaCorner, readBool, readString, type AreaCorner, type Specifications } from '@redbeam/domain'

export type PatternStart = AreaCorner | 'automatic'

export const PATTERN_STARTS: ReadonlyArray<{ value: PatternStart; label: string }> = [
  { value: 'top-left', label: 'top-left corner' },
  { value: 'top-right', label: 'top-right corner' },
  { value: 'bottom-left', label: 'bottom-left corner' },
  { value: 'bottom-right', label: 'bottom-right corner' },
  { value: 'automatic', label: 'automatic' },
]

/** Spec keys, as agents and the PDF carry them. */
export const LAYOUT_KEYS = {
  patternStart: 'layoutPatternStart',
  perAreaOrigin: 'layoutPerArea',
  showOverflow: 'layoutShowOverflow',
  showRails: 'layoutShowRails',
  showTrim: 'layoutShowTrim',
  showSeams: 'layoutShowSeams',
} as const

/** The global settings these replace, read only as the fallback for a scope that has not set its own. */
export const LEGACY_LAYOUT_SETTINGS = [
  'takeoff.perAreaOrigin', 'takeoff.patternStart', 'takeoff.layoutOverflow',
  'takeoff.layoutRails', 'takeoff.layoutTrim', 'takeoff.layoutSeams',
] as const

export interface ScopeLayout {
  patternStart: PatternStart
  perAreaOrigin: boolean
  showOverflow: boolean
  showRails: boolean
  showTrim: boolean
  showSeams: boolean
}

type Prefs = Readonly<Record<string, unknown>>

function startOf(v: unknown): PatternStart | null {
  return v === 'automatic' || isAreaCorner(v) ? v : null
}

/** The scope's layout settings, each from the scope, else the old global setting, else its default. */
export function scopeLayout(specs: Specifications, prefs: Prefs): ScopeLayout {
  const bool = (key: string, pref: string, fallback: boolean): boolean =>
    readBool(specs, key, typeof prefs[pref] === 'boolean' ? prefs[pref] as boolean : fallback)
  return {
    patternStart: startOf(readString(specs, LAYOUT_KEYS.patternStart)) ?? startOf(prefs['takeoff.patternStart']) ?? 'top-left',
    perAreaOrigin: bool(LAYOUT_KEYS.perAreaOrigin, 'takeoff.perAreaOrigin', false),
    showOverflow: bool(LAYOUT_KEYS.showOverflow, 'takeoff.layoutOverflow', true),
    showRails: bool(LAYOUT_KEYS.showRails, 'takeoff.layoutRails', true),
    showTrim: bool(LAYOUT_KEYS.showTrim, 'takeoff.layoutTrim', true),
    showSeams: bool(LAYOUT_KEYS.showSeams, 'takeoff.layoutSeams', true),
  }
}

/** The corner an unstarted area begins at, or null for automatic. */
export function defaultCornerOf(layout: ScopeLayout): AreaCorner | null {
  return layout.patternStart === 'automatic' ? null : layout.patternStart
}
