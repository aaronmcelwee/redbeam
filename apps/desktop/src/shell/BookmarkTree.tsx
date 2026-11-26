/**
 * The bookmarks in the Contents list: the PDF's own and the ones added here,
 * nested and collapsible, and editable the way Bluebeam's are. Rename (F2 or
 * a double-click), drag to reorder or into a folder, colour, bold, italic,
 * delete; Ctrl+Z takes the last change back. What is changed here is saved
 * into the PDF's bookmarks (export/sheetOutline.ts) with the takeoff.
 *
 * SheetIndex.tsx owns the list as a whole, the sheets above these and the
 * "Add" button; this file is the rows, their menu and their editing.
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type DragEvent as ReactDragEvent, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent,
} from 'react'
import { ChevronRight, FolderAdd, Glyph, Rename, TextBold, TextItalic, Trash2, Bookmark } from './icons.js'
import {
  BOOKMARK_COLORS, bookmarkRows, findBookmark, flatIds, insertBookmarks, makeBookmark, moveBookmarks,
  nestedFolderIds, pagesUnder, removeBookmarks, shownTitle, updateBookmark, updateBookmarks,
  type BookmarkPlace, type BookmarkView, type FileBookmark,
} from './bookmarks.js'
import { hasSheetActions, type SheetActions } from './SheetMenu.js'
import { useClampedPopover } from './popover.js'

/** What a drag of bookmarks carries: their ids. */
export const BOOKMARK_DRAG = 'application/x-redbeam-bookmarks'
/** What a drag of sheets from the sheet list carries: their page indices. Dropped here, they become bookmarks. */
export const SHEET_DRAG = 'application/x-redbeam-sheets'

export interface BookmarkEditor {
  tree: readonly FileBookmark[]
  picked: ReadonlySet<string>
  editing: string | null
  setEditing: (id: string | null) => void
  pick: (ids: ReadonlySet<string>, anchor?: string | null) => void
  change: (next: FileBookmark[]) => void
  undo: () => boolean
  /** Add bookmarks after the last one picked (or at the end) and start renaming the first. */
  add: (items: FileBookmark[], place?: BookmarkPlace) => void
  closed: ReadonlySet<string>
  toggle: (id: string) => void
  anchor: string | null
}

/**
 * The list's editing state. A new file starts with its nested folders closed;
 * the history is per file and goes when another file opens.
 */
export function useBookmarkEditor(
  tree: readonly FileBookmark[],
  onChange: ((next: FileBookmark[]) => void) | undefined,
  fileKey: string,
): BookmarkEditor {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set(nestedFolderIds(tree)))
  const history = useRef<FileBookmark[][]>([])
  const treeRef = useRef(tree)
  treeRef.current = tree

  useEffect(() => {
    history.current = []
    setPicked(new Set())
    setAnchor(null)
    setEditing(null)
    setClosed(new Set(nestedFolderIds(treeRef.current)))
  }, [fileKey])

  const change = useCallback((next: FileBookmark[]) => {
    if (onChange === undefined) return
    history.current.push([...treeRef.current])
    onChange(next)
  }, [onChange])

  const undo = useCallback((): boolean => {
    const prev = history.current.pop()
    if (prev === undefined || onChange === undefined) return false
    onChange(prev)
    setEditing(null)
    return true
  }, [onChange])

  const add = useCallback((items: FileBookmark[], place?: BookmarkPlace) => {
    if (items.length === 0) return
    const cur = treeRef.current
    const order = flatIds(cur)
    const last = [...picked].sort((a, b) => order.indexOf(a) - order.indexOf(b)).pop() ?? null
    const at: BookmarkPlace = place ?? (last === null ? { id: null, where: 'after' } : { id: last, where: 'after' })
    change(insertBookmarks(cur, items, at))
    if (at.where === 'inside' && at.id !== null) {
      setClosed((prev) => { const next = new Set(prev); next.delete(at.id!); return next })
    }
    setPicked(new Set([items[0]!.id]))
    setAnchor(items[0]!.id)
    if (items.length === 1) setEditing(items[0]!.id)
  }, [change, picked])

  const toggle = useCallback((id: string) => setClosed((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])

  const pick = useCallback((ids: ReadonlySet<string>, a?: string | null) => {
    setPicked(ids)
    if (a !== undefined) setAnchor(a)
  }, [])

  return { tree, picked, editing, setEditing, pick, change, undo, add, closed, toggle, anchor }
}

