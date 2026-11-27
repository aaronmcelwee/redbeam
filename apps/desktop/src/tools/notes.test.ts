import { describe, expect, it } from 'vitest'
import { pointInPolygon } from '@redbeam/domain'
import {
  boxRing, cloudOutline, defaultNoteContent, emptyNoteDraft, hitTestNote, noteBack, noteDown, noteFinish,
  leaderTextSize, noteMove, noteUp, parseNoteContent, simplifyStroke, wrapLines, type NoteLike,
} from './notes.js'

const view = { zoom: 1, ox: 0, oy: 0, vw: 100, vh: 100 }

describe('note content', () => {
  it('fills what a row is missing from the shape defaults', () => {
    const c = parseNoteContent({ shape: 'arrow', color: '#00ff00' })!
    expect(c.color).toBe('#00ff00')
    expect(c.ends).toEqual(['arrow', 'none'])
    expect(c.width).toBe(1.5)
  })
  it('refuses a row that is not a note', () => {
    expect(parseNoteContent({ shape: 'banana' })).toBeNull()
    expect(parseNoteContent(null)).toBeNull()
  })
  it('keeps a text box without fill', () => {
    expect(parseNoteContent({ shape: 'text', fill: null })!.fill).toBeNull()
  })
})

describe('cloud outline', () => {
  for (const [name, ring] of [
    ['clockwise', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }]],
    ['counter-clockwise', [{ x: 0, y: 0 }, { x: 0, y: 60 }, { x: 100, y: 60 }, { x: 100, y: 0 }]],
  ] as const) {
    it(`bulges outward on a ${name} ring`, () => {
      const out = cloudOutline(ring, 8)
      expect(out.length).toBeGreaterThan(40)
      // Every scallop's crest is outside the ring, none inside it.
      const inside = out.filter((p) => pointInPolygon(p, [
        { x: 0.5, y: 0.5 }, { x: 99.5, y: 0.5 }, { x: 99.5, y: 59.5 }, { x: 0.5, y: 59.5 },
      ]))
      expect(inside).toEqual([])
    })
  }
})

describe('note drafts', () => {
  it('drags a rectangle', () => {
    let d = noteDown(emptyNoteDraft('rect'), { x: 0.1, y: 0.1 })
    d = noteMove(d, { x: 0.3, y: 0.2 })
    const s = noteUp(d, { x: 0.3, y: 0.2 }, { dragged: true })
    expect(s.rings).toEqual([boxRing({ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.2 })])
  })
  it('places a text box with a click', () => {
    const s = noteUp(noteDown(emptyNoteDraft('text'), { x: 0.5, y: 0.5 }), { x: 0.5, y: 0.5 }, { dragged: false, textBox: { w: 0.1, h: 0.05 } })
    expect(s.rings![0]![2]).toEqual({ x: 0.6, y: 0.55 })
  })
  it('draws a leader by drag or by two clicks, with its text box at the tail', () => {
    const tb = { w: 0.2, h: 0.1 }
    const drag = noteUp(noteDown(emptyNoteDraft('arrow'), { x: 0, y: 0 }), { x: 1, y: 1 }, { dragged: true, textBox: tb })
    expect(drag.rings![0]).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }])
    // The tail is halfway down the box's near side; the box runs on away from the head.
    expect(drag.rings![1]).toEqual(boxRing({ x: 1, y: 0.95 }, { x: 1.2, y: 1.05 }))
    let s = noteUp(noteDown(emptyNoteDraft('arrow'), { x: 1, y: 0 }), { x: 1, y: 0 }, { dragged: false, textBox: tb })
    expect(s.rings).toBeNull()
    s = noteUp(noteDown(s.draft, { x: 0.5, y: 0 }), { x: 0.5, y: 0 }, { dragged: false, textBox: tb })
    expect(s.rings![0]).toEqual([{ x: 1, y: 0 }, { x: 0.5, y: 0 }])
    expect(s.rings![1]![1]).toEqual({ x: 0.5, y: -0.05 })
  })
  it('draws a plain line with no text box', () => {
    const s = noteUp(noteDown(emptyNoteDraft('line'), { x: 0, y: 0 }), { x: 1, y: 1 }, { dragged: true })
    expect(s.rings).toEqual([[{ x: 0, y: 0 }, { x: 1, y: 1 }]])
  })
  it('clicks a cloud and finishes it on the first corner or Enter', () => {
    let d = emptyNoteDraft('cloud')
    for (const p of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]) d = noteUp(noteDown(d, p), p, { dragged: false }).draft
    expect(noteFinish(d).rings).toEqual([[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]])
    expect(noteUp(noteDown(d, { x: 0, y: 0 }), { x: 0, y: 0 }, { dragged: false, closes: true }).rings![0]).toHaveLength(3)
    expect(noteBack(d).points).toHaveLength(2)
  })
  it('points a cloud+ leader at the nearest edge of its cloud, text where you click', () => {
    let s = noteUp(noteDown(emptyNoteDraft('callout'), { x: 0.2, y: 0.2 }), { x: 0.4, y: 0.4 }, { dragged: true })
    expect(s.rings).toBeNull()
    expect(s.draft.cloud).toHaveLength(4)
    s = noteUp(noteDown(s.draft, { x: 0.6, y: 0.3 }), { x: 0.6, y: 0.3 }, { dragged: false, textBox: { w: 0.1, h: 0.04 } })
    expect(s.rings![1]).toEqual([{ x: 0.4, y: 0.3 }, { x: 0.6, y: 0.3 }])
    expect(s.rings![2]![0]!.x).toBe(0.6)
    expect(s.rings![2]![0]!.y).toBeCloseTo(0.28)
  })
  it('keeps a pen stroke, thinned', () => {
    let d = noteDown(emptyNoteDraft('pen'), { x: 0, y: 0 })
    for (let i = 1; i <= 10; i++) d = noteMove(d, { x: i / 10, y: 0 })
    const s = noteUp(d, { x: 1, y: 0 }, { dragged: true, simplify: 0.001 })
    expect(s.rings![0]).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }])
  })
})

