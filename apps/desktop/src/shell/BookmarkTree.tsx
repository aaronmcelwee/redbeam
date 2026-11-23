/**
 * The Bookmarks view of the Contents panel: the PDF's outline, nested and
 * collapsible, with the same selection and right-click actions as the sheet
 * list and the thumbnails.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { OutlineNode } from '@redbeam/viewer'
import { ChevronRight, Glyph, Search } from './icons.js'
import { bookmarkAt, bookmarkRows, folderKeys, pagesUnder } from './bookmarks.js'
import { hasSheetActions, SheetMenu, type SheetActions } from './SheetMenu.js'

export interface BookmarkTreeProps extends SheetActions {
  outline: readonly OutlineNode[]
  current: number
  onGoToPage: (page: number) => void
  labelFor: (page: number) => string
}

export function BookmarkTree({
  outline, current, onGoToPage, labelFor, onSetScale, onRotate, onPrint,
}: BookmarkTreeProps) {
  const actions: SheetActions = {
    ...(onSetScale !== undefined ? { onSetScale } : {}),
    ...(onRotate !== undefined ? { onRotate } : {}),
    ...(onPrint !== undefined ? { onPrint } : {}),
  }
  const [query, setQuery] = useState('')
  // Folders start closed past the first level, as Bluebeam opens a set.
  const [closed, setClosed] = useState<ReadonlySet<string>>(
    () => new Set(folderKeys(outline).filter((k) => k.includes('.'))),
  )
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number, y: number, pages: number[] } | null>(null)
  const rows = useMemo(() => bookmarkRows(outline, closed, query), [outline, closed, query])
  const currentRef = useRef<HTMLButtonElement | null>(null)
  // The first bookmark for the page on screen is the one marked current.
  const currentKey = rows.find((r) => r.page === current)?.key ?? null

  useEffect(() => { currentRef.current?.scrollIntoView({ block: 'nearest' }) }, [currentKey])

  const toggleFolder = (key: string) => setClosed((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const pagesOf = (keys: Iterable<string>): number[] => {
    const out: number[] = []
    const seen = new Set<number>()
    for (const k of keys) {
      const n = bookmarkAt(outline, k)
      if (n === undefined) continue
      for (const p of pagesUnder(n)) if (!seen.has(p)) { seen.add(p); out.push(p) }
    }
    return out
  }

  const click = (key: string, e: ReactMouseEvent) => {
    const order = rows.map((r) => r.key)
    if (e.shiftKey && anchor !== null && order.includes(anchor)) {
      const [a, b] = [order.indexOf(anchor), order.indexOf(key)].sort((x, y) => x - y)
      setPicked(new Set(order.slice(a!, b! + 1)))
      return
    }
    if (e.ctrlKey || e.metaKey) {
      setPicked((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      setAnchor(key)
      return
    }
    setPicked(new Set([key]))
    setAnchor(key)
    const page = bookmarkAt(outline, key)?.page
    if (page !== null && page !== undefined) onGoToPage(page)
  }

  const contextMenu = (key: string, e: ReactMouseEvent) => {
    if (!hasSheetActions(actions)) return
    e.preventDefault()
    const keys = picked.has(key) ? picked : new Set([key])
    if (!picked.has(key)) { setPicked(keys); setAnchor(key) }
    const pages = pagesOf(keys)
    if (pages.length > 0) setMenu({ x: e.clientX, y: e.clientY, pages })
  }

  if (outline.length === 0) {
    return (
      <div className="panebody">
        <div className="paneempty">
          <div>This PDF has no bookmarks.</div>
          <div className="panehint">The sheet list shows its pages by number and title instead.</div>
        </div>
      </div>
    )
  }

  const selectedPages = picked.size > 1 ? pagesOf(picked).length : 0

  return (
    <>
      <div className="panesearch">
        <Glyph icon={Search} role="small" />
        <input
          value={query}
          placeholder="Find a bookmark"
          aria-label="Find a bookmark"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery('') }}
        />
      </div>
      <div className="panebody" role="tree" aria-label="Bookmarks">
        {rows.length === 0 && <div className="paneempty">No bookmark matches “{query}”.</div>}
        {rows.map((r) => (
          <button
            key={r.key}
            ref={r.key === currentKey ? currentRef : undefined}
            role="treeitem"
            aria-level={r.depth + 1}
            aria-expanded={r.hasChildren ? r.open : undefined}
            aria-selected={picked.has(r.key)}
            aria-current={r.key === currentKey ? 'true' : undefined}
            className={`sheetrow bookmarkrow${r.key === currentKey ? ' active' : ''}${picked.size > 1 && picked.has(r.key) ? ' picked' : ''}`}
            style={{ paddingLeft: `calc(var(--rb-pad-row) + ${r.depth} * 14px)` }}
            title={r.page === null ? r.title : `${r.title} — ${labelFor(r.page)}`}
            onClick={(e) => click(r.key, e)}
            onDoubleClick={() => { if (r.hasChildren) toggleFolder(r.key) }}
            onContextMenu={(e) => contextMenu(r.key, e)}
          >
            <span
              className="bookmarktwisty"
              aria-hidden="true"
              onClick={(e) => { if (r.hasChildren) { e.stopPropagation(); toggleFolder(r.key) } }}
            >
              {r.hasChildren && <Glyph icon={ChevronRight} role="small" style={r.open ? { transform: 'rotate(90deg)' } : undefined} />}
            </span>
            <span className="sheettitle"><span>{r.title}</span></span>
            <span className="sheetpage">{r.page === null ? '' : r.page + 1}</span>
          </button>
        ))}
      </div>
      {menu !== null && (
        <SheetMenu
          at={menu}
          pages={menu.pages}
          heading={menu.pages.length === 1 ? labelFor(menu.pages[0]!) : `${menu.pages.length} sheets`}
          actions={actions}
          onClose={() => setMenu(null)}
        />
      )}
      {selectedPages > 0 && <div className="panefoot">{picked.size} bookmarks selected · {selectedPages} sheets</div>}
    </>
  )
}
