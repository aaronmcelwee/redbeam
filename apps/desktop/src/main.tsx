import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { applySystemAccent, followSystemAccent } from './accent.js'
import { applyBackdropClass } from './backdrop.js'
import { installTheme } from './theme.js'
import { installCrashHandlers } from './crash.js'
import { installSignals } from './signals/install.js'
import App from './App.js'
import './styles.css'

/**
 * Mount the design system.
 *
 * `class="ads"` is what scopes every primitive in the system — its selectors
 * are all `.ads .ads-thing`, so without this the primitives layer loads and
 * matches nothing.
 *
 * `data-theme` goes on BOTH <html> and the surface root, per standards/09:
 * the root scroller, the viewport scrollbar and the overscroll canvas follow
 * the html stamp, and without it choosing dark on a light-OS machine leaves a
 * white flash at the edges of every scroll.
 *
 * The theme is the user's (Settings › General › Theme, Match Windows by
 * default) and `theme.ts` stamps it, before the first render so nothing
 * paints in the other palette first. Dark had been the only theme, chosen
 * because the sheet is white paper and near-white chrome competes with it;
 * that is still the argument for Dark, now as a choice.
 */
document.body.classList.add('ads')
installTheme()

/*
 * The Windows 11 backdrop, if this machine has one.
 *
 * Fired here rather than awaited: nothing below depends on the answer, and the
 * app must not wait on an IPC round trip to draw. Until it resolves — and
 * forever, where there is no backdrop — every surface is opaque, so the app
 * simply appears as it always has.
 */
void applyBackdropClass()

/*
 * And the user's accent, for the same reason and in the same way: fired, not
 * awaited. Until it answers the theme carries Windows' default blue.
 */
void applySystemAccent()
followSystemAccent()

/**
 * The webview's own context menu never belongs to this app.
 *
 * Right-clicking a drawing offered "Save image as / Copy image / Inspect" —
 * the browser showing through, on a canvas where the estimator meant to cancel
 * a tool. Suppressed everywhere except text fields, where a paste menu is
 * genuinely the expected thing, and anywhere that opts in by handling the
 * event itself (the tab strip has its own menu and calls preventDefault, which
 * is not the same as wanting the webview's).
 */
window.addEventListener('contextmenu', (e) => {
  const el = e.target as HTMLElement | null
  const editable = el?.closest('input, textarea, [contenteditable="true"]')
  if (editable === null || editable === undefined) e.preventDefault()
})

/*
 * Before the first render (TH.8).
 *
 * An unhandled rejection thrown while the app is starting is the one nobody
 * ever sees: there is no window yet to show an error boundary in, and the
 * console it logs to closes with the process.
 */
installCrashHandlers()

/*
 * Anonymous error and UX counts (src/signals). After the crash handlers, so
 * a failure while starting is both written to disk and counted.
 */
installSignals()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
