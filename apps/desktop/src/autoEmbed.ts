/**
 * When the auto-save writes the takeoff into the PDF.
 *
 * Writing a drawing set back to disk is the heaviest thing the app does: the
 * whole file is rewritten, and in a OneDrive or SharePoint folder it is then
 * uploaded again. It used to happen five seconds after any change, which in a
 * steady takeoff (a click every second or two, a pause to look at the sheet)
 * meant mid-work, again and again. Now it waits until the change has settled
 * AND the person has stopped touching the window for a moment, but never
 * longer than `maxWaitMs` after the change, so work is not held unsaved by
 * someone who keeps the mouse moving.
 */

/** After the last change. */
export const AUTO_EMBED_MS = 5000
/** Without a pointer, wheel or key event. */
export const EMBED_QUIET_MS = 2500
/** After the last change, whatever the person is doing. */
export const EMBED_MAX_WAIT_MS = 30000

export interface Clock {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/**
 * Run `save` once the change is `AUTO_EMBED_MS` old and the window has been
 * quiet for `EMBED_QUIET_MS` (`sinceInput` says how long it has been). Returns
 * a cancel, for the effect that scheduled it.
 */
export function embedWhenQuiet(save: () => void, sinceInput: () => number, clock: Clock = realClock): () => void {
  const start = clock.now()
  let handle: unknown = null
  const tick = () => {
    handle = null
    const quiet = sinceInput()
    const waited = clock.now() - start
    if (quiet < EMBED_QUIET_MS && waited < EMBED_MAX_WAIT_MS) {
      handle = clock.setTimeout(tick, Math.min(EMBED_QUIET_MS - quiet, EMBED_MAX_WAIT_MS - waited))
      return
    }
    save()
  }
  handle = clock.setTimeout(tick, AUTO_EMBED_MS)
  return () => { if (handle !== null) clock.clearTimeout(handle) }
}
