import { describe, expect, it } from 'vitest'
import { extractPageLinks, linkAt, PDFACTION_URI, type LinkBackend } from './links.js'
import { PDFACTION_GOTO } from './outline.js'

interface FakeLink { rect: { left: number; top: number; right: number; bottom: number } | null; dest?: number; action?: { type: number; dest?: number; uri?: string } }

function backend(links: FakeLink[], destPages: Record<number, number> = {}): LinkBackend {
  const actions = new Map<number, NonNullable<FakeLink['action']>>()
  links.forEach((l, i) => { if (l.action) actions.set(100 + i, l.action) })
  return {
    links: () => links.map((_, i) => i + 1),
    rect: (h) => links[h - 1]!.rect,
    dest: (h) => links[h - 1]!.dest ?? 0,
    action: (h) => (links[h - 1]!.action ? 100 + h - 1 : 0),
    actionType: (a) => actions.get(a)!.type,
    actionDest: (a) => actions.get(a)!.dest ?? 0,
    destPage: (d) => destPages[d] ?? -1,
    uri: (a) => actions.get(a)!.uri ?? '',
    // A 1000 x 500 box with an origin-centred crop, as real sheets have.
    pageBox: () => ({ left: -500, bottom: -250, right: 500, top: 250 }),
  }
}

describe('extractPageLinks', () => {
  it('reads a direct destination, a GoTo action and a web link, normalized y down', () => {
    const out = extractPageLinks(backend([
      { rect: { left: -500, top: 250, right: -400, bottom: 200 }, dest: 7 },
      { rect: { left: 0, top: 0, right: 100, bottom: -50 }, action: { type: PDFACTION_GOTO, dest: 8 } },
      { rect: { left: 400, top: -200, right: 500, bottom: -250 }, action: { type: PDFACTION_URI, uri: 'https://example.com/spec' } },
    ], { 7: 3, 8: 0 }), 1, 10)
    expect(out).toEqual([
      { rect: { x0: 0, y0: 0, x1: 0.1, y1: 0.1 }, page: 3 },
      { rect: { x0: 0.5, y0: 0.5, x1: 0.6, y1: 0.6 }, page: 0 },
      { rect: { x0: 0.9, y0: 0.9, x1: 1, y1: 1 }, uri: 'https://example.com/spec' },
    ])
  })

  it('leaves out links that go nowhere this app can follow', () => {
    const out = extractPageLinks(backend([
      { rect: null, dest: 7 },
      { rect: { left: 0, top: 0, right: 0, bottom: 0 }, dest: 7 },
      { rect: { left: 0, top: 10, right: 10, bottom: 0 }, dest: 9 },
      { rect: { left: 0, top: 10, right: 10, bottom: 0 }, action: { type: PDFACTION_URI, uri: 'javascript:alert(1)' } },
      { rect: { left: 0, top: 10, right: 10, bottom: 0 }, action: { type: 2 } },
      { rect: { left: 0, top: 10, right: 10, bottom: 0 }, dest: 7 },
    ], { 7: 4, 9: 99 }), 1, 10)
    expect(out).toHaveLength(1)
    expect(out[0]!.page).toBe(4)
  })
})

describe('linkAt', () => {
  it('picks the smallest link under the point', () => {
    const big = { rect: { x0: 0, y0: 0, x1: 1, y1: 1 }, page: 1 }
    const small = { rect: { x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 }, page: 2 }
    expect(linkAt([big, small], { x: 0.5, y: 0.5 })).toBe(small)
    expect(linkAt([big, small], { x: 0.1, y: 0.1 })).toBe(big)
    expect(linkAt([small], { x: 0.1, y: 0.1 })).toBeNull()
  })
})
