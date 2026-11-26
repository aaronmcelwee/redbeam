/**
 * The sheet index — the panel that replaced the file tree.
 *
 * The file tree was answering the wrong question. A drawing set is one PDF
 * with 110 sheets in it, so the tree rendered exactly one row and navigated
 * nothing; the thing an estimator actually moves through is the sheets. Which
 * is what the Qt build's left panel showed, and why this is the parity gap
 * that mattered most.
 *
 * Grouping, titles and fallbacks are decided in `sheets.ts` — this component
 * only renders and filters. The one behaviour that lives here is scrolling the
 * current sheet into view, because that is a DOM concern.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, ChevronRight, FolderAdd, Glyph, Search } from './icons.js'
import { hasSheetActions, SheetMenu, type SheetActions } from './SheetMenu.js'
import { BookmarkRows, SHEET_DRAG, useBookmarkEditor } from './BookmarkTree.js'
import { makeBookmark, type BookmarkView, type FileBookmark } from './bookmarks.js'
import {
  buildSheetIndex, filterSheets, sheetDots, type SheetIndexInput, type SheetRow,
} from './sheets.js'
import {
  clickSheet, describeSelection, EMPTY_SELECTION, rightClickSheet, selectedInOrder,
  type SheetSelection,
} from './sheetSelection.js'

/** Whether the "Sheets" folder is open when there are bookmarks below it, kept per viewer. */
const SHEETS_OPEN_KEY = 'redbeam.contents-sheets-open'
const NO_BOOKMARKS: FileBookmark[] = []

export interface SheetIndexProps extends SheetIndexInput, SheetActions {
  /** 0-based index of the sheet on screen. */
  current: number
  onGoToPage: (page: number) => void
  /** Feet per point per page, for the badge. Absent means not set. */
  scaleOf?: (page: number) => number | null
  /**
   * Shown instead of "no document open" while that is not yet known — the
   * folder is still being read, or the drawing is still opening. An empty
   * index that has not finished loading must not claim to be empty.
   */
  pending?: string | null
  /**
   * Naming the sheets from two boxes on the title block (titleBlock.ts).
   * `reading` counts the sheets read so far while the reading runs.
   */
  titleBlock?: {
    named: boolean
    reading: { done: number; total: number } | null
    onPick: () => void
  }
  /**
   * The PDF's bookmarks and the ones added here, listed under the sheets
   * (Kenneth, 2026-11-26: one list, not a Sheets|Bookmarks switch).
   */
  bookmarks?: readonly FileBookmark[]
  /** Set when the list can be edited; the edited list is saved into the PDF. */
  onBookmarksChange?: (next: FileBookmark[]) => void
  /** Go where a bookmark points. Defaults to its sheet. */
  onGoToBookmark?: (b: FileBookmark) => void
  /** The view on screen, for "Bookmark this view". */
  currentView?: () => BookmarkView | null
  /** Which file the list is of: its editing history starts over with another. */
  fileKey?: string
}

