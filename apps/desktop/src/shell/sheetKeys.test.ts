import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pageStepForKey, shortcutFor, steppedPage, toolForKey } from './sheetKeys.js'

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
    expect(toolForKey('q', bare)).toBe('callout')
    expect(toolForKey('t', bare)).toBe('text')
    expect(toolForKey('j', bare)).toBeNull()
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
    expect(dock).toContain("toolButton(t, t.id === 'dimension' ? 'read' : undefined)")
    expect(dock).not.toContain("READ_TOOLS.map((t) => toolButton(t, 'read'))")
  })
})

describe('every tool names its key (#68)', () => {
  it('D arms Dimension and O arms Origin', () => {
    expect(toolForKey('d', bare)).toBe('dimension')
    expect(toolForKey('o', bare)).toBe('origin')
    expect(toolForKey('d', ctrl)).toBeNull()
    expect(toolForKey('o', ctrl)).toBeNull()
  })

  it('reads the key for a tooltip off the same table', () => {
    expect(shortcutFor('area')).toBe('A')
    expect(shortcutFor('cutout')).toBe('X')
    expect(shortcutFor('polyline')).toBe('L')
    expect(shortcutFor('count')).toBe('C')
    expect(shortcutFor('shape')).toBe('S')
    expect(shortcutFor('dimension')).toBe('D')
    expect(shortcutFor('origin')).toBe('O')
    expect(shortcutFor('scale-region')).toBe('Shift+K')
    expect(shortcutFor('direction')).toBeNull()
  })

  it('the dock writes every tool tooltip through toolTitle', () => {
    const dock = read('./Dock.tsx')
    expect(dock).toContain('toolTitle(t.id, t.title ?? t.label)')
    // No key typed by hand into a title, where it could drift from the table.
    expect(dock).not.toMatch(/title: '[^']*\([A-Z]\)'/)
  })
})

describe('a Zoom-to-box button beside Pan and Select (#70)', () => {
  it('sits after Select in the read tools', () => {
    const dock = read('./Dock.tsx')
    expect(dock).toContain("t.id === 'select' && onZoomBox !== undefined")
    expect(read('../Workspace.tsx')).toContain('zoomBoxArmed={zoomBoxArmed}')
  })
})

describe('tool labels wherever they fit (#71)', () => {
  it('steps from labels beside icons, to captions, to two rows, to icons', async () => {
    const { nextLabelTier } = await import('./Dock.js')
    expect(nextLabelTier('all')).toBe('stacked')
    expect(nextLabelTier('stacked')).toBe('wrapped')
    expect(nextLabelTier('wrapped')).toBe('none')
    expect(nextLabelTier('none')).toBe('none')
  })

  it('is measured, not a 1440px breakpoint', () => {
    const css = read('./shell.css')
    expect(css).not.toMatch(/@container viewport \(min-width: 1440px\) \{\s*\.dock \.docklabel/)
    expect(css).toContain('.dock .dockwork[data-labels="all"] .docklabel')
    expect(read('./Dock.tsx')).toContain('data-labels={labels}')
  })
})
