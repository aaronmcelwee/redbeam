/**
 * Aaron, 2026-11-24: "agent actions should NEVER steal focus, from other
 * apps or even within the app."
 */
import { afterEach, describe, expect, it } from 'vitest'
import { keepingFocus, movesFocus, PERSON_MS, restoreFocus, SETTLE_MS } from './focusGuard.js'

/** A document with just enough of focus to move it around. */
function fakeDoc() {
  const listeners = new Map<string, Set<(e: Event) => void>>()
  const body = { tagName: 'BODY' } as unknown as Element
  const doc = {
    activeElement: body as Element | null,
    body,
    addEventListener: (type: string, fn: (e: Event) => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn) },
    removeEventListener: (type: string, fn: (e: Event) => void) => { listeners.get(type)?.delete(fn) },
  }
  const fire = (type: string, e: Record<string, unknown> = {}) => { for (const fn of [...(listeners.get(type) ?? [])]) fn({ type, isTrusted: true, ...e } as unknown as Event) }
  const field = (name: string) => {
    const el = {
      tagName: 'INPUT', name, isConnected: true,
      focus: () => { doc.activeElement = el as unknown as Element; fire('focusin') },
      blur: () => { if (doc.activeElement === (el as unknown as Element)) doc.activeElement = body },
    }
    return el as unknown as Element & { focus: () => void; blur: () => void; isConnected: boolean }
  }
  return { doc, fire, field, count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0) }
}

/**
 * Timers the test runs by hand. Every clock is run out after its test: the
 * guard counts the actions still settling across the whole window, so one
 * left unsettled would hold the next test's focus to this test's field.
 */
const clocks: Array<{ advance: (ms: number) => void }> = []
afterEach(() => { for (const c of clocks.splice(0)) c.advance(10 * SETTLE_MS) })
function clock() {
  const c = makeClock()
  clocks.push(c)
  return c
}
function makeClock() {
  let t = 0
  const due: Array<{ at: number; fn: () => void }> = []
  return {
    now: () => t,
    later: (fn: () => void, ms: number) => { due.push({ at: t + ms, fn }) },
    advance: (ms: number) => { t += ms; for (const d of due.splice(0).filter((x) => (x.at <= t ? (x.fn(), false) : true))) due.push(d) },
  }
}

describe('restoring focus', () => {
  it('puts focus back where it was', () => {
    const { doc, field } = fakeDoc()
    const mine = field('length'), theirs = field('scope name')
    mine.focus()
    theirs.focus()
    expect(restoreFocus(doc, mine)).toBe(true)
    expect(doc.activeElement).toBe(mine)
    expect(restoreFocus(doc, mine)).toBe(false)
  })
  it('blurs whatever took focus when nothing had it, so the drawing keys still work', () => {
    const { doc, field } = fakeDoc()
    field('search').focus()
    expect(restoreFocus(doc, doc.body)).toBe(true)
    expect(doc.activeElement).toBe(doc.body)
  })
  it('blurs the newcomer when what had focus is no longer on the page', () => {
    const { doc, field } = fakeDoc()
    const gone = field('gone')
    gone.isConnected = false
    field('new').focus()
    restoreFocus(doc, gone)
    expect(doc.activeElement).toBe(doc.body)
  })
})

describe('what counts as the person moving focus', () => {
  it('a click, a shortcut, Tab and Escape do', () => {
    expect(movesFocus({ type: 'pointerdown' })).toBe(true)
    expect(movesFocus({ type: 'keydown', key: 'f', ctrlKey: true, target: { tagName: 'INPUT' } })).toBe(true)
    expect(movesFocus({ type: 'keydown', key: 'Tab', target: { tagName: 'INPUT' } })).toBe(true)
    expect(movesFocus({ type: 'keydown', key: 'Escape', target: { tagName: 'INPUT' } })).toBe(true)
    // A bare letter on the drawing is a tool shortcut.
    expect(movesFocus({ type: 'keydown', key: 'a', target: { tagName: 'BODY' } })).toBe(true)
  })
  it('typing into a field does not', () => {
    expect(movesFocus({ type: 'keydown', key: '4', target: { tagName: 'INPUT' } })).toBe(false)
    expect(movesFocus({ type: 'keydown', key: 'Backspace', target: { tagName: 'TEXTAREA' } })).toBe(false)
    expect(movesFocus({ type: 'keydown', key: 'x', target: { isContentEditable: true } })).toBe(false)
  })
})

describe('an agent acting while the person types', () => {
  it('gives the caret back when the action opens a field', async () => {
    const { doc, field } = fakeDoc()
    const c = clock()
    const mine = field('length')
    mine.focus()
    const opened = field('scope name')
    await keepingFocus(async () => { opened.focus() }, doc, c.later, c.now)
    expect(doc.activeElement).toBe(mine)
  })
  it('gives it back when the field mounts a frame later, and while the person keeps typing', async () => {
    const { doc, field, fire } = fakeDoc()
    const c = clock()
    const mine = field('length')
    mine.focus()
    const opened = field('scope name')
    await keepingFocus(async () => undefined, doc, c.later, c.now)
    fire('keydown', { key: '1', target: mine })
    c.advance(40)
    opened.focus()
    expect(doc.activeElement).toBe(mine)
  })
  it('leaves focus where the person themselves just put it', async () => {
    const { doc, field, fire } = fakeDoc()
    const c = clock()
    const mine = field('length')
    mine.focus()
    const clicked = field('search')
    await keepingFocus(async () => {
      fire('pointerdown')
      clicked.focus()
    }, doc, c.later, c.now)
    expect(doc.activeElement).toBe(clicked)
    // And that is now what is kept: an agent's late panel does not take it either.
    c.advance(PERSON_MS + 20)
    field('scope name').focus()
    expect(doc.activeElement).toBe(clicked)
  })
  it('restores to what the person had when two agents act at once', async () => {
    const { doc, field } = fakeDoc()
    const c = clock()
    const mine = field('length')
    mine.focus()
    const one = field('one'), two = field('two')
    let release = (): void => undefined
    const first = keepingFocus(() => new Promise<void>((r) => { release = () => { one.focus(); r() } }), doc, c.later, c.now)
    const second = keepingFocus(async () => { two.focus() }, doc, c.later, c.now)
    await second
    release()
    await first
    expect(doc.activeElement).toBe(mine)
  })
  it('stops listening once the action has settled', async () => {
    const { doc, field, count } = fakeDoc()
    const c = clock()
    field('length').focus()
    await keepingFocus(async () => undefined, doc, c.later, c.now)
    expect(count()).toBeGreaterThan(0)
    c.advance(SETTLE_MS + 1)
    expect(count()).toBe(0)
    // After that, focus is the person's to move as ever.
    const next = field('next')
    next.focus()
    expect(doc.activeElement).toBe(next)
  })
  it('gives the action its answer, and its error', async () => {
    const { doc } = fakeDoc()
    const c = clock()
    expect(await keepingFocus(async () => 7, doc, c.later, c.now)).toBe(7)
    await expect(keepingFocus(async () => { throw new Error('no') }, doc, c.later, c.now)).rejects.toThrow('no')
  })
})
