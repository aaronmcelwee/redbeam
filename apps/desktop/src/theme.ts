/**
 * Light or dark, and the window's glass with it.
 *
 * Settings › General › Theme is Match Windows (the default), Light or Dark.
 * The answer is stamped as `data-theme` on <html> and the body, where
 * `theme/redbeam.css` keys its two palettes.
 *
 * The WINDOW has to agree. The chrome is transparent over Mica Alt when the
 * backdrop is on, and DWM tints Mica from the window's theme — so a light
 * palette over dark glass, or dark-theme ink over light glass (0.3.49: "light
 * mode renders text unreadable"), is what a disagreement looks like. The
 * window is told the same theme through Tauri; if that call fails, the
 * backdrop is dropped and the app paints opaque, which is correct either way.
 *
 * "Match Windows" hands the window back to the system (`setTheme(null)`) and
 * follows `prefers-color-scheme`, which WebView2 reports from the window's
 * theme — so the two cannot disagree in that mode.
 */
import { blockBackdrop } from './backdrop.js'
import { SettingsStore, browserStorage, SETTINGS_CHANGED } from './settings/store.js'
import { isTauri } from './tauri/window.js'

export type ThemeChoice = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

/** Fired on window after the theme is stamped, for surfaces painted outside CSS (the drawing surround). */
export const THEME_CHANGED = 'redbeam:theme'

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  if (choice === 'light' || choice === 'dark') return choice
  return systemDark ? 'dark' : 'light'
}

export function readChoice(): ThemeChoice {
  const v = SettingsStore.open(browserStorage()).str('general.theme')
  return v === 'light' || v === 'dark' ? v : 'system'
}

const darkQuery = (): MediaQueryList | null =>
  typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null

/** Stamp a theme on the document. Returns true when it changed. */
export function stampTheme(theme: Theme, doc: Document = document): boolean {
  const changed = doc.documentElement.getAttribute('data-theme') !== theme
  doc.documentElement.setAttribute('data-theme', theme)
  doc.body?.setAttribute('data-theme', theme)
  return changed
}

/** Tell the window, so Mica is tinted to match. False when it could not be told. */
async function syncWindow(choice: ThemeChoice): Promise<boolean> {
  if (!isTauri()) return true
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setTheme(choice === 'system' ? null : choice)
    return true
  } catch {
    return false
  }
}

let lastChoice: ThemeChoice | null = null

/** Read the setting, stamp it, and bring the window along. */
export function applyTheme(choice: ThemeChoice = readChoice()): Theme {
  const theme = resolveTheme(choice, darkQuery()?.matches ?? true)
  if (stampTheme(theme)) window.dispatchEvent(new Event(THEME_CHANGED))
  if (choice !== lastChoice) {
    lastChoice = choice
    void syncWindow(choice).then((ok) => { if (!ok) blockBackdrop() })
  }
  return theme
}

/** Apply now, and again whenever the setting or Windows' own mode changes. */
export function installTheme(): void {
  applyTheme()
  darkQuery()?.addEventListener('change', () => { applyTheme() })
  // This window's settings panel, and any other window's (localStorage).
  window.addEventListener(SETTINGS_CHANGED, () => { applyTheme() })
  window.addEventListener('storage', () => { applyTheme() })
}
