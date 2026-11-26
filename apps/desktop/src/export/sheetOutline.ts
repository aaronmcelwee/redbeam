/**
 * Sheet names as bookmarks.
 *
 * Page labels name the pages, but Bluebeam's Bookmarks panel is where
 * estimators look for a set's sheets, and labels alone leave it empty (Aaron,
 * 2026-11-25). So every named sheet also gets a bookmark, in page order.
 *
 * Bookmarks someone else made are kept as they are. REDBEAM's own are found
 * again on the next save and replaced, never added twice: they carry a
 * /RedbeamSheet key, and because another app's rewrite may drop that key, a
 * bookmark whose title is the label its page carried (or will carry) counts as
 * REDBEAM's too. That also folds a publisher's bookmark that already said
 * exactly the page's name into the new one rather than doubling it.
 *
 * With no other bookmarks in the file the sheets sit at the top level. With
 * some, they go in one open "Sheets" folder ahead of them, so the file's own
 * tree is left as its author arranged it.
 *
 * Everyone else's bookmarks are also the Contents panel's own list (Kenneth,
 * 2026-11-26: "one list, add your own, colour them, and Bluebeam shows the
 * same"). `readBookmarks` hands them to the panel with their colour, style
 * and view; when the estimator has changed them, the save passes the edited
 * tree back and `writeSheetOutline` writes it in their place. A bookmark read
 * from the file names its object (`src`), so one that was only recoloured or
 * renamed keeps its own action, a named destination included.
 */
import { PDFArray, PDFDict, PDFName, PDFNull, PDFNumber, PDFRef, type PDFDocument, type PDFPage } from 'pdf-lib'
import { pdfText } from './pdfMarkup.js'

/** The key on each bookmark REDBEAM writes: the page index, or -1 for the folder. */
export const MARK = 'RedbeamSheet'
export const FOLDER_TITLE = 'Sheets'

interface Item {
  ref: PDFRef
  dict: PDFDict
  title: string
  page: number | null
  marked: boolean
  children: Item[]
}

function titleOf(d: PDFDict): string {
  const t = d.lookup(PDFName.of('Title')) as { decodeText?: () => string } | undefined
  return typeof t?.decodeText === 'function' ? t.decodeText().trim() : ''
}

function pageOfDest(dest: unknown, pageIndex: ReadonlyMap<string, number>): number | null {
  if (!(dest instanceof PDFArray) || dest.size() === 0) return null
  const target = dest.get(0)
  if (target instanceof PDFRef) return pageIndex.get(target.toString()) ?? null
  if (target instanceof PDFNumber) return target.asNumber()
  return null
}

function pageOf(d: PDFDict, pageIndex: ReadonlyMap<string, number>): number | null {
  const dest = d.lookup(PDFName.of('Dest'))
  if (dest !== undefined) return pageOfDest(dest, pageIndex)
  const a = d.lookup(PDFName.of('A'))
  if (a instanceof PDFDict) {
    const s = a.lookup(PDFName.of('S'))
    if (s instanceof PDFName && s.decodeText() === 'GoTo') return pageOfDest(a.lookup(PDFName.of('D')), pageIndex)
  }
  return null
}

function readItems(doc: PDFDocument, holder: PDFDict, pageIndex: ReadonlyMap<string, number>, seen: Set<string>): Item[] {
  const out: Item[] = []
  let next = holder.get(PDFName.of('First'))
  while (next instanceof PDFRef && !seen.has(next.toString())) {
    seen.add(next.toString())
    const dict = doc.context.lookup(next)
    if (!(dict instanceof PDFDict)) break
    out.push({
      ref: next,
      dict,
      title: titleOf(dict),
      page: pageOf(dict, pageIndex),
      marked: dict.has(PDFName.of(MARK)),
      children: readItems(doc, dict, pageIndex, seen),
    })
    next = dict.get(PDFName.of('Next'))
  }
  return out
}

