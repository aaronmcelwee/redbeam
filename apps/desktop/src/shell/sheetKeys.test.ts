import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pageStepForKey, steppedPage, toolForKey } from './sheetKeys.js'

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')

const bare = { ctrlKey: false, metaKey: false, altKey: false }
const ctrl = { ...bare, ctrlKey: true }

describe('tool shortcuts (#29)', () => {
  it('a bare letter arms its tool', () => {
    expect(toolForKey('k', bare)).toBe('calibrate')
    expect(toolForKey('K', bare)).toBe('scale-region')
    expect(toolForKey('v', bare)).toBe('select')
    expect(toolForKey('h', bare)).toBe('pan')
    expect(toolForKey('q', bare)).toBeNull()
  })

  it('Ctrl+K opens the palette and arms nothing', () => {
    expect(toolForKey('k', ctrl)).toBeNull()
    expect(toolForKey('K', { ...ctrl })).toBeNull()
  })

  it('no modified letter arms a tool', () => {
    for (const key of ['v', 'h', 'a', 'l', 'c', 'x', 's', 'k']) {
      expect(toolForKey(key, ctrl)).toBeNull()
      expect(toolForKey(key, { ...bare, metaKey: true })).toBeNull()
      expect(toolForKey(key, { ...bare, altKey: true })).toBeNull()
    }
  })

  it('the drawing listener reads its letters through toolForKey', () => {
    const ws = read('../Workspace.tsx')
    expect(ws).toContain('toolForKey(e.key, e)')
    expect(ws).not.toMatch(/e\.key === '[a-zA-Z]'\)\s*\{\s*setTool\(/)
  })
})

describe('sheet stepping keys (#30)', () => {
  const keys = { ...bare, shiftKey: false }

  it('Left and PgUp go back, Right and PgDn go forward', () => {
    expect(pageStepForKey('ArrowLeft', keys)).toBe(-1)
    expect(pageStepForKey('PageUp', keys)).toBe(-1)
    expect(pageStepForKey('ArrowRight', keys)).toBe(1)
    expect(pageStepForKey('PageDown', keys)).toBe(1)
    expect(pageStepForKey('ArrowUp', keys)).toBeNull()
  })

  it('modified arrows are left alone', () => {
    expect(pageStepForKey('ArrowLeft', { ...keys, altKey: true })).toBeNull()
    expect(pageStepForKey('ArrowRight', { ...keys, ctrlKey: true })).toBeNull()
    expect(pageStepForKey('ArrowRight', { ...keys, shiftKey: true })).toBeNull()
  })

  it('stops at the first and last sheet', () => {
    expect(steppedPage(0, 5, -1)).toBeNull()
    expect(steppedPage(0, 5, 1)).toBe(1)
    expect(steppedPage(4, 5, 1)).toBeNull()
    expect(steppedPage(3, 5, -1)).toBe(2)
  })

  it('the drawing listener steps the sheets', () => {
    const ws = read('../Workspace.tsx')
    expect(ws).toContain('pageStepForKey(e.key, e)')
    expect(ws).toContain('stepPageRef.current(step)')
  })
})

describe('Pan and Select at every width (#31)', () => {
  it('only Dimension sits in the collapsing read tier', () => {
    const dock = read('./Dock.tsx')
    expect(dock).toContain("READ_TOOLS.map((t) => toolButton(t, t.id === 'dimension' ? 'read' : undefined))")
    expect(dock).not.toContain("READ_TOOLS.map((t) => toolButton(t, 'read'))")
  })
})
