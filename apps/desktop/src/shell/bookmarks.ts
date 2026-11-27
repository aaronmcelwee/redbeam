/**
 * The Contents list's bookmarks: the PDF's own, plus the ones added here.
 *
 * Kenneth, 2026-11-26: Contents and Bookmarks were two lists, and the
 * bookmarks could only be read. Bluebeam lets an estimator start from the
 * publisher's bookmarks, add their own for a sheet or a spot on it, colour
 * them and arrange them, and that list is what the next person opens. So the
 * panel shows one list: the sheets (as "Sheets", the folder REDBEAM writes
 * them into) and then these, which can be renamed, dragged, nested, coloured
 * and deleted, and are saved into the PDF's /Outlines (export/sheetOutline.ts).
 *
 * Pure functions on the tree here; BookmarkTree.tsx renders and edits.
 */
import type { OutlineNode } from '@redbeam/viewer'
import type { FileBookmark } from '../export/sheetOutline.js'

export type { BookmarkView, FileBookmark } from '../export/sheetOutline.js'

/** One bookmark as shown: where it sits in the tree and whether its children show. */
export interface BookmarkRow {
  id: string
  depth: number
  node: FileBookmark
  hasChildren: boolean
  open: boolean
}

/**
 * The colours offered, chosen to read as themselves on white and on the dark
 * theme's panel (the row mixes them with the ink; see `.bookmarkrow`), and to
 * be told apart from each other at a glance. Bluebeam shows any RGB, and a
 * colour a file brings that is not one of these is kept as it is.
 */
export const BOOKMARK_COLORS: ReadonlyArray<{ name: string; color: string }> = [
  { name: 'Red', color: '#d13438' },
  { name: 'Orange', color: '#ca5010' },
  { name: 'Yellow', color: '#c19c00' },
  { name: 'Green', color: '#107c10' },
  { name: 'Teal', color: '#038387' },
  { name: 'Blue', color: '#0f6cbd' },
  { name: 'Purple', color: '#8764b8' },
  { name: 'Grey', color: '#69797e' },
]

/**
 * The rows to draw: a bookmark's children follow it only while it is open.
 * With a query, every bookmark whose title matches is shown with the folders
 * above it, opened, so a match is never hidden inside a closed folder.
 */
export function bookmarkRows(
  tree: readonly FileBookmark[],
  closed: ReadonlySet<string>,
  query = '',
): BookmarkRow[] {
  const q = query.trim().toLowerCase()
  const out: BookmarkRow[] = []
  const matches = (n: FileBookmark): boolean =>
    n.title.toLowerCase().includes(q) || n.children.some(matches)
  const walk = (nodes: readonly FileBookmark[], depth: number) => {
    for (const n of nodes) {
      if (q !== '' && !matches(n)) continue
      const hasChildren = n.children.length > 0
      const open = hasChildren && (q !== '' || !closed.has(n.id))
      out.push({ id: n.id, depth, node: n, hasChildren, open })
      if (open) walk(n.children, depth + 1)
    }
  }
  walk(tree, 0)
  return out
}

