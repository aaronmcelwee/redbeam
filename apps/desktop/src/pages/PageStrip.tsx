/**
 * Page navigation: a thumbnail strip plus a go-to-page control.
 *
 * Thumbnails come from the viewer's own cache, which is separate from the tile
 * cache and gated behind the same quiet window — a strip never competes with
 * the page under the cursor. This component asks for them and forgets; the
 * viewer decides when to actually rasterize.
 */
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { cellWidth, COLUMNS_KEY, parseColumns, renderWidth, stepColumns } from './thumbSize.js'
import { hasSheetActions, SheetMenu, type SheetActions } from '../shell/SheetMenu.js'
import {
  clickSheet, describeSelection, EMPTY_SELECTION, rightClickSheet, selectedInOrder,
  type SheetSelection,
} from '../shell/sheetSelection.js'

export interface PageStripProps extends SheetActions {
  pageCount: number
  current: number
  /** Ask the viewer for a thumbnail. Returns one immediately if cached. */
  requestThumbnail: (index: number, width?: number) => ImageBitmap | undefined
  onGoTo: (index: number) => void
  /** Page labels where a document has them; falls back to the number. */
  labels?: Record<number, string>
  thumbWidth?: number
  /** Pages either side of the current one to load without waiting for scroll. */
  eagerRadius?: number
  /**
   * What to say when there are no pages. The strip used to render nothing at
   * all, which in a pane titled Thumbnails is a blank with no explanation —
   * and the caller is the one who knows whether that blank is "no document"
   * or "still opening".
   */
  empty?: string
  /**
   * Each page's rotation in degrees. A thumbnail drawn before a turn is
   * redrawn when its page's rotation changes.
   */
  rotationOf?: (index: number) => number
}