export function SheetIndex({
  current, onGoToPage, onSetScale, onRotate, onPrint, scaleOf, pending = null, titleBlock,
  bookmarks = NO_BOOKMARKS, onBookmarksChange, onGoToBookmark, currentView, fileKey = '', ...input
}: SheetIndexProps) {
  const actions: SheetActions = {
    ...(onSetScale !== undefined ? { onSetScale } : {}),
    ...(onRotate !== undefined ? { onRotate } : {}),
    ...(onPrint !== undefined ? { onPrint } : {}),
  }
  const [query, setQuery] = useState('')
  const editable = onBookmarksChange !== undefined
  const editor = useBookmarkEditor(bookmarks, onBookmarksChange, fileKey)
  const [sheetsOpen, setSheetsOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(SHEETS_OPEN_KEY) !== 'false' } catch { return true }
  })
  const toggleSheets = () => setSheetsOpen((v) => {
    try { localStorage.setItem(SHEETS_OPEN_KEY, String(!v)) } catch { /* a convenience only */ }
    return !v
  })
  const [selection, setSelection] = useState<SheetSelection>(EMPTY_SELECTION)
  const [menu, setMenu] = useState<{ x: number, y: number, pages: number[] } | null>(null)
  const groups = useMemo(() => buildSheetIndex(input), [
    input.pageCount, input.shape, input.outline, input.labels, input.takeoffPages, input.pageScopes, input.named,
  ])
  const shown = useMemo(() => filterSheets(groups, query), [groups, query])

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const currentRef = useRef<HTMLButtonElement | null>(null)

  // Follow the document. Without this, paging with the dock leaves the index
  // showing wherever it was last scrolled, which is the sheet you just left.
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const withTakeoff = groups.reduce((n, g) => n + g.rows.filter((r) => r.hasTakeoff).length, 0)

  /*
   * The pages currently ON SCREEN, in order, which is what a shift-range
   * means. Groups collapse and the search box filters, so this is not simply
   * 0..pageCount — and a range that quietly included sheets nobody can see
   * would apply a scale to them too.
   */
  const visible = useMemo(() => {
    const out: number[] = []
    for (const g of shown) {
      if (g.label !== null && collapsed.has(g.label)) continue
      for (const r of g.rows) out.push(r.page)
    }
    return out
  }, [shown, collapsed])

  const labelFor = (page: number) => {
    for (const g of groups) {
      const hit = g.rows.find((r) => r.page === page)
      if (hit !== undefined) return hit.number
    }
    return `Page ${page + 1}`
  }
  /** A new bookmark for a sheet says its number and name, as the sheet list does. */
  const sheetTitle = (page: number) => {
    for (const g of groups) {
      const hit = g.rows.find((r) => r.page === page)
      if (hit !== undefined) return hit.title === '' ? hit.number : `${hit.number} ${hit.title}`
    }
    return `Page ${page + 1}`
  }
  const goToBookmark = (b: FileBookmark) => {
    if (onGoToBookmark !== undefined) onGoToBookmark(b)
    else if (b.page !== null) onGoToPage(b.page)
  }

  const row = (r: SheetRow) => (
    <button
      key={r.page}
      ref={r.page === current ? currentRef : undefined}
      className={`sheetrow${r.page === current ? ' active' : ''}`
        + `${selection.pages.has(r.page) ? ' picked' : ''}`}
      aria-current={r.page === current ? 'true' : undefined}
      aria-selected={selection.pages.has(r.page)}
      draggable={editable}
      onDragStart={(e) => {
        // Dropped on the bookmarks below, the sheets become bookmarks.
        const pages = selection.pages.has(r.page) ? selectedInOrder(selection) : [r.page]
        e.dataTransfer.setData(SHEET_DRAG, JSON.stringify(pages))
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={(e) => {
        if (editor.picked.size > 0) editor.pick(new Set(), null)
        setSelection((prev) => clickSheet(
          prev, r.page, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey }, visible,
        ))
        // A modified click is building a selection, not asking to read that
        // sheet — paging away mid-selection loses the drawing you were on.
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) onGoToPage(r.page)
      }}
      onContextMenu={(e) => {
        if (!hasSheetActions(actions)) return
        e.preventDefault()
        const next = rightClickSheet(selection, r.page)
        setSelection(next)
        setMenu({ x: e.clientX, y: e.clientY, pages: selectedInOrder(next) })
      }}
      title={r.title === '' ? r.number : `${r.number} — ${r.title}`}
    >
      {/*
        ONE LINE. The number and the title used to stack, which put nine
        sheets on a screen with room for sixteen — and an index is scanned
        down the number column, not read. The number is the identifier, so
        it is never the thing that truncates: the title takes what is left
        and gives way first. The row's grid says so (see `.sheetrow`).
      */}
      <span className="sheetnum">{r.number}</span>
      {/* Nested so the title can hide itself when its cell is too narrow to
          say anything — a container query styles only what is inside. */}
      <span className="sheettitle"><span>{r.title}</span></span>
      {/*
        ONE trailing cell. The row is a grid — number, title, trailing — and
        the badge used to be a fourth child, which grid wrapped onto a second
        row: every unscaled sheet showed its page number alone on a line
        beneath the title. The things that trail share a cell.
      */}
      <span className="sheettrail">
        {/*
          An unscaled sheet says so. Nothing on it can be measured, and finding
          that out from a quantity that came back empty is the long way round.
        */}
        {scaleOf !== undefined && r.hasTakeoff && scaleOf(r.page) === null && (
          <span className="sheetunscaled" title="This sheet has no scale set">no scale</span>
        )}
        <SheetDots row={r} />
        <span className="sheetpage">{r.page + 1}</span>
      </span>
    </button>
  )

  const hasBookmarks = bookmarks.length > 0
  /*
   * A publisher who bookmarked every sheet already gave the sheet list: it
   * is shown once, as their bookmarks (with the takeoff dots), not again
   * above them. Sheets named off the title block are REDBEAM's own list and
   * keep their folder, as the PDF does for Bluebeam.
   */
  const rowByPage = useMemo(() => {
    const m = new Map<number, SheetRow>()
    for (const g of groups) for (const r of g.rows) m.set(r.page, r)
    return m
  }, [groups])
  const sheetsCovered = useMemo(() => {
    if (!hasBookmarks || input.pageCount === 0 || (input.named ?? []).some((n) => n !== null)) return false
    const seen = new Set<number>()
    const walk = (list: readonly FileBookmark[]) => { for (const b of list) { if (b.page !== null) seen.add(b.page); walk(b.children) } }
    walk(bookmarks)
    return seen.size >= input.pageCount
  }, [hasBookmarks, bookmarks, input.pageCount, input.named])
  const showSheets = !sheetsCovered
  const trailFor = (page: number) => {
    const r = rowByPage.get(page)
    if (r === undefined) return null
    return (
      <>
        {scaleOf !== undefined && r.hasTakeoff && scaleOf(r.page) === null && (
          <span className="sheetunscaled" title="This sheet has no scale set">no scale</span>
        )}
        <SheetDots row={r} />
      </>
    )
  }
  const addSheet = () => editor.add([makeBookmark(sheetTitle(current), current)])
  const addFolder = () => editor.add([makeBookmark('New folder', null)])
  const bookmarkRowsEl = (
    <BookmarkRows
      editor={editor}
      query={query}
      current={current}
      labelFor={labelFor}
      sheetTitle={sheetTitle}
      onGo={goToBookmark}
      trailFor={trailFor}
      onPicked={() => { if (selection.pages.size > 0) setSelection(EMPTY_SELECTION) }}
      editable={editable}
      {...(currentView !== undefined ? { currentView } : {})}
      {...actions}
    />
  )

  return (
    <>
      <div className="contentsbar">
        <div className="panesearch">
          <Glyph icon={Search} role="small" />
          <input
            value={query}
            placeholder={hasBookmarks ? 'Find a sheet or bookmark' : 'Find a sheet'}
            aria-label={hasBookmarks ? 'Find a sheet or bookmark' : 'Find a sheet'}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery('') }}
          />
        </div>
        {editable && input.pageCount > 0 && (
          <>
            <button type="button" className="paneact" title="Bookmark this sheet" aria-label="Bookmark this sheet" onClick={addSheet}>
              <Glyph icon={Bookmark} role="inline" />
            </button>
            <button type="button" className="paneact" title="New bookmark folder" aria-label="New bookmark folder" onClick={addFolder}>
              <Glyph icon={FolderAdd} role="inline" />
            </button>
          </>
        )}
      </div>

      <div
        className="panebody"
        onKeyDown={(e) => {
          // Ctrl+Z here takes back the last change to the bookmarks, not the takeoff.
          if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && editor.editing === null
            && (e.target as HTMLElement).closest('[data-bookmark]') !== null) {
            if (editor.undo()) { e.preventDefault(); e.stopPropagation() }
          }
        }}
      >
        {shown.length === 0 && input.pageCount === 0 && pending !== null && (
          <div className="paneempty pending" role="status">{pending}</div>
        )}
        {shown.length === 0 && (input.pageCount > 0 || pending === null) && (
          <div className="paneempty">
            {input.pageCount === 0
              ? (
                <>
                  <div>No drawing open.</div>
                  <div className="panehint">
                    Open one from Project files, or press + in the tab strip to
                    add a PDF. Its sheets are listed here.
                  </div>
                </>
                )
              : `No sheet matches “${query}”.`}
          </div>
        )}
        {showSheets && hasBookmarks && input.pageCount > 0 && (
          <button className="sheetgrouphead sheetsfolder" aria-expanded={sheetsOpen || query !== ''} onClick={toggleSheets}>
            <Glyph icon={ChevronRight} role="small" />
            <span className="grow">Sheets</span>
            <span>{input.pageCount}</span>
          </button>
        )}
        {showSheets && (!hasBookmarks || sheetsOpen || query !== '') && (
          <div className={hasBookmarks ? 'sheetsinfolder' : undefined}>
            {shown.map((g, i) => {
              if (g.label === null) return <div key={i}>{g.rows.map(row)}</div>
              const isOpen = !collapsed.has(g.label)
              return (
                <section className="sheetgroup" key={g.label}>
                  <button
                    className="sheetgrouphead"
                    aria-expanded={isOpen}
                    onClick={() => setCollapsed((prev) => {
                      const next = new Set(prev)
                      if (next.has(g.label!)) next.delete(g.label!)
                      else next.add(g.label!)
                      return next
                    })}
                  >
                    <Glyph icon={ChevronRight} role="small" />
                    <span className="grow">{g.label}</span>
                    <span>{g.rows.length}</span>
                  </button>
                  {isOpen && g.rows.map(row)}
                </section>
              )
            })}
          </div>
        )}
        {bookmarkRowsEl}
      </div>

      {menu !== null && (
        <SheetMenu
          at={menu}
          pages={menu.pages}
          heading={describeSelection({ pages: new Set(menu.pages), anchor: null }, labelFor)}
          actions={actions}
          onClose={() => setMenu(null)}
        />
      )}

      {titleBlock !== undefined && input.pageCount > 0 && (
        /*
         * The names come from somewhere, and when they are wrong the fix is
         * here, under the list that shows them: point at the title block.
         * Aaron, 2026-11-25: most of a 264-sheet set read as its contract
         * number.
         */
        <div className="titlefoot">
          {titleBlock.reading !== null
            ? (
              <span className="titlefoot-note" role="status">
                <progress max={titleBlock.reading.total} value={titleBlock.reading.done} />
                Reading title blocks · {titleBlock.reading.done} of {titleBlock.reading.total}
              </span>
              )
            : titleBlock.named
              ? <span className="titlefoot-note">Names read from the title block</span>
              : <span className="titlefoot-note">Names wrong?</span>}
          <button type="button" className="titlefoot-link" onClick={titleBlock.onPick}>
            {titleBlock.named ? 'Change boxes' : 'Read from title block…'}
          </button>
        </div>
      )}

      <div className="panefoot">
        {input.pageCount === 0
          ? (pending ?? 'No sheets')
          : selection.pages.size > 1
            ? `${selection.pages.size} of ${input.pageCount} sheets selected`
            : `${input.pageCount} sheets · ${withTakeoff} with takeoff`}
      </div>
    </>
  )
}

