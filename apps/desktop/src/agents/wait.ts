/**
 * Waiting for the window to catch up, without waiting on a clock.
 *
 * An agent's call often has to wait for something the window does a moment
 * later: React committing the scope a write just made, a workspace mounting,
 * the layout worker answering. Those waits were `setTimeout` loops, 25 to 150
 * ms a turn, and that is slow twice over:
 *
 *  - the thing waited for is usually there within a millisecond or two, and
 *    the call sat out the rest of the turn regardless;
 *  - REDBEAM is usually BEHIND the AI app while an agent works, and a webview
 *    that is covered or minimized has its timers slowed to one a second (and
 *    later one a minute). A 25 ms turn became a second, on every call.
 *
 * `until` looks again after every task the window runs, so it answers as soon
 * as the condition holds. A MessageChannel task is not a timer and is not
 * slowed in a hidden window. After a short spell of that it eases off to a
 * tick every few milliseconds from a worker, whose clock is not slowed
 * either, so a long wait (a layout of a big scope) does not spin a core.
 */

/** How long `until` looks again after every task before easing off to ticks. */
const EAGER_MS = 40
/** The tick it eases off to. */
const TICK_MS = 8

let channel: MessageChannel | null = null
const waitingForTask: Array<() => void> = []

/** Resolve after the tasks already queued have run. Not a timer: a hidden window does not slow it. */
export function nextTask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise((r) => setTimeout(r, 0))
  if (channel === null) {
    channel = new MessageChannel()
    channel.port1.onmessage = () => { waitingForTask.shift()?.() }
    // In Node (tests) an open port would keep the process alive.
    ;(channel.port1 as unknown as { unref?: () => void }).unref?.()
    ;(channel.port2 as unknown as { unref?: () => void }).unref?.()
  }
  return new Promise((resolve) => {
    waitingForTask.push(resolve)
    channel!.port2.postMessage(0)
  })
}

let ticker: Worker | null | undefined
let nextTick = 0
const waitingForTick = new Map<number, () => void>()

function tickWorker(): Worker | null {
  if (ticker !== undefined) return ticker
  ticker = null
  try {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null
    const src = 'onmessage = (e) => { setTimeout(() => postMessage(e.data[0]), e.data[1]) }'
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    w.onmessage = (e: MessageEvent<number>) => {
      const go = waitingForTick.get(e.data)
      waitingForTick.delete(e.data)
      go?.()
    }
    w.onerror = () => {
      // No worker after all: let everyone waiting go, and use the window's own clock from here.
      ticker = null
      for (const go of waitingForTick.values()) go()
      waitingForTick.clear()
    }
    ticker = w
  } catch {
    ticker = null
  }
  return ticker
}

/** Resolve in about `ms`, on a clock a hidden window does not slow. */
export function pause(ms: number): Promise<void> {
  const w = tickWorker()
  if (w === null) return new Promise((r) => setTimeout(r, ms))
  return new Promise((resolve) => {
    const id = ++nextTick
    waitingForTick.set(id, resolve)
    w.postMessage([id, ms])
  })
}

/**
 * Wait until `ready()` is true, for at most `maxMs`. Resolves true as soon as
 * it holds, false when the time is up. `maxMs` is how long the caller is
 * prepared to wait for an answer, not a limit on the work being waited for.
 */
export async function until(ready: () => boolean, maxMs: number, now: () => number = () => performance.now()): Promise<boolean> {
  if (ready()) return true
  const started = now()
  for (;;) {
    const waited = now() - started
    if (waited >= maxMs) return ready()
    if (waited < EAGER_MS) await nextTask()
    else await pause(Math.min(TICK_MS, maxMs - waited))
    if (ready()) return true
  }
}
