import { describe, expect, it } from 'vitest'
import { lightFileOf, readSession, samePath, stepTab, withoutTab, withTab, writeSession } from './lightTabs.js'

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
  it('brings back every tab, however many (no cap)', () => {
    const m = new Map<string, string>()
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
    const files = Array.from({ length: 75 }, (_, i) => `C:\\jobs\\set ${i}.pdf`)
    writeSession({ files, active: files[60]! }, store)
    expect(readSession(store)).toEqual({ files, active: files[60] })
  })
})
