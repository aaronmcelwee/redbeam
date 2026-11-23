import { describe, expect, it } from 'vitest'
import type { OutlineNode } from '@redbeam/viewer'
import { bookmarkAt, bookmarkRows, folderKeys, pagesUnder } from './bookmarks.js'

const n = (title: string, page: number | null, children: OutlineNode[] = []): OutlineNode => ({ title, page, children })
const outline: OutlineNode[] = [
  n('General', null, [n('G0.00 Cover', 0), n('G1.01 Notes', 2)]),
  n('Architectural', 3, [n('A1.103 Floor plan', 3), n('Enlarged', null, [n('A3.000', 5), n('A3.001', 6)])]),
]

describe('bookmarks', () => {
  it('shows children only under open folders', () => {
    const rows = bookmarkRows(outline, new Set(['1.1']))
    expect(rows.map((r) => `${r.depth}:${r.title}`)).toEqual([
      '0:General', '1:G0.00 Cover', '1:G1.01 Notes', '0:Architectural', '1:A1.103 Floor plan', '1:Enlarged',
    ])
    expect(rows.find((r) => r.key === '1.1')).toMatchObject({ hasChildren: true, open: false })
  })
  it('a search opens the folders above a match and hides the rest', () => {
    const rows = bookmarkRows(outline, new Set(['1', '1.1']), 'a3.001')
    expect(rows.map((r) => r.title)).toEqual(['Architectural', 'Enlarged', 'A3.001'])
  })
  it('finds a node by key and the pages under it', () => {
    expect(bookmarkAt(outline, '1.1.0')?.title).toBe('A3.000')
    expect(bookmarkAt(outline, '4')).toBeUndefined()
    expect(pagesUnder(outline[1]!)).toEqual([3, 5, 6])
    expect(pagesUnder(outline[0]!)).toEqual([0, 2])
  })
  it('lists every folder', () => {
    expect(folderKeys(outline)).toEqual(['0', '1', '1.1'])
  })
})
