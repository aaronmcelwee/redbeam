/**
 * The PDF's bookmarks as the publisher wrote them: nested, in their order.
 *
 * The sheet list (sheets.ts) reads the outline to number and group sheets,
 * which is what an estimator usually wants. Bluebeam also shows the outline
 * itself, and people reach for that view to work through a set the way its
 * author arranged it: every bookmark, every level, folders that collapse.
 *
 * Pure functions here; BookmarkTree.tsx only renders.
 */
import type { OutlineNode } from '@redbeam/viewer'

/** One bookmark as shown: where it sits in the tree and whether its children show. */
export interface BookmarkRow {
  /** Path of child indices from the root, joined: "0", "0.3", "0.3.1". */
  key: string
  depth: number
  title: string
  page: number | null
  hasChildren: boolean
  open: boolean
}

/**
 * The rows to draw: a bookmark's children follow it only while it is open.
 * With a query, every bookmark whose title matches is shown with the folders
 * above it, opened, so a match is never hidden inside a closed folder.
 */
export function bookmarkRows(
  outline: readonly OutlineNode[],
  closed: ReadonlySet<string>,
  query = '',
): BookmarkRow[] {
  const q = query.trim().toLowerCase()
  const out: BookmarkRow[] = []
  const matches = (n: OutlineNode): boolean =>
    n.title.toLowerCase().includes(q) || n.children.some(matches)
  const walk = (nodes: readonly OutlineNode[], depth: number, prefix: string) => {
    nodes.forEach((n, i) => {
      if (q !== '' && !matches(n)) return
      const key = prefix === '' ? String(i) : `${prefix}.${i}`
      const hasChildren = n.children.length > 0
      const open = hasChildren && (q !== '' || !closed.has(key))
      out.push({ key, depth, title: n.title, page: n.page, hasChildren, open })
      if (open) walk(n.children, depth + 1, key)
    })
  }
  walk(outline, 0, '')
  return out
}

/** The node at a row key, or undefined. */
export function bookmarkAt(outline: readonly OutlineNode[], key: string): OutlineNode | undefined {
  let nodes = outline
  let node: OutlineNode | undefined
  for (const part of key.split('.')) {
    node = nodes[Number(part)]
    if (node === undefined) return undefined
    nodes = node.children
  }
  return node
}

/**
 * Every page a bookmark and the bookmarks under it point to, in order and
 * without repeats. Right-clicking a folder acts on the sheets inside it.
 */
export function pagesUnder(node: OutlineNode): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  const walk = (n: OutlineNode) => {
    if (n.page !== null && !seen.has(n.page)) { seen.add(n.page); out.push(n.page) }
    n.children.forEach(walk)
  }
  walk(node)
  return out
}

/** Keys of every bookmark that has children: what "collapse all" closes. */
export function folderKeys(outline: readonly OutlineNode[]): string[] {
  const out: string[] = []
  const walk = (nodes: readonly OutlineNode[], prefix: string) => {
    nodes.forEach((n, i) => {
      const key = prefix === '' ? String(i) : `${prefix}.${i}`
      if (n.children.length > 0) { out.push(key); walk(n.children, key) }
    })
  }
  walk(outline, '')
  return out
}