/** The bookmark with this id, or undefined. */
export function findBookmark(tree: readonly FileBookmark[], id: string): FileBookmark | undefined {
  for (const n of tree) {
    if (n.id === id) return n
    const hit = findBookmark(n.children, id)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * Every page a bookmark and the bookmarks under it point to, in order and
 * without repeats. Right-clicking a folder acts on the sheets inside it.
 */
export function pagesUnder(node: FileBookmark): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  const walk = (n: FileBookmark) => {
    if (n.page !== null && !seen.has(n.page)) { seen.add(n.page); out.push(n.page) }
    n.children.forEach(walk)
  }
  walk(node)
  return out
}

/** Ids of every bookmark that has children. */
export function folderIds(tree: readonly FileBookmark[]): string[] {
  const out: string[] = []
  const walk = (nodes: readonly FileBookmark[], depth: number) => {
    for (const n of nodes) {
      if (n.children.length > 0) { out.push(n.id); walk(n.children, depth + 1) }
    }
  }
  walk(tree, 0)
  return out
}

/** Folders below the top level: closed when a set opens, as Bluebeam opens one. */
export function nestedFolderIds(tree: readonly FileBookmark[]): string[] {
  return tree.flatMap((n) => folderIds(n.children))
}

let counter = 0
/** A new bookmark's id: never a file object's ("12 0 R"), never repeated in a session. */
export function newBookmarkId(): string {
  counter += 1
  return `new-${Date.now().toString(36)}-${counter}`
}

/** A bookmark made here. */
export function makeBookmark(
  title: string, page: number | null, view: FileBookmark['view'] = null,
): FileBookmark {
  return { id: newBookmarkId(), title, page, view, color: null, bold: false, italic: false, src: null, children: [] }
}

/** The tree with one bookmark changed. */
export function updateBookmark(
  tree: readonly FileBookmark[], id: string, patch: Partial<Omit<FileBookmark, 'id' | 'children' | 'src'>>,
): FileBookmark[] {
  return tree.map((n) => (n.id === id ? { ...n, ...patch } : { ...n, children: updateBookmark(n.children, id, patch) }))
}

/** The tree with these bookmarks changed alike: colour, bold, italic for a selection. */
export function updateBookmarks(
  tree: readonly FileBookmark[], ids: ReadonlySet<string>, patch: Partial<Pick<FileBookmark, 'color' | 'bold' | 'italic'>>,
): FileBookmark[] {
  return tree.map((n) => ({
    ...(ids.has(n.id) ? { ...n, ...patch } : n),
    children: updateBookmarks(n.children, ids, patch),
  }))
}

/** The tree without these bookmarks (and what is under them). */
export function removeBookmarks(tree: readonly FileBookmark[], ids: ReadonlySet<string>): FileBookmark[] {
  return tree.filter((n) => !ids.has(n.id)).map((n) => ({ ...n, children: removeBookmarks(n.children, ids) }))
}

/** Where a dragged or added bookmark lands, relative to another one. */
export interface BookmarkPlace {
  /** The bookmark it lands beside or inside; null for the end of the list. */
  id: string | null
  where: 'before' | 'after' | 'inside'
}

function insertAt(tree: readonly FileBookmark[], items: readonly FileBookmark[], place: BookmarkPlace): FileBookmark[] {
  if (place.id === null) return [...tree, ...items]
  const out: FileBookmark[] = []
  for (const n of tree) {
    if (n.id === place.id) {
      if (place.where === 'before') out.push(...items, n)
      else if (place.where === 'after') out.push(n, ...items)
      else out.push({ ...n, children: [...n.children, ...items] })
    } else {
      out.push({ ...n, children: insertAt(n.children, items, place) })
    }
  }
  return out
}

/** The tree with new bookmarks put at `place`. */
export function insertBookmarks(
  tree: readonly FileBookmark[], items: readonly FileBookmark[], place: BookmarkPlace,
): FileBookmark[] {
  if (place.id !== null && findBookmark(tree, place.id) === undefined) return [...tree, ...items]
  return insertAt(tree, items, place)
}

/** Whether `id` is `ancestor` or somewhere under it. */
export function isWithin(tree: readonly FileBookmark[], ancestor: string, id: string): boolean {
  const a = findBookmark(tree, ancestor)
  return a !== undefined && (a.id === id || findBookmark(a.children, id) !== undefined)
}

/**
 * The tree with these bookmarks moved to `place`, in the order they are
 * listed. A bookmark is never moved into itself or under itself; one whose
 * folder is also moving goes along inside it rather than on its own.
 */
export function moveBookmarks(
  tree: readonly FileBookmark[], ids: readonly string[], place: BookmarkPlace,
): FileBookmark[] {
  if (place.id !== null && ids.some((id) => isWithin(tree, id, place.id!))) return [...tree]
  const top = ids.filter((id) => !ids.some((other) => other !== id && isWithin(tree, other, id)))
  const order = flatIds(tree)
  top.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  const moving = top.map((id) => findBookmark(tree, id)).filter((n): n is FileBookmark => n !== undefined)
  if (moving.length === 0) return [...tree]
  return insertBookmarks(removeBookmarks(tree, new Set(top)), moving, place)
}

/** Every id, in reading order. */
export function flatIds(tree: readonly FileBookmark[]): string[] {
  const out: string[] = []
  const walk = (nodes: readonly FileBookmark[]) => { for (const n of nodes) { out.push(n.id); walk(n.children) } }
  walk(tree)
  return out
}

/**
 * The viewer's outline as a list, for a file whose bookmarks could not be
 * read with their colours (the takeoff reader failed): the same titles and
 * pages, nothing to keep.
 */
export function fromOutline(outline: readonly OutlineNode[], skip: (n: OutlineNode) => boolean = () => false): FileBookmark[] {
  return outline.filter((n) => !skip(n)).map((n) => ({
    ...makeBookmark(n.title, n.page),
    children: fromOutline(n.children, skip),
  }))
}

/** A title the panel can show: a bookmark with no words says where it goes. */
export function shownTitle(n: FileBookmark, labelFor: (page: number) => string): string {
  if (n.title.trim() !== '') return n.title
  return n.page === null ? 'Untitled' : labelFor(n.page)
}

// ------------------------------------------------------- agents' edits --

/** One change an agent asks for (redbeam_edit_bookmarks). */
export type BookmarkEdit =
  | { op: 'add'; title: string; page?: number | null; parent?: string | null; after?: string | null
      color?: string | null; bold?: boolean; italic?: boolean; view?: FileBookmark['view'] }
  | { op: 'update'; id: string; title?: string; page?: number | null; color?: string | null; bold?: boolean; italic?: boolean }
  | { op: 'move'; id: string; parent?: string | null; after?: string | null }
  | { op: 'delete'; id: string }

/** A colour as an agent may say it: '#rrggbb', a name from the palette, or null for none. */
export function bookmarkColor(c: unknown): string | null | undefined {
  if (c === undefined) return undefined
  if (c === null || c === '' || c === 'none') return null
  if (typeof c !== 'string') return undefined
  const named = BOOKMARK_COLORS.find((x) => x.name.toLowerCase() === c.trim().toLowerCase())
  if (named !== undefined) return named.color
  return /^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim().toLowerCase() : undefined
}

/** Where `parent` / `after` put a bookmark: after a sibling, at the end of a folder, or at the end of the list. */
function placeFor(parent: string | null | undefined, after: string | null | undefined): BookmarkPlace {
  if (after !== undefined && after !== null) return { id: after, where: 'after' }
  if (parent !== undefined && parent !== null) return { id: parent, where: 'inside' }
  return { id: null, where: 'after' }
}

/**
 * Apply an agent's edits in order. Each one is checked before anything
 * changes: one that names a bookmark that is not there, or a page past the
 * end, refuses the whole call so a half-made list is never saved.
 */
export function applyBookmarkEdits(
  tree: readonly FileBookmark[], edits: readonly BookmarkEdit[], pageCount: number,
): { tree: FileBookmark[]; added: string[] } | { error: string } {
  let cur = [...tree]
  const added: string[] = []
  const has = (id: string | null | undefined) => id === undefined || id === null || findBookmark(cur, id) !== undefined
  /** `parent` / `after` by id, or by exact title when no id matches and one bookmark has it. */
  const ref = (r: string | null | undefined): string | null | undefined => {
    if (r === undefined || r === null || findBookmark(cur, r) !== undefined) return r
    const named: string[] = []
    const walk = (ns: readonly FileBookmark[]) => { for (const n of ns) { if (n.title === r) named.push(n.id); walk(n.children) } }
    walk(cur)
    return named.length === 1 ? named[0] : r
  }
  const pageOk = (p: number | null | undefined) => p === undefined || p === null || (Number.isInteger(p) && p >= 0 && p < pageCount)
  for (let [i, e] of edits.entries()) {
    const at = `edits[${i}]`
    if (typeof e !== 'object' || e === null) return { error: `${at}: each edit is an object with an op` }
    if (e.op === 'add' || e.op === 'move') e = { ...e, parent: ref(e.parent) ?? null, after: ref(e.after) ?? null }
    if (e.op === 'add') {
      if (typeof e.title !== 'string' || e.title.trim() === '') return { error: `${at}: add needs a title` }
      if (!pageOk(e.page)) return { error: `${at}: page ${e.page} is not in this PDF (pages are 0 to ${pageCount - 1})` }
      if (!has(e.parent) || !has(e.after)) return { error: `${at}: no bookmark ${e.after ?? e.parent}; list_bookmarks gives the ids` }
      const color = bookmarkColor(e.color)
      if (e.color !== undefined && color === undefined) return { error: `${at}: colour ${String(e.color)} is not '#rrggbb' or one of ${BOOKMARK_COLORS.map((c) => c.name).join(', ')}` }
      const b: FileBookmark = {
        ...makeBookmark(e.title.trim(), e.page ?? null, e.view ?? null),
        color: color ?? null, bold: e.bold === true, italic: e.italic === true,
      }
      cur = insertBookmarks(cur, [b], placeFor(e.parent, e.after))
      added.push(b.id)
    } else if (e.op === 'update') {
      if (!has(e.id) || e.id === undefined) return { error: `${at}: no bookmark ${e.id}; list_bookmarks gives the ids` }
      if (!pageOk(e.page)) return { error: `${at}: page ${e.page} is not in this PDF` }
      const color = bookmarkColor(e.color)
      if (e.color !== undefined && color === undefined) return { error: `${at}: colour ${String(e.color)} is not '#rrggbb' or a palette name` }
      cur = updateBookmark(cur, e.id, {
        ...(typeof e.title === 'string' && e.title.trim() !== '' ? { title: e.title.trim() } : {}),
        ...(e.page !== undefined ? { page: e.page, view: null } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(typeof e.bold === 'boolean' ? { bold: e.bold } : {}),
        ...(typeof e.italic === 'boolean' ? { italic: e.italic } : {}),
      })
    } else if (e.op === 'move') {
      if (!has(e.id) || !has(e.parent) || !has(e.after)) return { error: `${at}: no such bookmark; list_bookmarks gives the ids` }
      const place = placeFor(e.parent, e.after)
      if (place.id !== null && isWithin(cur, e.id, place.id)) return { error: `${at}: a bookmark cannot go inside itself` }
      cur = moveBookmarks(cur, [e.id], place)
    } else if (e.op === 'delete') {
      if (!has(e.id) || e.id === undefined) return { error: `${at}: no bookmark ${e.id}` }
      cur = removeBookmarks(cur, new Set([e.id]))
    } else {
      return { error: `${at}: op must be add, update, move or delete` }
    }
  }
  return { tree: cur, added }
}