export function PageStrip({
  pageCount,
  current,
  requestThumbnail,
  onGoTo,
  labels,
  thumbWidth = 80,
  eagerRadius = 6,
  empty,
  rotationOf,
  onSetScale, onRotate, onPrint,
}: PageStripProps) {
  const [entry, setEntry] = useState('')
  const [selection, setSelection] = useState<SheetSelection>(EMPTY_SELECTION)
  const [menu, setMenu] = useState<{ x: number, y: number, pages: number[] } | null>(null)
  const actions: SheetActions = {
    ...(onSetScale !== undefined ? { onSetScale } : {}),
    ...(onRotate !== undefined ? { onRotate } : {}),
    ...(onPrint !== undefined ? { onPrint } : {}),
  }
  const all = Array.from({ length: Math.max(0, pageCount) }, (_, i) => i)
  const labelOf = (i: number) => labels?.[i] ?? String(i + 1)
  const stripRef = useRef<HTMLDivElement>(null)

  /*
   * In the side pane the strip is a grid: each thumbnail fills its column
   * and is rendered at the screen's density (thumbSize.ts). The horizontal
   * strip keeps `thumbWidth`. Ctrl+wheel over the grid changes the columns.
   */
  const [columns, setColumns] = useState(() => {
    try { return parseColumns(localStorage.getItem(COLUMNS_KEY)) } catch { return parseColumns(null) }
  })
  const [shown, setShown] = useState<{ css: number; px: number }>(() => ({ css: thumbWidth, px: renderWidth(thumbWidth, globalThis.devicePixelRatio ?? 1) }))
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const measure = () => {
      const style = getComputedStyle(strip)
      const dpr = globalThis.devicePixelRatio ?? 1
      if (style.display !== 'grid') { setShown({ css: thumbWidth, px: renderWidth(thumbWidth, dpr) }); return }
      const gap = Number.parseFloat(style.columnGap) || 0
      const padding = Number.parseFloat(style.paddingLeft) || 0
      const cell = strip.querySelector<HTMLElement>('.thumb')
      const cs = cell === null ? null : getComputedStyle(cell)
      const chrome = cs === null ? 8
        : (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0)
          + (Number.parseFloat(cs.borderLeftWidth) || 0) + (Number.parseFloat(cs.borderRightWidth) || 0)
      const css = cellWidth(strip.clientWidth, columns, gap, padding, chrome)
      const px = renderWidth(css, dpr)
      setShown((was) => (was.css === css && was.px === px ? was : { css, px }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(strip)
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey) || getComputedStyle(strip).display !== 'grid') return
      e.preventDefault()
      setColumns((c) => {
        const next = stepColumns(c, e.deltaY)
        try { localStorage.setItem(COLUMNS_KEY, String(next)) } catch { /* remembered for this session only */ }
        return next
      })
    }
    strip.addEventListener('wheel', onWheel, { passive: false })
    return () => { ro.disconnect(); strip.removeEventListener('wheel', onWheel) }
  }, [columns, thumbWidth, pageCount > 0])

  // Keep the active page in view when it changes from outside (search, undo
  // navigating to its target).
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-page="${current}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [current])

  if (pageCount <= 0) {
    return empty === undefined ? null : <div className="paneempty pending">{empty}</div>
  }

  const commitEntry = () => {
    const n = Number.parseInt(entry, 10)
    setEntry('')
    // The control is 1-based because that is how an estimator refers to a
    // sheet; page_number and the viewer index are both 0-based.
    if (Number.isFinite(n) && n >= 1 && n <= pageCount) onGoTo(n - 1)
  }

  return (
    <div className="pagestrip">
      <div className="pagenav">
        <button onClick={() => onGoTo(Math.max(0, current - 1))} disabled={current <= 0} title="Previous page">‹</button>
        <input
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commitEntry() }}
          onBlur={() => setEntry('')}
          placeholder={String(current + 1)}
          aria-label={`Go to page (1 to ${pageCount})`}
          size={4}
        />
        <span className="muted">/ {pageCount}</span>
        <button
          onClick={() => onGoTo(Math.min(pageCount - 1, current + 1))}
          disabled={current >= pageCount - 1}
          title="Next page"
        >›</button>
      </div>

      <div className="thumbs" ref={stripRef} style={{ '--thumb-cols': columns } as CSSProperties}>
        {all.map((i) => (
          <Thumb
            key={`${i}:${rotationOf?.(i) ?? 0}`}
            index={i}
            active={i === current}
            picked={selection.pages.size > 1 && selection.pages.has(i)}
            onPick={(e) => {
              setSelection((prev) => clickSheet(prev, i, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey }, all))
              // A modified click builds a selection; only a plain one turns the page.
              if (!e.shiftKey && !e.ctrlKey && !e.metaKey) onGoTo(i)
            }}
            onMenu={hasSheetActions(actions) ? (e) => {
              e.preventDefault()
              const next = rightClickSheet(selection, i)
              setSelection(next)
              setMenu({ x: e.clientX, y: e.clientY, pages: selectedInOrder(next) })
            } : undefined}
            label={labels?.[i] ?? String(i + 1)}
            width={shown.css}
            renderPx={shown.px}
            eager={Math.abs(i - current) <= eagerRadius}
            request={requestThumbnail}
          />
        ))}
      </div>
      {selection.pages.size > 1 && (
        <div className="panefoot">{selection.pages.size} of {pageCount} pages selected · right-click for actions</div>
      )}
      {menu !== null && (
        <SheetMenu
          at={menu}
          pages={menu.pages}
          heading={describeSelection({ pages: new Set(menu.pages), anchor: null }, labelOf)}
          actions={actions}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

function Thumb({
  index, active, picked, label, width, renderPx, eager, request, onPick, onMenu,
}: {
  index: number
  active: boolean
  /** Part of a multi-page selection. */
  picked: boolean
  label: string
  /** CSS pixels it is shown at. */
  width: number
  /** Pixels it is rendered at: `width` at the screen's density. */
  renderPx: number
  /** Load without waiting to be scrolled into view. */
  eager: boolean
  request: (index: number, width?: number) => ImageBitmap | undefined
  onPick: (e: ReactMouseEvent) => void
  onMenu: ((e: ReactMouseEvent) => void) | undefined
}) {
  const hostRef = useRef<HTMLButtonElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const draw = () => {
      if (cancelled) return
      const bmp = request(index, renderPx)
      if (!bmp) {
        // Queued behind visible tiles by design; poll rather than block. A
        // map lookup, so polling often costs nothing and shows it sooner.
        timer = setTimeout(draw, 100)
        return
      }
      const c = canvasRef.current
      if (!c) return
      c.width = bmp.width
      c.height = bmp.height
      c.getContext('2d')?.drawImage(bmp, 0, 0)
      setReady(true)
    }

    // Pages near the current one load straight away; the rest wait until they
    // are scrolled toward.
    //
    // Requesting all of them up front is what a naive strip does, and on a
    // 75-page 97MB set it queued 75 fit-zoom rasterizations — nothing is culled
    // at fit zoom, so each is expensive — and the tiles for the page the user
    // was looking at waited behind the lot. Measured: ~30s to first paint,
    // versus ~2s once the flood is gone.
    //
    // The eager window matters beyond speed: an IntersectionObserver never
    // fires in a zero-size viewport (a hidden window, a collapsed pane), and a
    // strip that silently renders nothing there would be worse than one that
    // is merely slow. The observer is the optimisation; the window is the
    // guarantee.
    if (eager) { draw(); return () => { cancelled = true; if (timer) clearTimeout(timer) } }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          draw()
        }
      },
      // A screenful ahead, so scrolling finds them drawn.
      { root: host.closest('.thumbs'), rootMargin: '100% 0px' },
    )
    io.observe(host)

    return () => { cancelled = true; io.disconnect(); if (timer) clearTimeout(timer) }
  }, [index, renderPx, eager, request])

  return (
    <button
      ref={hostRef}
      className={`thumb${active ? ' active' : ''}${picked ? ' picked' : ''}`}
      data-page={index}
      aria-selected={picked}
      onClick={onPick}
      onContextMenu={onMenu}
      title={`Page ${label}`}
    >
      <canvas ref={canvasRef} style={{ width, minHeight: ready ? undefined : 40, opacity: ready ? 1 : 0 }} />
      <span>{label}</span>
    </button>
  )
}
