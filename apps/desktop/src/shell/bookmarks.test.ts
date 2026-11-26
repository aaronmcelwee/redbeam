import { describe, expect, it } from 'vitest'
import {
  bookmarkRows, findBookmark, flatIds, folderIds, insertBookmarks, moveBookmarks, nestedFolderIds,
  pagesUnder, removeBookmarks, updateBookmark, updateBookmarks, type FileBookmark,
} from './bookmarks.js'

const n = (id: string, page: number | null, children: FileBookmark[] = []): FileBookmark => ({
  id, title: id, page, view: null, color: null, bold: false, italic: false, src: null, children,
})
const tree: FileBookmark[] = [
  n('General', null, [n('G0.00', 0), n('G1.01', 2)]),
  n('Architectural', 3, [n('A1.103', 3), n('Enlarged', null, [n('A3.000', 5), n('A3.001', 6)])]),
]

describe('bookmarks', () => {
  it('shows children only under open folders', () => {
    const rows = bookmarkRows(tree, new Set(['Enlarged']))
    expect(rows.map((r) => `${r.depth}:${r.node.title}`)).toEqual([
      '0:General', '1:G0.00', '1:G1.01', '0:Architectural', '1:A1.103', '1:Enlarged',
    ])
    expect(rows.find((r) => r.id === 'Enlarged')).toMatchObject({ hasChildren: true, open: false })
  })
  it('a search opens the folders above a match and hides the rest', () => {
    const rows = bookmarkRows(tree, new Set(['Architectural', 'Enlarged']), 'a3.001')
    expect(rows.map((r) => r.node.title)).toEqual(['Architectural', 'Enlarged', 'A3.001'])
  })
  it('finds a node and the pages under it', () => {
    expect(findBookmark(tree, 'A3.000')?.page).toBe(5)
    expect(findBookmark(tree, 'nope')).toBeUndefined()
    expect(pagesUnder(tree[1]!)).toEqual([3, 5, 6])
  })
  it('lists folders, and the nested ones that start closed', () => {
    expect(folderIds(tree)).toEqual(['General', 'Architectural', 'Enlarged'])
    expect(nestedFolderIds(tree)).toEqual(['Enlarged'])
  })
  it('renames, colours and removes', () => {
    const renamed = updateBookmark(tree, 'A1.103', { title: 'Floor plan' })
    expect(findBookmark(renamed, 'A1.103')?.title).toBe('Floor plan')
    expect(findBookmark(tree, 'A1.103')?.title).toBe('A1.103')
    const red = updateBookmarks(tree, new Set(['G0.00', 'Enlarged']), { color: '#d13438', bold: true })
    expect(findBookmark(red, 'Enlarged')).toMatchObject({ color: '#d13438', bold: true })
    expect(findBookmark(red, 'A3.000')?.color).toBeNull()
    expect(flatIds(removeBookmarks(tree, new Set(['Enlarged'])))).toEqual(['General', 'G0.00', 'G1.01', 'Architectural', 'A1.103'])
  })
  it('inserts before, after, inside and at the end', () => {
    const x = n('X', 1)
    expect(flatIds(insertBookmarks(tree, [x], { id: 'G1.01', where: 'before' })).slice(0, 4)).toEqual(['General', 'G0.00', 'X', 'G1.01'])
    expect(findBookmark(insertBookmarks(tree, [x], { id: 'General', where: 'inside' }), 'General')!.children.map((c) => c.id))
      .toEqual(['G0.00', 'G1.01', 'X'])
    expect(flatIds(insertBookmarks(tree, [x], { id: null, where: 'after' })).at(-1)).toBe('X')
  })
  it('moves into a folder, keeps order, and never into itself', () => {
    const moved = moveBookmarks(tree, ['A3.001', 'G0.00'], { id: 'Architectural', where: 'before' })
    expect(moved.map((m) => m.id)).toEqual(['General', 'G0.00', 'A3.001', 'Architectural'])
    expect(moveBookmarks(tree, ['Architectural'], { id: 'A3.000', where: 'inside' })).toEqual(tree)
    // A folder moving with one of its own children carries it inside.
    const both = moveBookmarks(tree, ['Enlarged', 'A3.000'], { id: null, where: 'after' })
    expect(both.at(-1)!.children.map((c) => c.id)).toEqual(['A3.000', 'A3.001'])
  })
})
