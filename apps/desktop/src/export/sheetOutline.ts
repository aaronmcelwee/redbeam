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
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, type PDFDocument } from 'pdf-lib'
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
  /** REDBEAM's bookmarks as found, leaves in tree order. */
  oursFound: Array<{ page: number | null, title: string, marked: boolean }>
  folderFound: boolean
  root: PDFDict | null
}

function plan(doc: PDFDocument, labels: ReadonlyArray<string | null>): Plan {
  const pages = doc.getPages()
  const pageIndex = new Map(pages.map((p, i) => [p.ref.toString(), i]))
  const old = ownPageLabels(doc)
  const named = (page: number | null, title: string): boolean =>
    page !== null && title !== '' && (old.get(page) === title || (labels[page] ?? null)?.trim() === title)
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
  return { kept, oursFound, folderFound, root: root instanceof PDFDict ? root : null }
}

function wanted(labels: ReadonlyArray<string | null>, pageCount: number): Array<{ page: number, title: string }> {
  const out: Array<{ page: number, title: string }> = []
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
export function writeSheetOutline(doc: PDFDocument, labels: ReadonlyArray<string | null>): PDFRef[] {
  const ctx = doc.context
  const pages = doc.getPages()
  const p = plan(doc, labels)
  const changed: PDFRef[] = []

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

  const fresh = new Set([...sheets, ...top.filter((t) => t.marked)].map((s) => s.ref.toString()))
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
