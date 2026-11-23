/**
 * Turning the Windows 11 backdrop on for the stylesheet.
 *
 * The window is created transparent so DWM's Mica can show behind it, but
 * transparency and BACKDROP are separate things: on Windows 10 the effect is a
 * no-op and the window is still transparent. A stylesheet that made the chrome
 * translucent unconditionally would render the app as a hole onto the desktop
 * there.
 *
 * So nothing is translucent until Rust confirms the backdrop actually applied
 * — `backdrop_active` reports the result of asking for it, on this machine,
 * this run. Every translucent rule in the stylesheet hangs off the attribute
 * this sets, so the default in a browser, in the harness, and on Windows 10 is
 * the opaque app that already existed.
 */
import { isTauri } from './tauri/window.js'

/** The attribute the stylesheet keys off. Exported for the tests. */
export const BACKDROP_ATTR = 'data-backdrop'

let blocked = false

/**
 * Paint opaque for the rest of the run, whatever Rust said.
 *
 * Called when the window could not be given the app's theme (`theme.ts`):
 * Mica would then be tinted for the other theme, and the chrome over it
 * unreadable. Opaque is a complete way for the app to look.
 */
export function blockBackdrop(): void {
  blocked = true
  document.documentElement.removeAttribute(BACKDROP_ATTR)
}

/**
 * Ask whether the backdrop took, and mark the document if it did.
 *
 * Never throws: a backdrop is decoration, and an estimator with a takeoff open
 * does not care that a visual effect could not be queried. Failure leaves the
 * app opaque, which is a complete and correct way for it to look.
 */
export async function applyBackdropClass(): Promise<boolean> {
  if (!isTauri() || blocked) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const active = await invoke<boolean>('backdrop_active') && !blocked
    if (active) document.documentElement.setAttribute(BACKDROP_ATTR, 'tabbed')
    return active
  } catch {
    return false
  }
}
