import { afterEach, describe, expect, it } from 'vitest'
import type { Scope } from '@redbeam/domain'
import { PASTE_NUDGE, clipOf, pasteStatus, planPaste, readClip, writeClip } from './markupClipboard.js'

const scope = (id: string, label: string, color = '#e2483d', specifications: Record<string, unknown> = {}): Scope =>
  ({ id, label, scopeType: 'area', color, specifications })

const square = [[{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.1, y: 0.2 }]]
const A = { documentId: 'doc-a', pageId: 'doc-a:p1', width: 1000, height: 500 }
let n = 0
const mint = () => `sc-new-${++n}`
const palette = () => '#2f7fd1'

afterEach(() => { writeClip(null); n = 0 })

describe('markup clipboard', () => {
  it('outlives the workspace that wrote it, since each tab is a new one', () => {
    writeClip(clipOf([{ id: 'm1', scopeId: null, kind: 'area', rings: square }], [], A))
    expect(readClip()?.items).toHaveLength(1)
  })

  it('nudges a paste onto the sheet it came from, and keeps the scope', () => {
    const s = scope('s1', 'C-MT-01')
    const clip = clipOf([{ id: 'm1', scopeId: 's1', kind: 'area', rings: square }], [s], A)
    const plan = planPaste(clip, A, [s], mint, palette)
    expect(plan.nudged).toBe(true)
    expect(plan.newScopes).toEqual([])
    expect(plan.markups[0]!.scopeId).toBe('s1')
    expect(plan.markups[0]!.rings[0]![0]!.x).toBeCloseTo(0.1 + PASTE_NUDGE)
  })

  it('lands in place on another sheet of the same size', () => {
    const clip = clipOf([{ id: 'm1', scopeId: null, kind: 'area', rings: square }], [], A)
    const plan = planPaste(clip, { ...A, pageId: 'doc-a:p2' }, [], mint, palette)
    expect(plan.nudged).toBe(false)
    expect(plan.markups[0]!.rings).toEqual(square)
  })

  it('keeps its real size on a sheet of another size', () => {
    const clip = clipOf([{ id: 'm1', scopeId: null, kind: 'polyline', rings: [[{ x: 0.5, y: 0.5 }, { x: 0.9, y: 0.5 }]] }], [], A)
    const plan = planPaste(clip, { documentId: 'doc-b', pageId: 'doc-b:p1', width: 2000, height: 1000 }, [], mint, palette)
    // 400 points long on A; 400 of 2000 points on B.
    expect(plan.markups[0]!.rings[0]![1]!.x - plan.markups[0]!.rings[0]![0]!.x).toBeCloseTo(0.2)
    expect(plan.offSheet).toBe(0)
  })

  it('counts markups that hang off a smaller sheet', () => {
    const clip = clipOf([{ id: 'm1', scopeId: null, kind: 'area', rings: [[{ x: 0.8, y: 0.8 }, { x: 0.9, y: 0.9 }, { x: 0.8, y: 0.9 }]] }], [], A)
    const plan = planPaste(clip, { documentId: 'doc-b', pageId: 'doc-b:p1', width: 500, height: 250 }, [], mint, palette)
    expect(plan.offSheet).toBe(1)
    expect(pasteStatus(plan, true)).toContain('hangs off this sheet')
  })

  it('uses the other PDF\'s scope of the same name, case and spaces aside', () => {
    const clip = clipOf([{ id: 'm1', scopeId: 's1', kind: 'area', rings: square }], [scope('s1', 'C-MT-01')], A)
    const plan = planPaste(clip, { ...A, documentId: 'doc-b', pageId: 'doc-b:p1' }, [scope('b7', ' c-mt-01 ')], mint, palette)
    expect(plan.newScopes).toEqual([])
    expect(plan.markups[0]!.scopeId).toBe('b7')
  })

  it('makes one copy of a scope the other PDF lacks, without the old file\'s per-markup settings', () => {
    const s = scope('s1', 'WP-12', '#e2483d', {
      productType: 'panels', areaDirections: { m1: { x: 1, y: 0 } }, areaOrigins: { m1: { x: 0, y: 0 } }, pageDirections: { p: 1 },
    })
    const clip = clipOf([
      { id: 'm1', scopeId: 's1', kind: 'area', rings: square },
      { id: 'm2', scopeId: 's1', kind: 'area', rings: square },
    ], [s], A)
    const plan = planPaste(clip, { ...A, documentId: 'doc-b', pageId: 'doc-b:p1' }, [scope('b1', 'Other', '#e2483d')], mint, palette)
    expect(plan.newScopes).toHaveLength(1)
    const made = plan.newScopes[0]!
    expect(made).toMatchObject({ id: 'sc-new-1', label: 'WP-12', scopeType: 'area', specifications: { productType: 'panels' } })
    expect(made.specifications).not.toHaveProperty('areaDirections')
    expect(made.specifications).not.toHaveProperty('pageDirections')
    // Its red is taken here, so it gets the next free colour.
    expect(made.color).toBe('#2f7fd1')
    expect(plan.markups.map((m) => m.scopeId)).toEqual(['sc-new-1', 'sc-new-1'])
    expect(pasteStatus(plan, true)).toBe('pasted 2 markups from the other PDF; added scope WP-12')
  })

  it('does not reuse a scope id across files, even when it happens to match', () => {
    const clip = clipOf([{ id: 'm1', scopeId: 's1', kind: 'area', rings: square }], [scope('s1', 'A')], A)
    const plan = planPaste(clip, { ...A, documentId: 'doc-b', pageId: 'doc-b:p1' }, [scope('s1', 'B')], mint, palette)
    expect(plan.markups[0]!.scopeId).toBe('sc-new-1')
  })

  it('carries a dimension\'s label and offset along', () => {
    const content = { offsetPoints: 12, ortho: 'none', label: '10\'-0"' }
    const clip = clipOf([{ id: 'm1', scopeId: null, kind: 'dimension', rings: [[{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.1 }]], content }], [], A)
    content.offsetPoints = 99
    const plan = planPaste(clip, { ...A, documentId: 'doc-b' }, [], mint, palette)
    expect(plan.markups[0]!.content).toEqual({ offsetPoints: 12, ortho: 'none', label: '10\'-0"' })
  })
})
