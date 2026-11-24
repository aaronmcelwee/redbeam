import { describe, expect, it } from 'vitest'
import {
  agentTabs, lightFileOf, nextOwnTab, ownTabs, readSession, samePath, stepOwnTab, stepTab, tabFor, tabNamed, withoutTab, withOwner,
  withTab, writeSession,
} from './lightTabs.js'

const a = lightFileOf('C:\\Jobs\\A.pdf'), b = lightFileOf('C:\\Jobs\\B.pdf'), c = lightFileOf('C:/Jobs/C.pdf')

describe('light tabs', () => {
  it('splits a path into folder and name', () => {
    expect(a).toEqual({ folder: 'C:\\Jobs', file: 'C:\\Jobs\\A.pdf', relativePath: 'A.pdf' })
    expect(c.relativePath).toBe('C.pdf')
  })
  it('treats case and slashes as the same file', () => {
    expect(samePath('C:/jobs/a.PDF', 'C:\\Jobs\\A.pdf')).toBe(true)
  })
  it('adds a tab once', () => {
    expect(withTab([a], b).map((t) => t.relativePath)).toEqual(['A.pdf', 'B.pdf'])
    expect(withTab([a, b], lightFileOf('c:/jobs/a.pdf'))).toHaveLength(2)
  })
  it('closing the showing tab shows its right neighbour, else its left', () => {
    expect(withoutTab([a, b, c], b.file, b.file).next).toBe(c)
    expect(withoutTab([a, b, c], c.file, c.file).next).toBe(b)
    expect(withoutTab([a], a.file, a.file)).toEqual({ tabs: [], next: null })
    expect(withoutTab([a, b], b.file, a.file)).toEqual({ tabs: [a], next: null })
  })
  it('steps round the tabs', () => {
    expect(stepTab([a, b, c], c.file, 1)).toBe(a)
    expect(stepTab([a, b, c], a.file, -1)).toBe(c)
    expect(stepTab([a], a.file, 1)).toBeNull()
  })
  it('keeps the session, and survives storage that is junk or missing', () => {
    const m = new Map<string, string>()
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
    writeSession({ files: [a.file, b.file], active: b.file }, store)
    expect(readSession(store)).toEqual({ files: [a.file, b.file], active: b.file })
    m.set('redbeam.light-tabs', '{nope')
    expect(readSession(store)).toEqual({ files: [], active: null })
    expect(readSession(null)).toEqual({ files: [], active: null })
  })
})

describe('tabs with agents in the window', () => {
  const mine = lightFileOf('C:\\Jobs\\Mine.pdf'), mine2 = lightFileOf('C:\\Jobs\\Mine 2.pdf')
  const theirs = { ...lightFileOf('C:\\Jobs\\Tower A.pdf'), owner: 'a' }, others = { ...lightFileOf('C:\\Other\\Tower A.pdf'), owner: 'b' }
  const tabs = [mine, theirs, mine2, others]
  it('tells the person\'s tabs from each agent\'s', () => {
    expect(ownTabs(tabs)).toEqual([mine, mine2])
    expect(agentTabs(tabs, 'a')).toEqual([theirs])
    expect(agentTabs(tabs, 'nobody')).toEqual([])
  })
  it('finds the tab a call names by path, or by a name only one tab has', () => {
    expect(tabNamed(tabs, 'c:/jobs/mine.PDF')).toBe(mine)
    expect(tabNamed(tabs, 'Mine 2.pdf')).toBe(mine2)
    // Two open PDFs share this name: not guessed between.
    expect(tabNamed(tabs, 'Tower A.pdf')).toBeUndefined()
    expect(tabNamed(tabs, '  ')).toBeUndefined()
    expect(tabFor(tabs, 'C:\\Jobs\\Nope.pdf')).toBeUndefined()
  })
  it('hands a tab to an agent and back', () => {
    const handed = withOwner(tabs, mine.file, 'a')
    expect(tabFor(handed, mine.file)!.owner).toBe('a')
    const back = withOwner(handed, mine.file, null)
    expect(tabFor(back, mine.file)).toEqual(mine)
    expect('owner' in tabFor(back, mine.file)!).toBe(false)
  })
  it('closing the tab showing never drops the person into an agent\'s tab', () => {
    expect(nextOwnTab(tabs, mine.file)).toBe(mine2)
    expect(nextOwnTab(tabs, mine2.file)).toBe(mine)
    expect(nextOwnTab([mine, theirs], mine.file)).toBeNull()
    // Leaving an agent's tab they were watching: back to one of their own.
    expect(nextOwnTab(tabs, theirs.file)).toBe(mine2)
  })
  it('Ctrl+Tab steps through the person\'s own tabs only', () => {
    expect(stepOwnTab(tabs, mine.file, 1)).toBe(mine2)
    expect(stepOwnTab(tabs, mine2.file, 1)).toBe(mine)
    expect(stepOwnTab(tabs, theirs.file, 1)).toBe(mine)
    expect(stepOwnTab(tabs, theirs.file, -1)).toBe(mine2)
    expect(stepOwnTab([mine, theirs], mine.file, 1)).toBeNull()
    expect(stepOwnTab([theirs], theirs.file, 1)).toBeNull()
  })
})
