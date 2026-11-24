import { describe, expect, it } from 'vitest'
import type { Markup } from '@redbeam/domain'
import { pickOriginArea } from './origin.js'

const rect = (id: string, scopeId: string | null, x0: number, y0: number, x1: number, y1: number): Markup => ({
  id, scopeId, documentId: 'd', pageId: 'p', kind: 'area',
  rings: [[{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]],
})
// A 1000 px square sheet at zoom 1, and a grip of 10 px.
const snap = { scaleX: 1000, scaleY: 1000, radius: 10 }

describe('the Origin tool (#69)', () => {
  it('sets the start where the click lands inside an area', () => {
    const pick = pickOriginArea({ x: 0.3, y: 0.3 }, [rect('a', 's1', 0.1, 0.1, 0.5, 0.5)], 's1', snap)
    expect(pick?.markup.id).toBe('a')
    expect(pick?.point).toEqual({ x: 0.3, y: 0.3 })
  })

  it('lands exactly on a corner within the grip, even from just outside it', () => {
    const pick = pickOriginArea({ x: 0.095, y: 0.095 }, [rect('a', 's1', 0.1, 0.1, 0.5, 0.5)], 's1', snap)
    expect(pick?.point).toEqual({ x: 0.1, y: 0.1 })
  })

  it('ignores a click well away from every area', () => {
    expect(pickOriginArea({ x: 0.8, y: 0.8 }, [rect('a', 's1', 0.1, 0.1, 0.5, 0.5)], 's1', snap)).toBeNull()
  })

  it('prefers the active scope, then the smaller area', () => {
    const room = rect('room', 's1', 0, 0, 0.9, 0.9)
    const soffit = rect('soffit', 's1', 0.2, 0.2, 0.4, 0.4)
    const other = rect('other', 's2', 0.25, 0.25, 0.35, 0.35)
    expect(pickOriginArea({ x: 0.3, y: 0.3 }, [room, soffit, other], 's1', snap)?.markup.id).toBe('soffit')
    expect(pickOriginArea({ x: 0.3, y: 0.3 }, [room, soffit, other], 's2', snap)?.markup.id).toBe('other')
  })

  it('takes only areas that belong to a scope', () => {
    const loose = rect('loose', null, 0.1, 0.1, 0.5, 0.5)
    const line: Markup = { ...rect('line', 's1', 0.1, 0.1, 0.5, 0.5), kind: 'polyline' }
    expect(pickOriginArea({ x: 0.3, y: 0.3 }, [loose, line], 's1', snap)).toBeNull()
  })

  it('is what the sheet calls when the Origin tool clicks', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const ws = readFileSync(fileURLToPath(new URL('../Workspace.tsx', import.meta.url)), 'utf8')
    expect(ws).toContain("if (tool === 'origin') {")
    expect(ws).toContain('pickOriginArea(p, markupsRef.current, activeScopeRef.current')
  })
})