/** The /P label each page carries now, from a /PageLabels tree with its entries at the root. */
export function ownPageLabels(doc: PDFDocument): Map<number, string> {
  const out = new Map<number, string>()
  const tree = doc.catalog.lookup(PDFName.of('PageLabels'))
  if (!(tree instanceof PDFDict)) return out
  const nums = tree.lookup(PDFName.of('Nums'))
  if (!(nums instanceof PDFArray)) return out
  for (let i = 0; i + 1 < nums.size(); i += 2) {
    const k = nums.lookup(i)
    const v = nums.lookup(i + 1)
    if (!(k instanceof PDFNumber) || !(v instanceof PDFDict)) continue
    const p = v.lookup(PDFName.of('P')) as { decodeText?: () => string } | undefined
    if (typeof p?.decodeText === 'function') out.set(k.asNumber(), p.decodeText().trim())
  }
  return out
}

interface Plan {
  /** The file's own bookmarks, REDBEAM's taken out. */
  kept: Item[]
  pageIndex: ReadonlyMap<string, number>
  /** REDBEAM's bookmarks as found, leaves in tree order. */
  oursFound: Array<{ page: number | null, title: string, marked: boolean }>
  folderFound: boolean
  root: PDFDict | null
}

/**
 * With `labels` null the file has no sheet names of REDBEAM's, so only the
 * bookmarks marked as REDBEAM's are taken for its own: a publisher's bookmark
 * that happens to say a page's label is theirs, not ours.
 */
function plan(doc: PDFDocument, labels: ReadonlyArray<string | null> | null): Plan {
  const pages = doc.getPages()
  const pageIndex = new Map(pages.map((p, i) => [p.ref.toString(), i]))
  const old = labels === null ? new Map<number, string>() : ownPageLabels(doc)
  const named = (page: number | null, title: string): boolean =>
    labels !== null && page !== null && title !== ''
    && (old.get(page) === title || (labels[page] ?? null)?.trim() === title)
  const root = doc.catalog.lookup(PDFName.of('Outlines'))
  const items = root instanceof PDFDict ? readItems(doc, root, pageIndex, new Set()) : []
  const oursFound: Plan['oursFound'] = []
  let folderFound = false
  const leafOurs = (it: Item): boolean => it.children.length === 0 && (it.marked || named(it.page, it.title))
  const isFolderOurs = (it: Item): boolean => it.children.length > 0
    && ((it.marked && it.title === FOLDER_TITLE) || (it.title === FOLDER_TITLE && it.children.every(leafOurs)))
  const filter = (list: Item[]): Item[] => list.flatMap((it) => {
    if (leafOurs(it)) {
      oursFound.push({ page: it.page, title: it.title, marked: it.marked })
      return []
    }
    if (isFolderOurs(it)) {
      folderFound = true
      return filter(it.children)
    }
    return [{ ...it, children: filter(it.children) }]
  })
  const kept = filter(items)
  return { kept, pageIndex, oursFound, folderFound, root: root instanceof PDFDict ? root : null }
}

function wanted(labels: ReadonlyArray<string | null> | null, pageCount: number): Array<{ page: number, title: string }> {
  const out: Array<{ page: number, title: string }> = []
  if (labels === null) return out
  for (let i = 0; i < pageCount; i++) {
    const l = labels[i]?.trim() ?? ''
    if (l !== '') out.push({ page: i, title: l })
  }
  return out
}

/** Whether the file's bookmarks already hold exactly these sheet names, so nothing needs writing. */
export function sheetOutlineCurrent(doc: PDFDocument, labels: ReadonlyArray<string | null>): boolean {
  const p = plan(doc, labels)
  const want = wanted(labels, doc.getPageCount())
  if (p.oursFound.length !== want.length) return false
  if (p.kept.length > 0 && want.length > 0 && !p.folderFound) return false
  return want.every((w, i) => {
    const f = p.oursFound[i]!
    return f.marked && f.page === w.page && f.title === w.title
  })
}

/**
 * Write one bookmark per named sheet, replacing REDBEAM's earlier ones and
 * keeping everyone else's. Returns the existing objects it changed, for the
 * incremental update; new objects are registered on the document.
 */
