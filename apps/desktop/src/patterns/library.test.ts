import { describe, it, expect } from 'vitest'
import { PATTERN_EXAMPLES, approvePatternRecipe } from '@redbeam/domain'
import { readLibrary, saveToLibrary, removeFromLibrary, newerInLibrary, libraryEntry, LIBRARY_KEY, type KeyValue } from './library.js'

const mem = (): KeyValue & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v) } }
}

describe('pattern library', () => {
  it('saves an approved pattern with an id and version, and versions it again by name', () => {
    const kv = mem()
    const r = approvePatternRecipe(PATTERN_EXAMPLES['triangles']!, 'Aaron', '2026-11-25')
    const a = saveToLibrary(r, 'Aaron', '2026-11-25', kv)
    expect(a.libraryId).toBe('triangle-panel-48')
    expect(a.libraryVersion).toBe(1)
    const b = saveToLibrary({ ...r, description: 'v2' }, 'Aaron', '2026-11-26', kv)
    expect(b.libraryId).toBe(a.libraryId)
    expect(b.libraryVersion).toBe(2)
    expect(readLibrary(kv)).toHaveLength(1)
    expect(newerInLibrary(a, kv)?.version).toBe(2)
    expect(newerInLibrary(b, kv)).toBeNull()
    expect(libraryEntry('Triangle panel 48"', kv)?.id).toBe('triangle-panel-48')
  })

  it('reads a damaged library as empty rather than failing', () => {
    const kv = mem()
    kv.setItem(LIBRARY_KEY, '{not json')
    expect(readLibrary(kv)).toEqual([])
    expect(readLibrary(null)).toEqual([])
  })

  it('removes an entry', () => {
    const kv = mem()
    const a = saveToLibrary(PATTERN_EXAMPLES['randomBaffles']!, 'Aaron', 'x', kv)
    expect(removeFromLibrary(a.libraryId!, kv)).toBe(true)
    expect(readLibrary(kv)).toEqual([])
  })
})
