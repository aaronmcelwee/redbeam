import { describe, expect, it } from 'vitest'
import { LIGHT_HIDDEN_SETTINGS, LIGHT_PANELS, PRO_AVAILABLE, LIGHT_REACHES, isProjectOnlyCommand, lightCommands, readMode, writeMode } from './light.js'
import { SETTINGS } from './settings/registry.js'
import { SettingsStore, memoryStorage } from './settings/store.js'
import { forgetFile, recentFiles, rememberFile, type RecentFileStorage } from './project/recentFiles.js'

describe('mode', () => {
  it('is Light until someone picks Pro, and remembers the pick', () => {
    const store = SettingsStore.open(memoryStorage())
    expect(readMode(store, true)).toBe('light')
    expect(writeMode('pro', store)).toBeNull()
    expect(readMode(store, true)).toBe('pro')
    writeMode('light', store)
    expect(readMode(store, true)).toBe('light')
  })

  it('is Light whatever was picked while Pro is parked, and does not offer the choice', () => {
    const store = SettingsStore.open(memoryStorage())
    writeMode('pro', store)
    expect(PRO_AVAILABLE).toBe(false)
    expect(readMode(store)).toBe('light')
    expect(LIGHT_HIDDEN_SETTINGS).toContain('general.mode')
  })
})

describe('the Light palette', () => {
  it('drops the commands that need a project and names closing for a file', () => {
    expect(isProjectOnlyCommand('new-round')).toBe(true)
    expect(isProjectOnlyCommand('est-estimate-1')).toBe(true)
    expect(isProjectOnlyCommand('project:C:\\Jobs\\Bentall')).toBe(true)
    expect(isProjectOnlyCommand('fit-page')).toBe(false)
    const out = lightCommands(
      [
        { id: 'fit-page', title: 'Fit sheet' },
        { id: 'new-round', title: 'New round…' },
        { id: 'close-project', title: 'Close project', detail: 'Back to the start page' },
        { id: 'project:new', title: 'New project…' },
      ],
      [{ id: 'light-open', title: 'Open PDF…' }],
    )
    expect(out.map((c) => c.id)).toEqual(['light-open', 'fit-page', 'close-project'])
    expect(out.find((c) => c.id === 'close-project')?.title).toBe('Close all files')
  })

  it('names the panel and the exports for a file, and drops the duplicate save', () => {
    const out = lightCommands(
      [
        { id: 'pane-estimates', title: 'Show the estimates pane' },
        { id: 'export-estimate', title: 'Export estimate…' },
        { id: 'remove-scope', title: 'Remove scope from round…' },
        { id: 'save-takeoff', title: 'Save takeoff into this drawing' },
        { id: 'close-tab', title: 'Close A-101' },
      ],
      [],
    )
    expect(out.map((c) => c.title)).toEqual(['Show the takeoff pane', 'Export takeoff…', 'Remove scope…'])
  })
})

describe('the Light window', () => {
  it('has no Files pane and searches only this file', () => {
    expect(LIGHT_PANELS).not.toContain('files')
    expect(LIGHT_PANELS).toContain('search')
    expect(LIGHT_REACHES).toEqual(['sheet', 'document'])
  })

  it('hides only settings that exist, and the mode switch only while Pro is parked', () => {
    const ids = new Set(SETTINGS.map((d) => d.id))
    for (const id of LIGHT_HIDDEN_SETTINGS) expect(ids.has(id)).toBe(true)
    expect(LIGHT_HIDDEN_SETTINGS.includes('general.mode')).toBe(!PRO_AVAILABLE)
  })
})

describe('recent files', () => {
  const mem = (): RecentFileStorage => {
    const m = new Map<string, string>()
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) } }
  }

  it('lists PDFs newest first, once each, whatever the slashes or case', () => {
    const s = mem()
    rememberFile('C:\\Jobs\\A-101.pdf', s, new Date('2026-11-18T10:00:00Z'))
    rememberFile('C:\\Jobs\\A-102.pdf', s, new Date('2026-11-18T11:00:00Z'))
    rememberFile('c:/jobs/a-101.pdf', s, new Date('2026-11-18T12:00:00Z'))
    const list = recentFiles(s)
    expect(list.map((f) => f.name)).toEqual(['a-101', 'A-102'])
    expect(list[0]).toMatchObject({ lastOpenedAt: '2026-11-18T12:00:00.000Z', missing: false, displayName: null })
    forgetFile('C:\\JOBS\\A-102.PDF', s)
    expect(recentFiles(s).map((f) => f.name)).toEqual(['a-101'])
  })

  it('reads a damaged list as empty rather than failing the start screen', () => {
    const s = mem()
    s.setItem('redbeam.recent-files', '{not json')
    expect(recentFiles(s)).toEqual([])
  })
})