export function writeSheetOutline(
  doc: PDFDocument,
  labels: ReadonlyArray<string | null> | null,
  bookmarks?: readonly FileBookmark[],
): PDFRef[] {
  const ctx = doc.context
  const pages = doc.getPages()
  const p = plan(doc, labels)
  const changed: PDFRef[] = []
  // The estimator's own list, when they changed it, stands in for the file's.
  const created = new Set<string>()
  if (bookmarks !== undefined) p.kept = itemsFor(doc, bookmarks, created)

  const sheets: Item[] = wanted(labels, pages.length).map(({ page, title }) => {
    const dict = ctx.obj({
      Title: pdfText(title),
      Dest: [pages[page]!.ref, PDFName.of('Fit')],
      [MARK]: PDFNumber.of(page),
    }) as PDFDict
    return { ref: ctx.register(dict), dict, title, page, marked: true, children: [] }
  })

  let top: Item[]
  if (p.kept.length === 0) top = sheets
  else if (sheets.length === 0) top = p.kept
  else {
    const dict = ctx.obj({ Title: pdfText(FOLDER_TITLE), [MARK]: PDFNumber.of(-1) }) as PDFDict
    top = [{ ref: ctx.register(dict), dict, title: FOLDER_TITLE, page: 0, marked: true, children: sheets }, ...p.kept]
    // The folder opens on its first sheet.
    dict.set(PDFName.of('Dest'), ctx.obj([pages[sheets[0]!.page!]!.ref, PDFName.of('Fit')]))
  }

  const fresh = new Set([...[...sheets, ...top.filter((t) => t.marked)].map((s) => s.ref.toString()), ...created])
  const isOpen = (it: Item): boolean => {
    if (it.marked) return true
    const c = it.dict.lookup(PDFName.of('Count'))
    return c instanceof PDFNumber && c.asNumber() > 0
  }
  /** Links `list` under `parent`; returns how many of them show when `parent` is open. */
  const link = (parentRef: PDFRef, parent: PDFDict, list: Item[]): number => {
    let visible = 0
    list.forEach((it, i) => {
      const d = it.dict
      d.set(PDFName.of('Parent'), parentRef)
      if (i > 0) d.set(PDFName.of('Prev'), list[i - 1]!.ref); else d.delete(PDFName.of('Prev'))
      if (i < list.length - 1) d.set(PDFName.of('Next'), list[i + 1]!.ref); else d.delete(PDFName.of('Next'))
      const below = link(it.ref, d, it.children)
      if (it.children.length === 0) d.delete(PDFName.of('Count'))
      else d.set(PDFName.of('Count'), PDFNumber.of(isOpen(it) ? below : -below))
      visible += 1 + (it.children.length > 0 && isOpen(it) ? below : 0)
      if (!fresh.has(it.ref.toString())) changed.push(it.ref)
    })
    if (list.length === 0) {
      parent.delete(PDFName.of('First'))
      parent.delete(PDFName.of('Last'))
    } else {
      parent.set(PDFName.of('First'), list[0]!.ref)
      parent.set(PDFName.of('Last'), list[list.length - 1]!.ref)
    }
    return visible
  }

  const existingRoot = doc.catalog.get(PDFName.of('Outlines'))
  let rootRef: PDFRef
  let root: PDFDict
  if (existingRoot instanceof PDFRef && p.root !== null) {
    rootRef = existingRoot
    root = p.root
    changed.push(rootRef)
  } else {
    root = ctx.obj({ Type: 'Outlines' }) as PDFDict
    rootRef = ctx.register(root)
    doc.catalog.set(PDFName.of('Outlines'), rootRef)
  }
  const count = link(rootRef, root, top)
  if (count > 0) root.set(PDFName.of('Count'), PDFNumber.of(count)); else root.delete(PDFName.of('Count'))
  return changed
}

// ------------------------------------------------------ the editable list --

/**
 * Where a bookmark opens a sheet: the point at the top left of the window, in
 * points from the sheet's top left corner as it is shown (turned), and the
 * zoom, 1 being 100 %. Null zoom keeps the reader's.
 */
export interface BookmarkView {
  x: number
  y: number
  zoom: number | null
}

/** One bookmark in the Contents list: the file's, or one added in REDBEAM. */
export interface FileBookmark {
  /** Stable for the session: the file object it came from, or a new id. */
  id: string
  title: string
  /** 0-based sheet, or null for a folder that opens nothing. */
  page: number | null
  view: BookmarkView | null
  /** '#rrggbb', or null for the reader's default text colour. */
  color: string | null
  bold: boolean
  italic: boolean
  /** The outline item it was read from ("12 0 R"), or null when made here. */
  src: string | null
  children: FileBookmark[]
}