export interface BookmarkRowsProps extends SheetActions {
  editor: BookmarkEditor
  query: string
  current: number
  labelFor: (page: number) => string
  /** The title a bookmark for this sheet starts with: its number and name. */
  sheetTitle: (page: number) => string
  /** Go where a bookmark points: its sheet, framed as it was saved when it has a view. */
  onGo: (b: FileBookmark) => void
  /** What trails a bookmark's row for its sheet: the scopes drawn there, as the sheet list shows them. */
  trailFor?: (page: number) => ReactNode
  /** Picking a bookmark clears the sheet selection, and the other way round. */
  onPicked?: () => void
  /** The view on screen now, for "Bookmark this view". */
  currentView?: () => BookmarkView | null
  editable: boolean
}

type DropZone = { id: string, where: BookmarkPlace['where'] } | null

export function BookmarkRows({
  editor, query, current, labelFor, sheetTitle, onGo, onPicked, currentView, editable, trailFor,
  onSetScale, onRotate, onPrint,
}: BookmarkRowsProps) {
  const actions: SheetActions = {
    ...(onSetScale !== undefined ? { onSetScale } : {}),
    ...(onRotate !== undefined ? { onRotate } : {}),
    ...(onPrint !== undefined ? { onPrint } : {}),
  }
  const { tree, picked, editing, closed } = editor
  const rows = useMemo(() => bookmarkRows(tree, closed, query), [tree, closed, query])
  const [menu, setMenu] = useState<{ x: number, y: number, ids: string[] } | null>(null)
  const [drop, setDrop] = useState<DropZone>(null)
  const currentRef = useRef<HTMLDivElement | null>(null)
  // The first bookmark for the sheet on screen is the one marked current.
  const currentId = rows.find((r) => r.node.page === current)?.id ?? null

  useEffect(() => { currentRef.current?.scrollIntoView({ block: 'nearest' }) }, [currentId])

  const click = (id: string, e: ReactMouseEvent) => {
    onPicked?.()
    const order = rows.map((r) => r.id)
    if (e.shiftKey && editor.anchor !== null && order.includes(editor.anchor)) {
      const [a, b] = [order.indexOf(editor.anchor), order.indexOf(id)].sort((x, y) => x - y)
      editor.pick(new Set(order.slice(a!, b! + 1)))
      return
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(picked)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      editor.pick(next, id)
      return
    }
    editor.pick(new Set([id]), id)
    const n = findBookmark(tree, id)
    if (n !== undefined && n.page !== null) onGo(n)
  }

  const contextMenu = (id: string, e: ReactMouseEvent) => {
    e.preventDefault()
    onPicked?.()
    const ids = picked.has(id) ? [...picked] : [id]
    if (!picked.has(id)) editor.pick(new Set([id]), id)
    setMenu({ x: e.clientX, y: e.clientY, ids })
  }

  const commitRename = (id: string, title: string) => {
    editor.setEditing(null)
    const n = findBookmark(tree, id)
    const t = title.trim()
    if (n === undefined || t === n.title) return
    editor.change(updateBookmark(tree, id, { title: t }))
  }

  const remove = (ids: Iterable<string>) => {
    const set = new Set(ids)
    if (set.size === 0) return
    editor.change(removeBookmarks(tree, set))
    editor.pick(new Set(), null)
  }

  const onKeyDown = (id: string, e: ReactKeyboardEvent) => {
    if (!editable || editing !== null) return
    if (e.key === 'F2') { e.preventDefault(); editor.setEditing(id); return }
    if (e.key === 'Delete') { e.preventDefault(); remove(picked.has(id) ? picked : [id]); return }
  }

  // ------------------------------------------------------------ dragging --
  const zoneOf = (e: ReactDragEvent<HTMLElement>, id: string): DropZone => {
    const r = e.currentTarget.getBoundingClientRect()
    const f = (e.clientY - r.top) / Math.max(1, r.height)
    return { id, where: f < 0.28 ? 'before' : f > 0.72 ? 'after' : 'inside' }
  }
  const carries = (e: ReactDragEvent) => e.dataTransfer.types.includes(BOOKMARK_DRAG) || e.dataTransfer.types.includes(SHEET_DRAG)
  const onDragOver = (e: ReactDragEvent<HTMLElement>, id: string) => {
    if (!editable || !carries(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(SHEET_DRAG) ? 'copy' : 'move'
    const z = zoneOf(e, id)
    setDrop((prev) => (prev?.id === z?.id && prev?.where === z?.where ? prev : z))
  }
  const landOn = (e: ReactDragEvent, place: BookmarkPlace) => {
    setDrop(null)
    const ids = e.dataTransfer.getData(BOOKMARK_DRAG)
    if (ids !== '') {
      const list = JSON.parse(ids) as string[]
      editor.change(moveBookmarks(tree, list, place))
      if (place.where === 'inside' && place.id !== null && closed.has(place.id)) editor.toggle(place.id)
      return
    }
    const pages = e.dataTransfer.getData(SHEET_DRAG)
    if (pages !== '') {
      const made = (JSON.parse(pages) as number[]).map((p) => makeBookmark(sheetTitle(p), p))
      editor.add(made, place)
    }
  }
  const onDrop = (e: ReactDragEvent<HTMLElement>, id: string) => {
    if (!editable || !carries(e)) return
    e.preventDefault()
    const z = zoneOf(e, id)
    if (z !== null) landOn(e, z)
  }
  const onDragStart = (e: ReactDragEvent<HTMLElement>, id: string) => {
    if (!editable || editing !== null) { e.preventDefault(); return }
    const ids = picked.has(id) ? [...picked] : [id]
    if (!picked.has(id)) editor.pick(new Set([id]), id)
    e.dataTransfer.setData(BOOKMARK_DRAG, JSON.stringify(ids))
    e.dataTransfer.effectAllowed = 'move'
  }

  const menuIds = menu?.ids ?? []
  const menuNodes = menuIds.map((id) => findBookmark(tree, id)).filter((n): n is FileBookmark => n !== undefined)
  const menuPages = (() => {
    const out: number[] = []
    const seen = new Set<number>()
    for (const n of menuNodes) for (const p of pagesUnder(n)) if (!seen.has(p)) { seen.add(p); out.push(p) }
    return out
  })()

  return (
    <>
      {rows.length === 0 && query !== '' && tree.length > 0 && (
        <div className="paneempty">No bookmark matches “{query}”.</div>
      )}
      <div role="tree" aria-label="Bookmarks">
        {rows.map((r) => {
          const n = r.node
          const title = shownTitle(n, labelFor)
          const zone = drop?.id === r.id ? drop.where : null
          const style: Record<string, string> = { paddingLeft: `calc(var(--rb-pad-row) + ${r.depth} * 14px)` }
          if (n.color !== null) style['--bm'] = n.color
          return (
            <div
              key={r.id}
              ref={r.id === currentId ? currentRef : undefined}
              role="treeitem"
              tabIndex={picked.has(r.id) || (picked.size === 0 && r.id === currentId) ? 0 : -1}
              aria-level={r.depth + 1}
              aria-expanded={r.hasChildren ? r.open : undefined}
              aria-selected={picked.has(r.id)}
              aria-current={r.id === currentId ? 'true' : undefined}
              data-bookmark={r.id}
              className={rowClass(r.id === currentId, picked.has(r.id), n, zone)}
              style={style}
              title={n.page === null ? title : `${title} — ${labelFor(n.page)}${n.view !== null ? ' (saved view)' : ''}`}
              draggable={editable && editing !== r.id}
              onDragStart={(e) => onDragStart(e, r.id)}
              onDragOver={(e) => onDragOver(e, r.id)}
              onDragLeave={() => setDrop((prev) => (prev?.id === r.id ? null : prev))}
              onDrop={(e) => onDrop(e, r.id)}
              onDragEnd={() => setDrop(null)}
              onClick={(e) => { if (editing !== r.id) click(r.id, e) }}
              onDoubleClick={() => { if (editable) editor.setEditing(r.id); else if (r.hasChildren) editor.toggle(r.id) }}
              onContextMenu={(e) => contextMenu(r.id, e)}
              onKeyDown={(e) => onKeyDown(r.id, e)}
            >
              <span
                className="bookmarktwisty"
                aria-hidden="true"
                onClick={(e) => { if (r.hasChildren) { e.stopPropagation(); editor.toggle(r.id) } }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {r.hasChildren && <Glyph icon={ChevronRight} role="small" style={r.open ? { transform: 'rotate(90deg)' } : undefined} />}
              </span>
              {editing === r.id
                ? (
                  <input
                    className="bookmarkedit"
                    defaultValue={n.title}
                    aria-label="Bookmark name"
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') commitRename(r.id, e.currentTarget.value)
                      if (e.key === 'Escape') editor.setEditing(null)
                    }}
                    onBlur={(e) => commitRename(r.id, e.currentTarget.value)}
                  />
                  )
                : <span className="sheettitle"><span>{title}</span></span>}
              <span className="sheettrail">
                {n.page !== null && trailFor?.(n.page)}
                <span className="sheetpage">{n.page === null ? '' : n.page + 1}</span>
              </span>
            </div>
          )
        })}
      </div>
      {editable && (
        <div
          className={`bookmarkend${drop?.id === '' ? ' drop-after' : ''}`}
          onDragOver={(e) => { if (carries(e)) { e.preventDefault(); setDrop({ id: '', where: 'after' }) } }}
          onDragLeave={() => setDrop((prev) => (prev?.id === '' ? null : prev))}
          onDrop={(e) => { if (carries(e)) { e.preventDefault(); landOn(e, { id: null, where: 'after' }) } }}
        />
      )}
      {menu !== null && menuNodes.length > 0 && (
        <BookmarkMenu
          at={menu}
          nodes={menuNodes}
          pages={menuPages}
          editable={editable}
          actions={hasSheetActions(actions) ? actions : {}}
          onClose={() => setMenu(null)}
          onRename={() => editor.setEditing(menuNodes[0]!.id)}
          onDelete={() => remove(menuNodes.map((n) => n.id))}
          onStyle={(patch) => editor.change(updateBookmarks(tree, new Set(menuNodes.map((n) => n.id)), patch))}
          onAddSheet={() => editor.add([makeBookmark(sheetTitle(current), current)], { id: menuNodes[menuNodes.length - 1]!.id, where: 'after' })}
          {...(currentView !== undefined ? {
            onAddView: () => {
              const v = currentView()
              editor.add([makeBookmark(`${sheetTitle(current)} (view)`, current, v)], { id: menuNodes[menuNodes.length - 1]!.id, where: 'after' })
            },
          } : {})}
          onAddFolder={() => {
            const last = menuNodes[menuNodes.length - 1]!
            editor.add([makeBookmark('New folder', null)], { id: last.id, where: 'after' })
          }}
        />
      )}
    </>
  )
}

/** A row's classes: what it is, whether it is current or picked, its style, and a drag landing on it. */
function rowClass(current: boolean, isPicked: boolean, n: FileBookmark, zone: BookmarkPlace['where'] | null): string {
  const out = ['sheetrow', 'bookmarkrow']
  if (current) out.push('active')
  if (isPicked) out.push('picked')
  if (n.color !== null) out.push('colored')
  if (n.bold) out.push('bold')
  if (n.italic) out.push('italic')
  if (zone === 'before') out.push('drop-before')
  if (zone === 'after') out.push('drop-after')
  if (zone === 'inside') out.push('drop-inside')
  return out.join(' ')
}

function BookmarkMenu({
  at, nodes, pages, editable, actions, onClose, onRename, onDelete, onStyle, onAddSheet, onAddView, onAddFolder,
}: {
  at: { x: number, y: number }
  nodes: FileBookmark[]
  pages: number[]
  editable: boolean
  actions: SheetActions
  onClose: () => void
  onRename: () => void
  onDelete: () => void
  onStyle: (patch: Partial<Pick<FileBookmark, 'color' | 'bold' | 'italic'>>) => void
  onAddSheet: () => void
  onAddView?: () => void
  onAddFolder: () => void
}) {
  const clamp = useClampedPopover<HTMLDivElement>(true)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeRef.current() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const act = (f: () => void) => () => { onClose(); f() }
  const one = nodes.length === 1
  const allBold = nodes.every((n) => n.bold)
  const allItalic = nodes.every((n) => n.italic)
  const color = nodes.every((n) => n.color === nodes[0]!.color) ? nodes[0]!.color : undefined
  const { onSetScale, onRotate, onPrint } = actions
  return (
    <>
      <div
        className="menuscrim"
        onPointerDown={(e) => { e.stopPropagation(); onClose() }}
        onContextMenu={(e) => { e.preventDefault(); onClose() }}
      />
      <div className="dockmenu sheetmenu" role="menu" ref={clamp.ref} style={{ left: at.x, top: at.y, ...clamp.style }}>
        <div className="menuhead">{one ? (nodes[0]!.title || 'Bookmark') : `${nodes.length} bookmarks`}</div>
        {editable && (
          <>
            {one && (
              <button className="menuitem" role="menuitem" onClick={act(onRename)}>
                <Glyph icon={Rename} role="inline" />
                <span className="grow">Rename</span>
                <span className="hint">F2</span>
              </button>
            )}
            <div className="bookmarkswatches" role="group" aria-label="Colour">
              <button
                role="menuitemradio"
                aria-checked={color === null}
                className="swatch none"
                title="No colour"
                aria-label="No colour"
                onClick={act(() => onStyle({ color: null }))}
              />
              {BOOKMARK_COLORS.map((c) => (
                <button
                  key={c.color}
                  role="menuitemradio"
                  aria-checked={color?.toLowerCase() === c.color}
                  className="swatch"
                  title={c.name}
                  aria-label={c.name}
                  style={{ background: c.color }}
                  onClick={act(() => onStyle({ color: c.color }))}
                />
              ))}
            </div>
            <button className="menuitem" role="menuitemcheckbox" aria-checked={allBold} onClick={act(() => onStyle({ bold: !allBold }))}>
              <Glyph icon={TextBold} role="inline" />
              <span className="grow">Bold</span>
            </button>
            <button className="menuitem" role="menuitemcheckbox" aria-checked={allItalic} onClick={act(() => onStyle({ italic: !allItalic }))}>
              <Glyph icon={TextItalic} role="inline" />
              <span className="grow">Italic</span>
            </button>
            <div className="menusep" />
            <button className="menuitem" role="menuitem" onClick={act(onAddSheet)}>
              <Glyph icon={Bookmark} role="inline" />
              <span className="grow">Bookmark this sheet</span>
            </button>
            {onAddView !== undefined && (
              <button className="menuitem" role="menuitem" onClick={act(onAddView)}>
                <Glyph icon={Bookmark} role="inline" />
                <span className="grow">Bookmark this view</span>
              </button>
            )}
            <button className="menuitem" role="menuitem" onClick={act(onAddFolder)}>
              <Glyph icon={FolderAdd} role="inline" />
              <span className="grow">New folder</span>
            </button>
          </>
        )}
        {pages.length > 0 && (onRotate !== undefined || onPrint !== undefined || onSetScale !== undefined) && (
          <>
            {editable && <div className="menusep" />}
            {onPrint !== undefined && (
              <button className="menuitem" role="menuitem" onClick={act(() => onPrint(pages))}>
                <span className="grow">Print {pages.length === 1 ? 'sheet' : `${pages.length} sheets`}…</span>
              </button>
            )}
            {onRotate !== undefined && (
              <button className="menuitem" role="menuitem" onClick={act(() => onRotate(pages, 1))}>
                <span className="grow">Rotate {pages.length === 1 ? 'sheet' : `${pages.length} sheets`} clockwise</span>
              </button>
            )}
            {onSetScale !== undefined && (
              <button className="menuitem" role="menuitem" onClick={act(() => onSetScale(pages))}>
                <span className="grow">Set scale…</span>
              </button>
            )}
          </>
        )}
        {editable && (
          <>
            <div className="menusep" />
            <button className="menuitem danger" role="menuitem" onClick={act(onDelete)}>
              <Glyph icon={Trash2} role="inline" />
              <span className="grow">Delete{one ? '' : ` ${nodes.length} bookmarks`}</span>
              <span className="hint">Del</span>
            </button>
          </>
        )}
      </div>
    </>
  )
}
