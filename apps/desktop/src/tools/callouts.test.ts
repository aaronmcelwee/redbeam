import { describe, expect, it } from 'vitest'
import { findCallouts, type Word } from './callouts.js'
import type { Markup } from '@redbeam/domain'
import { linkContentOf, pageLinksFrom, sheetKey, suggestTargets } from './links.js'

const sheets = [
  { page: 0, number: 'A1.01' },
  { page: 1, number: 'A5.01' },
  { page: 2, number: 'A101' },
  { page: 3, number: 'Page 4' },
]
// A word about 1% of the sheet tall at (x, y).
const w = (text: string, x: number, y: number, width = 0.03): Word => ({ text, x0: x, y0: y, x1: x + width, y1: y + 0.01 })

describe('finding detail callouts', () => {
  it('a detail number over a sheet number is a ticked callout, boxed with both', () => {
    const found = findCallouts(0, [w('3', 0.505, 0.49, 0.01), w('A5.01', 0.5, 0.502)], sheets)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ page: 0, toPage: 1, text: '3/A5.01', detail: '3', kind: 'callout', checked: true })
    expect(found[0]!.rect.y0).toBeLessThan(0.49)
  })

  it('reads "3/A5.01" written on one line', () => {
    expect(findCallouts(0, [w('3/A5.01', 0.2, 0.2)], sheets)[0]).toMatchObject({ toPage: 1, detail: '3', kind: 'callout' })
  })

  it('a bare distinctive number is ticked; a short one that could be a room waits', () => {
    const found = findCallouts(0, [w('A5.01', 0.1, 0.1), w('A101', 0.6, 0.6)], sheets)
    expect(found.map((c) => [c.text, c.kind, c.checked])).toEqual([['A5.01', 'mention', true], ['A101', 'mention', false]])
  })

  it('skips the sheet\'s own number, guessed numbers, and references already linked', () => {
    expect(findCallouts(0, [w('A1.01', 0.9, 0.9), w('Page', 0.1, 0.1)], sheets)).toEqual([])
    expect(findCallouts(0, [w('A5.01', 0.5, 0.5)], sheets, [{ x0: 0.49, y0: 0.49, x1: 0.6, y1: 0.6 }])).toEqual([])
  })

  it('a number two sheets share goes nowhere', () => {
    const dup = [...sheets, { page: 5, number: 'A5.01' }]
    expect(findCallouts(0, [w('A5.01', 0.5, 0.5)], dup)).toEqual([])
  })

  it('case, spaces and trailing punctuation do not matter', () => {
    expect(sheetKey(' a5.01. ')).toBe('A5.01')
    expect(findCallouts(0, [w('(a5.01)', 0.5, 0.5)], sheets)).toHaveLength(1)
  })
})

describe('links', () => {
  it('a box over a sheet number suggests that sheet first', () => {
    expect(suggestTargets([{ text: '3' }, { text: 'A5.01' }], sheets, 0)).toEqual([1])
    expect(suggestTargets([{ text: 'A1.01' }], sheets, 0)).toEqual([])
  })

  it('link markups on this sheet follow like the PDF\'s own', () => {
    const m: Markup & { content: Record<string, unknown> } = {
      id: 'l1', scopeId: null, documentId: 'd', pageId: 'd-p0', kind: 'link' as const,
      rings: [[{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.1, y: 0.2 }]],
      content: { toPage: 1, source: 'drawn' },
    }
    expect(linkContentOf(m)).toEqual({ toPage: 1, source: 'drawn' })
    expect(pageLinksFrom([m], 'd-p0')).toEqual([{ rect: { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 }, page: 1 }])
    expect(pageLinksFrom([m], 'd-p1')).toEqual([])
    expect(linkContentOf({ ...m, content: { toPage: -1, source: 'drawn' } } as Markup)).toBeNull()
  })
})