const hex2 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0')

function colorOfItem(d: PDFDict): string | null {
  const c = d.lookup(PDFName.of('C'))
  if (!(c instanceof PDFArray) || c.size() !== 3) return null
  const v = [0, 1, 2].map((i) => { const n = c.lookup(i); return n instanceof PDFNumber ? n.asNumber() : NaN })
  if (v.some((n) => !Number.isFinite(n))) return null
  // Black is every reader's default: no colour of its own.
  if (v.every((n) => n === 0)) return null
  return `#${v.map(hex2).join('')}`
}

function rgbOf(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  if (m === null) return null
  return [m[1]!, m[2]!, m[3]!].map((h) => Math.round(parseInt(h, 16) / 255 * 1000) / 1000) as [number, number, number]
}

function flagsOf(d: PDFDict): number {
  const f = d.lookup(PDFName.of('F'))
  return f instanceof PDFNumber ? f.asNumber() : 0
}

/** The crop box and turn a view is measured against. */
function frameOf(page: PDFPage) {
  const box = page.getCropBox()
  const rot = ((page.getRotation().angle % 360) + 360) % 360
  return { ...box, rot }
}

/** A point as shown (from the turned sheet's top left) to PDF user space. */
function toUser(page: PDFPage, x: number, y: number): [number, number] {
  const { x: cx, y: cy, width: cw, height: ch, rot } = frameOf(page)
  if (rot === 90) return [cx + y, cy + x]
  if (rot === 180) return [cx + cw - x, cy + y]
  if (rot === 270) return [cx + cw - y, cy + ch - x]
  return [cx + x, cy + ch - y]
}

/** PDF user space to a point as shown. */
function fromUser(page: PDFPage, ux: number, uy: number): [number, number] {
  const { x: cx, y: cy, width: cw, height: ch, rot } = frameOf(page)
  if (rot === 90) return [uy - cy, ux - cx]
  if (rot === 180) return [cx + cw - ux, uy - cy]
  if (rot === 270) return [cy + ch - uy, cx + cw - ux]
  return [ux - cx, cy + ch - uy]
}

function destOf(d: PDFDict): unknown {
  const dest = d.lookup(PDFName.of('Dest'))
  if (dest !== undefined) return dest
  const a = d.lookup(PDFName.of('A'))
  if (a instanceof PDFDict) {
    const s = a.lookup(PDFName.of('S'))
    if (s instanceof PDFName && s.decodeText() === 'GoTo') return a.lookup(PDFName.of('D'))
  }
  return undefined
}

function viewOf(d: PDFDict, page: number | null, pages: readonly PDFPage[]): BookmarkView | null {
  const dest = destOf(d)
  if (page === null || !(dest instanceof PDFArray) || dest.size() < 2) return null
  const kind = dest.lookup(1)
  if (!(kind instanceof PDFName) || kind.decodeText() !== 'XYZ') return null
  const num = (i: number): number | null => {
    const n = i < dest.size() ? dest.lookup(i) : undefined
    return n instanceof PDFNumber ? n.asNumber() : null
  }
  const left = num(2)
  const top = num(3)
  const zoom = num(4)
  if (left === null && top === null) return null
  const pg = pages[page]
  if (pg === undefined) return null
  const box = pg.getCropBox()
  const [x, y] = fromUser(pg, left ?? box.x, top ?? box.y + box.height)
  return { x: round2(x), y: round2(y), zoom: zoom === null || zoom <= 0 ? null : round2(zoom * 100) / 100 }
}

const round2 = (n: number) => Math.round(n * 100) / 100

function toBookmark(it: Item, pages: readonly PDFPage[]): FileBookmark {
  const f = flagsOf(it.dict)
  return {
    id: it.ref.toString(),
    title: it.title,
    page: it.page,
    view: viewOf(it.dict, it.page, pages),
    color: colorOfItem(it.dict),
    bold: (f & 2) !== 0,
    italic: (f & 1) !== 0,
    src: it.ref.toString(),
    children: it.children.map((c) => toBookmark(c, pages)),
  }
}

