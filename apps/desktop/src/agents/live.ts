/**
 * Which PDFs are kept live behind the one showing.
 *
 * The person's own tabs hold nothing while they are not showing: leaving one
 * saves it into its PDF and lets its viewer and store go (lightTabs.ts). An
 * agent's tab cannot work that way, because the agent is working in it while
 * the person looks at something else, so it stays mounted in the background.
 *
 * A PDF live in the background costs what an open PDF costs: a PDFium worker
 * with the file in it and the takeoff's store. So one that nobody is using
 * any more is saved and let go. Its tab stays; the next call for it opens it
 * again from its file.
 *
 * "Nobody is using" means no live session has it: not one that drives it and
 * not one that is a guest in it. There is no count of how many may be live.
 * There was (six), and ten sessions at once had their PDFs unloaded under
 * them between calls: "no document is open", scales gone, markups written to
 * a store that had just been let go (SLS benchmark, 2026-11-25). A session
 * thinking for ten minutes between calls is still working in its PDF.
 */

/** A background PDF no live session has, and nobody has called for this long, is saved and let go. */
export const IDLE_SLEEP_MS = 10 * 60_000

export interface LiveUse {
  file: string
  /** Epoch ms of the last call for it, or of when it was opened. */
  usedAt: number
}

/**
 * The background PDFs to let go now, least recently used first. Never one a
 * live session has (`held`), and never one with a call running in it: that
 * would take the call's answer with it.
 */
export function sleepers(
  live: readonly LiveUse[],
  opts: { now: number; busy: (file: string) => boolean; held: (file: string) => boolean; idleMs?: number },
): string[] {
  const idleMs = opts.idleMs ?? IDLE_SLEEP_MS
  return live
    .filter((l) => !opts.busy(l.file) && !opts.held(l.file) && opts.now - l.usedAt >= idleMs)
    .sort((a, b) => a.usedAt - b.usedAt)
    .map((l) => l.file)
}
