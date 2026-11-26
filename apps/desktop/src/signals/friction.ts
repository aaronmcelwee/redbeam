/**
 * Friction the window can see for itself, without any feature telling it.
 *
 *  - A control clicked again and again in a moment ("rage-click"): it did not
 *    seem to do anything, or did it too slowly to see.
 *  - A dialog that came up and went away without anything in it being used
 *    ("dialog-dismissed"): it was in the way, or it asked the wrong thing.
 *
 * Read from the DOM with two capture listeners and a one-second look at the
 * open dialogs, so it costs nothing while the person draws (the sheet is a
 * canvas, not controls) and never touches focus or stops an event.
 *
 * What is recorded about a control is its label as the person sees it
 * ("Calibrate", "Save a copy"), run through the scrubber. Rows of a list or
 * tabs of a strip carry file and sheet names, so those are named by their
 * list's label instead, never their own text.
 */

const CONTROL = 'button,[role=button],[role=tab],[role=menuitem],[role=menuitemradio],[role=option],[role=switch],[role=checkbox],a[href],summary'
const LISTISH = '[role=tablist],[role=list],[role=listbox],[role=tree],[role=grid],[role=menu],ul,ol,table'
/** Controls that are meant to be pressed repeatedly. */
const STEPPER = /\b(zoom|next|previous|prev|back|forward|up|down|increase|decrease|more|less|rotate|step)\b|[+−-]$/i
const CANCEL = /^(cancel|close|not now|dismiss|no|skip|later|×|x|✕)$/i

export const RAGE_CLICKS = 4
export const RAGE_WINDOW_MS = 1500

function attr(el: Element, name: string): string {
  return (el.getAttribute(name) ?? '').trim()
}

function ownText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** The words a person would use for a control, or for the list it sits in. */
export function controlLabel(el: Element): string {
  const tagged = el.closest('[data-signal]')
  if (tagged !== null) return attr(tagged, 'data-signal')
  const list = el.parentElement?.closest(LISTISH) ?? null
  if (list !== null) {
    const name = attr(list, 'aria-label') || attr(list, 'data-signal') || (list.id !== '' ? list.id : list.tagName.toLowerCase())
    return `${name} item`
  }
  const words = attr(el, 'aria-label') || attr(el, 'title') || ownText(el)
  return words.slice(0, 60) || el.tagName.toLowerCase()
}

export function dialogLabel(el: Element): string {
  const tagged = attr(el, 'data-signal')
  if (tagged !== '') return tagged
  const label = attr(el, 'aria-label')
  if (label !== '') return label
  const by = attr(el, 'aria-labelledby')
  const titled = by === '' ? null : el.ownerDocument.getElementById(by.split(/\s+/)[0] ?? '')
  if (titled !== null) return ownText(titled).slice(0, 60)
  return (el.className && typeof el.className === 'string' ? el.className.split(/\s+/)[0] : '') || 'dialog'
}

/** Counts clicks on one control; says when a burst reaches rage. Pure, for tests. */
export class ClickBurst {
  private label = ''
  private times: number[] = []
  private fired = false

  /** True on the click that makes this a rage-click, once per burst. */
  click(label: string, at: number): boolean {
    if (label !== this.label) { this.label = label; this.times = []; this.fired = false }
    this.times = this.times.filter((t) => at - t < RAGE_WINDOW_MS)
    this.times.push(at)
    if (this.times.length === 1) this.fired = false
    if (!this.fired && this.times.length >= RAGE_CLICKS) { this.fired = true; return true }
    return false
  }
}

export interface FrictionSink {
  (name: 'rage-click' | 'dialog-dismissed', detail: string, ms: number | null): void
}

/** Start watching. Returns the stop. */
export function watchFriction(doc: Document, sink: FrictionSink, now: () => number = () => performance.now()): () => void {
  const burst = new ClickBurst()
  const open = new Map<Element, { label: string; at: number; used: boolean }>()

  const onPointer = (e: Event) => {
    const t = e.target instanceof Element ? e.target.closest(CONTROL) : null
    if (t === null) return
    const label = controlLabel(t)
    if (STEPPER.test(label)) return
    if (burst.click(label, now())) sink('rage-click', label, null)
  }

  const markUsed = (e: Event) => {
    const t = e.target instanceof Element ? e.target : null
    const dialog = t?.closest('[role=dialog]') ?? null
    if (dialog === null) return
    const entry = open.get(dialog)
    if (entry === undefined) return
    if (e.type === 'click') {
      const control = t?.closest(CONTROL) ?? null
      if (control === null) return
      const words = (attr(control, 'aria-label') || ownText(control)).trim()
      if (CANCEL.test(words)) return
    }
    entry.used = true
  }

  const look = () => {
    if (doc.visibilityState === 'hidden') return
    const seen = new Set<Element>()
    for (const d of doc.querySelectorAll('[role=dialog]')) {
      seen.add(d)
      if (!open.has(d)) open.set(d, { label: dialogLabel(d), at: now(), used: false })
    }
    for (const [d, entry] of open) {
      if (seen.has(d)) continue
      open.delete(d)
      if (!entry.used) sink('dialog-dismissed', entry.label, now() - entry.at)
    }
  }

  doc.addEventListener('pointerdown', onPointer, { capture: true, passive: true })
  doc.addEventListener('click', markUsed, { capture: true, passive: true })
  doc.addEventListener('input', markUsed, { capture: true, passive: true })
  doc.addEventListener('change', markUsed, { capture: true, passive: true })
  const timer = setInterval(look, 1000)
  return () => {
    clearInterval(timer)
    doc.removeEventListener('pointerdown', onPointer, { capture: true })
    doc.removeEventListener('click', markUsed, { capture: true })
    doc.removeEventListener('input', markUsed, { capture: true })
    doc.removeEventListener('change', markUsed, { capture: true })
  }
}
