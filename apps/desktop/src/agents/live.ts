/**
 * Which PDFs are kept live behind the one showing.
 *
 * The person's own tabs hold nothing while they are not showing: leaving one
 * saves it into its PDF and lets its viewer and store go (lightTabs.ts). An
 * agent's tab cannot work that way, because the agent is working in it while
 * the person looks at something else, so it stays mounted in the background.
 *
 * A PDF live in the background costs what an open PDF costs: a PDFium worker
 * with the file in it and the takeoff's store. So they are not kept forever.
 * One that no call has touched for a while is saved and let go, and when
 * more are live than the window should carry, the ones used longest ago go
 * first. Its tab stays; the next call for it opens it again from its file.
 */

/** Most PDFs live in the background at once. Each is a drawing set in memory. */
export const LIVE_LIMIT = 6
/** A background PDF nobody has called for this long is saved and let go. */
export const IDLE_SLEEP_MS = 10 * 60_000

export interface LiveUse {
  file: string
  /** Epoch ms of the last call for it, or of when it was opened. */
  usedAt: number
}

/**
 * The background PDFs to let go now, least recently used first. Never one
 * with a call running in it: that would take the call's answer with it.
 */
export function sleepers(
  live: readonly LiveUse[],
  opts: { now: number; busy: (file: string) => boolean; limit?: number; idleMs?: number },
): string[] {
  const limit = opts.limit ?? LIVE_LIMIT
  const idleMs = opts.idleMs ?? IDLE_SLEEP_MS
  const free = live.filter((l) => !opts.busy(l.file)).sort((a, b) => a.usedAt - b.usedAt)
  const out: string[] = []
  let count = live.length
  for (const l of free) {
    const idle = opts.now - l.usedAt >= idleMs
    if (!idle && count <= limit) continue
    out.push(l.file)
    count--
  }
  return out
}