/**
 * What is drawn on a sheet, as dots in the scopes' own colours.
 *
 * On the RIGHT of the row, beside the page number, because that is where the
 * eye lands after the number and the title — and because a dot on the left
 * used to be the only signal, in ink, saying "something is here" without
 * saying what. A ceiling plan carrying the metal panel scope and the baffle
 * scope now shows amber and green; a sheet with markups that belong to no
 * scope shows a hollow dot, so the takeoff is not invisible just because it
 * is unfiled.
 *
 * The count past the cap is decided in `sheets.ts`; the page number never
 * moves because this cell has a budget and the number has its own.
 */
function SheetDots({ row }: { row: SheetRow }) {
  if (!row.hasTakeoff) return null
  const { shown, more } = sheetDots(row.scopes)
  const names = row.scopes.map((s) => s.label).join(', ')
  const said = names === ''
    ? 'Carries takeoff in no scope'
    : `${row.scopes.length === 1 ? 'Scope' : 'Scopes'} on this sheet: ${names}`
  return (
    <span className="sheetscopes" role="img" aria-label={said} title={said}>
      {shown.length === 0 && <span className="sheetdot unscoped" />}
      {shown.map((s) => (
        <span key={s.id} className="sheetdot" style={{ background: s.color }} />
      ))}
      {more > 0 && <span className="sheetmore">+{more}</span>}
    </span>
  )
}
