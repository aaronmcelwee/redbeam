import { describe, expect, it } from 'vitest'
import { noteFromAgent, noteStyle, refitLeaderText } from './agentNotes.js'
import { defaultNoteContent } from '../tools/noteGeometry.js'

const page = { width: 1000, height: 800 }
const fixed = () => (s: string) => s.length * 6

describe('an agent adds a comment markup', () => {
  it('makes a text box from a rect', () => {
    const out = noteFromAgent({ shape: 'text', rect: { x0: 0.1, y0: 0.2, x1: 0.3, y1: 0.25 }, text: 'Verify ceiling height', color: 'blue' }, page)
    if ('error' in out) throw new Error(out.error)
    expect(out.rings).toEqual([[{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.2 }, { x: 0.3, y: 0.25 }, { x: 0.1, y: 0.25 }]])
    expect(out.content).toMatchObject({ shape: 'text', text: 'Verify ceiling height', color: '#1f6fd6' })
  })

  it('puts a leader\'s text box at its tail, sized to the text', () => {
    const out = noteFromAgent({ shape: 'arrow', points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.4 }], text: 'abcdefghij' }, page, fixed)
    if ('error' in out) throw new Error(out.error)
    expect(out.rings[0]).toEqual([{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.4 }])
    const box = out.rings[1]!
    expect(box[0]!.x).toBeCloseTo(0.6)
    expect(box[1]!.x).toBeGreaterThan(0.6)
    expect(out.content.ends).toEqual(['arrow', 'none'])
  })

  it('runs a Cloud+ leader from the nearest point on the cloud', () => {
    const out = noteFromAgent({ shape: 'callout', rect: { x0: 0.2, y0: 0.2, x1: 0.4, y1: 0.4 }, tail: { x: 0.6, y: 0.3 }, text: 'Revise' }, page, fixed)
    if ('error' in out) throw new Error(out.error)
    expect(out.rings).toHaveLength(3)
    expect(out.rings[1]![0]).toEqual({ x: 0.4, y: 0.3 })
    expect(out.rings[1]![1]).toEqual({ x: 0.6, y: 0.3 })
  })

  it('says what each shape needs', () => {
    expect(noteFromAgent({ shape: 'star' }, page)).toMatchObject({ error: expect.stringContaining('shape must be one of') })
    expect(noteFromAgent({ shape: 'text', rect: { x0: 0, y0: 0, x1: 0.1, y1: 0.1 } }, page)).toEqual({ error: 'a text box needs `text`' })
    expect(noteFromAgent({ shape: 'line', points: [{ x: 0, y: 0 }] }, page)).toEqual({ error: 'a line needs points [start, end]' })
    expect(noteFromAgent({ shape: 'rect', rect: { x0: 0, y0: 0, x1: 0.1, y1: 0.1 }, text: 'x' }, page)).toMatchObject({ error: expect.stringContaining('carries no text') })
    expect(noteFromAgent({ shape: 'cloud', points: [{ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 0, y: 1 }] }, page)).toMatchObject({ error: expect.stringContaining('points must be') })
  })
})

describe('an agent restyles a comment markup', () => {
  it('changes only what is given, and checks it', () => {
    const base = defaultNoteContent('cloud')
    const out = noteStyle({ color: '#00AA00', width: 3, fill: 'none' }, base)
    expect(out).toMatchObject({ color: '#00aa00', width: 3, fill: null, shape: 'cloud' })
    expect(noteStyle({ width: 99 }, base)).toMatchObject({ error: expect.stringContaining('width') })
    expect(noteStyle({ ends: ['arrow'] }, base)).toMatchObject({ error: expect.stringContaining('ends') })
  })

  it('refits a leader\'s box to new text, and leaves other shapes alone', () => {
    const made = noteFromAgent({ shape: 'arrow', points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.4 }], text: 'ab' }, page, fixed)
    if ('error' in made) throw new Error(made.error)
    const longer = { ...made.content, text: 'a much longer comment' }
    const refit = refitLeaderText(made.rings, longer, page, fixed)
    expect(refit[1]![1]!.x).toBeGreaterThan(made.rings[1]![1]!.x)
    const rect = noteFromAgent({ shape: 'rect', rect: { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 } }, page)
    if ('error' in rect) throw new Error(rect.error)
    expect(refitLeaderText(rect.rings, rect.content, page)).toBe(rect.rings)
  })
})