/**
 * The file's bookmarks as the Contents list shows them: everything but the
 * sheet names REDBEAM writes (the panel lists the sheets itself).
 */
export function readBookmarks(doc: PDFDocument, labels: ReadonlyArray<string | null> | null): FileBookmark[] {
  const pages = doc.getPages()
  return plan(doc, labels).kept.map((it) => toBookmark(it, pages))
}

/** What a list says, ids and file objects left out: two lists that say the same compare equal. */
export function bookmarksKey(list: readonly FileBookmark[]): string {
  const one = (b: FileBookmark): unknown => [
    b.title, b.page, b.view === null ? null : [Math.round(b.view.x), Math.round(b.view.y), b.view.zoom],
    b.color?.toLowerCase() ?? null, b.bold, b.italic, b.children.map(one),
  ]
  return JSON.stringify(list.map(one))
}

/** Whether the file's bookmarks already say exactly this list. */
export function bookmarksCurrent(
  doc: PDFDocument, labels: ReadonlyArray<string | null> | null, bookmarks: readonly FileBookmark[],
): boolean {
  return bookmarksKey(readBookmarks(doc, labels)) === bookmarksKey(bookmarks)
}

/** The outline items for an edited list, reusing the file's own objects where they still are. */
function itemsFor(doc: PDFDocument, list: readonly FileBookmark[], created: Set<string>): Item[] {
  const ctx = doc.context
  const pages = doc.getPages()
  const pageIndex = new Map(pages.map((p, i) => [p.ref.toString(), i]))
  // Every outline item the file holds now, by object.
  const inFile = new Map<string, Item>()
  const root = doc.catalog.lookup(PDFName.of('Outlines'))
  if (root instanceof PDFDict) {
    const walk = (items: Item[]) => items.forEach((it) => { inFile.set(it.ref.toString(), it); walk(it.children) })
    walk(readItems(doc, root, pageIndex, new Set()))
  }
  const used = new Set<string>()
  const destFor = (b: FileBookmark): PDFArray | null => {
    if (b.page === null) return null
    const pg = pages[b.page]
    if (pg === undefined) return null
    if (b.view === null) return ctx.obj([pg.ref, PDFName.of('Fit')]) as PDFArray
    const [left, top] = toUser(pg, b.view.x, b.view.y)
    return ctx.obj([pg.ref, PDFName.of('XYZ'), round2(left), round2(top),
      b.view.zoom === null ? PDFNull : PDFNumber.of(b.view.zoom)]) as PDFArray
  }
  const build = (b: FileBookmark): Item => {
    const found = b.src !== null && !used.has(b.src) ? inFile.get(b.src) : undefined
    let dict: PDFDict
    let ref: PDFRef
    if (found !== undefined) {
      used.add(b.src!)
      dict = found.dict
      ref = found.ref
      // Its own destination stays unless it now goes somewhere else.
      const was = { page: found.page, view: viewOf(dict, found.page, pages) }
      const same = was.page === b.page && JSON.stringify(was.view) === JSON.stringify(b.view)
      if (!same) {
        dict.delete(PDFName.of('A'))
        const dest = destFor(b)
        if (dest === null) dict.delete(PDFName.of('Dest')); else dict.set(PDFName.of('Dest'), dest)
      }
    } else {
      dict = ctx.obj({}) as PDFDict
      ref = ctx.register(dict)
      created.add(ref.toString())
      const dest = destFor(b)
      if (dest !== null) dict.set(PDFName.of('Dest'), dest)
    }
    dict.set(PDFName.of('Title'), pdfText(b.title))
    const rgb = b.color === null ? null : rgbOf(b.color)
    if (rgb === null) dict.delete(PDFName.of('C')); else dict.set(PDFName.of('C'), ctx.obj(rgb))
    const flags = (b.italic ? 1 : 0) | (b.bold ? 2 : 0)
    if (flags === 0) dict.delete(PDFName.of('F')); else dict.set(PDFName.of('F'), PDFNumber.of(flags))
    dict.delete(PDFName.of(MARK))
    return { ref, dict, title: b.title, page: b.page, marked: false, children: b.children.map(build) }
  }
  return list.map(build)
}