describe('note hit-testing', () => {
  const note = (shape: NoteLike['content']['shape'], rings: NoteLike['rings']): NoteLike =>
    ({ id: shape, rings, content: defaultNoteContent(shape) })
  it('resizes a box by its edge and moves it from inside', () => {
    const n = note('rect', [boxRing({ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 })])
    expect(hitTestNote(30, 10, [n], view, 100, 100)).toEqual({ markupId: 'rect', part: 'edge', index: 0 })
    expect(hitTestNote(30, 30, [n], view, 100, 100)?.part).toBe('inside')
    expect(hitTestNote(80, 80, [n], view, 100, 100)).toBeNull()
  })
  it('grabs a leader by its head and its text, not by its tail', () => {
    const c = { ...defaultNoteContent('arrow'), text: 'Note' }
    const n: NoteLike = { id: 'a', rings: [[{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }], boxRing({ x: 0.5, y: 0.45 }, { x: 0.8, y: 0.55 })], content: c }
    expect(hitTestNote(10, 10, [n], view, 100, 100)).toEqual({ markupId: 'a', part: 'vertex', index: 0 })
    expect(hitTestNote(50, 50, [n], view, 100, 100)?.part).toBe('inside')
    expect(hitTestNote(70, 50, [n], view, 100, 100)?.part).toBe('inside')
    // Without text the box is not there to grab.
    expect(hitTestNote(70, 50, [{ ...n, content: { ...c, text: '' } }], view, 100, 100)).toBeNull()
  })
  it('fits a leader\'s text box to its text', () => {
    const size = leaderTextSize('abcd', 10, (s) => s.length * 5)
    expect(size.w).toBe(20 + 8 + 1)
    expect(size.h).toBeCloseTo(12 + 8)
    expect(leaderTextSize('x '.repeat(100), 10, (s) => s.length * 5).w).toBeLessThanOrEqual(180)
  })
  it('grabs a line by its ends', () => {
    const n = note('line', [[{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }]])
    expect(hitTestNote(90, 10, [n], view, 100, 100)).toEqual({ markupId: 'line', part: 'vertex', index: 1 })
    expect(hitTestNote(50, 11, [n], view, 100, 100)?.part).toBe('inside')
  })
})

describe('text wrap', () => {
  it('breaks at spaces and at line breaks', () => {
    expect(wrapLines('one two three\nfour', 7, (s) => s.length)).toEqual(['one two', 'three', 'four'])
  })
  it('simplify keeps the ends', () => {
    expect(simplifyStroke([{ x: 0, y: 0 }], 1)).toEqual([{ x: 0, y: 0 }])
  })
})
