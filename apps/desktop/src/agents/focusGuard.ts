/**
 * An agent's action never moves the keyboard.
 *
 * Aaron, 2026-11-24: "agent actions should NEVER steal focus, from other
 * apps or even within the app." An agent's call runs the same handlers a
 * click does, and some of those put the caret somewhere: a new scope opens
 * its name field, Settings focuses its search box. When a person does that
 * it is what they asked for. When an agent does it while the person is
 * typing a length into a dimension, their next keystrokes go into a field
 * they never opened.
 *
 * So focus is noted before an agent's action and put back whenever it moves,
 * for as long as the action's effects take to render — unless the person
 * themselves has just clicked or pressed a shortcut, in which case focus is
 * wherever that put it and stays there.
 */

/** How long after an action its effects may still mount something that takes focus. */
export const SETTLE_MS = 320

interface FocusDoc {
  activeElement: Element | null
  body: Element | null
  addEventListener: (type: string, fn: (e: Event) => void, capture: boolean) => void
  removeEventListener: (type: string, fn: (e: Event) => void, capture: boolean) => void
}

/** What had focus, as something focus can be put back on. */
type Focusable = Element & { focus?: (o?: { preventScroll?: boolean }) => void; blur?: () => void; isConnected?: boolean }

/**
 * Put focus back on `had` if it has moved. When nothing had it (the body),
 * whatever took it is blurred, so the drawing's own keys keep working.
 */
export function restoreFocus(doc: Pick<FocusDoc, 'activeElement' | 'body'>, had: Element | null): boolean {
  const now = doc.activeElement as Focusable | null
  if (now === had) return false
  const was = had as Focusable | null
  if (was !== null && was !== doc.body && was.isConnected !== false && typeof was.focus === 'function') {
    was.focus({ preventScroll: true })
    return true
  }
  if (now !== null && now !== doc.body && typeof now.blur === 'function') {
    now.blur()
    return true
  }
  return false
}

/** How long after a click or a key a focus change is taken to be the person's own doing. */
export const PERSON_MS = 160

/**
 * Whether an input event is one a person moves focus with. A click is. A
 * key is, unless it is a plain character typed into a field: typing moves
 * no focus, and it is exactly while someone types that an agent's panel
 * must not take the caret.
 */
export function movesFocus(e: { type: string; key?: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; target?: unknown }): boolean {
  if (e.type !== 'keydown') return true
  if (e.ctrlKey === true || e.altKey === true || e.metaKey === true) return true
  const key = e.key ?? ''
  const typed = key.length === 1 || key === 'Backspace' || key === 'Delete'
  if (!typed) return true
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined
  const tag = (t?.tagName ?? '').toUpperCase()
  const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable === true
  // A bare letter on the drawing is a shortcut, and a shortcut may open a field.
  return !inField
}

/** Guards running now, so overlapping agent calls restore to what the PERSON had, not to each other's. */
let depth = 0
let held: Element | null = null
let personAt = -Infinity

/**
 * Run an agent's action with the keyboard held where it is.
 * `doc`, `later` and `now` are for the tests; the app passes none.
 */
export async function keepingFocus<T>(
  run: () => Promise<T>,
  doc: FocusDoc | null = typeof document === 'undefined' ? null : (document as unknown as FocusDoc),
  later: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms) },
  now: () => number = () => performance.now(),
): Promise<T> {
  if (doc === null) return run()
  if (depth === 0) {
    held = doc.activeElement
    personAt = -Infinity
  }
  depth++
  const acted = (e: Event) => {
    if (e.isTrusted && movesFocus(e as unknown as Parameters<typeof movesFocus>[0])) personAt = now()
  }
  const moved = () => {
    // The person's own click or shortcut put it there: that is where it now belongs.
    if (now() - personAt <= PERSON_MS) held = doc.activeElement
    else restoreFocus(doc, held)
  }
  doc.addEventListener('pointerdown', acted, true)
  doc.addEventListener('keydown', acted, true)
  doc.addEventListener('focusin', moved, true)
  const done = () => {
    doc.removeEventListener('pointerdown', acted, true)
    doc.removeEventListener('keydown', acted, true)
    doc.removeEventListener('focusin', moved, true)
    depth--
    if (depth === 0) held = null
  }
  const settle = () => { if (now() - personAt > PERSON_MS) restoreFocus(doc, held) }
  try {
    return await run()
  } finally {
    settle()
    // What the action opened mounts on a later frame, and focuses itself then.
    later(() => { settle(); done() }, SETTLE_MS)
  }
}
