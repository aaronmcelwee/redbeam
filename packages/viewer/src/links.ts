/**
 * The PDF's own hyperlinks: a sheet reference that jumps to its sheet, or a
 * web address.
 *
 * A set that went through Bluebeam's Batch Link, or was exported from Revit
 * with sheet links on, carries a link annotation over every detail bubble and
 * sheet number. Every PDF viewer follows them on a click; REDBEAM drew them and
 * did nothing.
 *
 * Read with the link API rather than the annotation walk because a link's
 * destination lives on the link (FPDFLink_GetDest) or on its action, and the
 * annotation surface reaches neither. Rectangles come back NORMALIZED, y down,
 * against the same page box as text and annotations.
 *
 * Injected backend, as with text: the tests run without wasm.
 */

import { normalizeBox, type NormBox, type PageBox } from './text.js'
import { PDFACTION_GOTO, type WasmStrings } from './outline.js'

/** PDFACTION_URI: a web address. */
export const PDFACTION_URI = 3

export interface PageLink {
  /** Where the link sits, normalized to the page box, y down. */
  rect: NormBox
  /** The 0-based page it jumps to, when it jumps inside this document. */
  page?: number
  /** The address it opens, when it is a web link. */
  uri?: string
}

/** The minimum PDFium surface this needs. Handles are opaque; 0 means none. */
export interface LinkBackend {
  /** Every link handle on the page, in FPDFLink_Enumerate order. */
  links(page: number): number[]
  /** FPDFLink_GetAnnotRect, unpacked. Null on failure. */
  rect(link: number): PageBox | null
  /** FPDFLink_GetDest. 0 when the link names no direct destination. */
  dest(link: number): number
  /** FPDFLink_GetAction. 0 when none. */
  action(link: number): number
  /** FPDFAction_GetType. */
  actionType(action: number): number
  /** FPDFAction_GetDest. 0 when none. */
  actionDest(action: number): number
  /** FPDFDest_GetDestPageIndex. Negative when the destination names no page. */
  destPage(dest: number): number
  /** FPDFAction_GetURIPath, decoded. '' when none. */
  uri(action: number): string
  /** The page's own box. */
  pageBox(page: number): PageBox
}

/** A page's links. Links that go nowhere this app can follow are left out. */
export function extractPageLinks(b: LinkBackend, page: number, pageCount: number): PageLink[] {
  const box = b.pageBox(page)
  const out: PageLink[] = []
  for (const link of b.links(page)) {
    const r = b.rect(link)
    if (r === null) continue
    const rect = normalizeBox(box, r)
    if (!(rect.x1 > rect.x0) || !(rect.y1 > rect.y0)) continue
    let target: number = -1
    let uri = ''
    const d = b.dest(link)
    if (d !== 0) target = b.destPage(d)
    else {
      const a = b.action(link)
      if (a !== 0) {
        const t = b.actionType(a)
        if (t === PDFACTION_GOTO) {
          const ad = b.actionDest(a)
          if (ad !== 0) target = b.destPage(ad)
        } else if (t === PDFACTION_URI) {
          uri = b.uri(a).trim()
        }
      }
    }
    if (target >= 0 && target < pageCount) out.push({ rect, page: target })
    else if (/^(https?:|mailto:)/i.test(uri)) out.push({ rect, uri })
  }
  return out
}

/** The link under a normalized point, the smallest when they overlap. */
export function linkAt(links: readonly PageLink[], p: { x: number; y: number }): PageLink | null {
  let best: PageLink | null = null
  let bestArea = Infinity
  for (const l of links) {
    const r = l.rect
    if (p.x < r.x0 || p.x > r.x1 || p.y < r.y0 || p.y > r.y1) continue
    const area = (r.x1 - r.x0) * (r.y1 - r.y0)
    if (area < bestArea) { best = l; bestArea = area }
  }
  return best
}

// ------------------------------------------------------------ pdfium glue --

export interface PdfiumLinkLike extends WasmStrings {
  pdfium: WasmStrings['pdfium'] & { HEAPF32: Float32Array; HEAP32: Int32Array }
  FPDFLink_Enumerate(page: number, startPos: number, linkAnnot: number): number | boolean
  FPDFLink_GetAnnotRect(link: number, rect: number): number | boolean
  FPDFLink_GetDest(doc: number, link: number): number
  FPDFLink_GetAction(link: number): number
  FPDFAction_GetType(action: number): number
  FPDFAction_GetDest(doc: number, action: number): number
  FPDFDest_GetDestPageIndex(doc: number, dest: number): number
  FPDFAction_GetURIPath(doc: number, action: number, buffer: number, buflen: number): number
}


export function createPdfiumLinkBackend(
  m: PdfiumLinkLike, doc: number, pageBox: (page: number) => PageBox,
): LinkBackend {
  const malloc = (n: number): number => m.pdfium.wasmExports.malloc(n)
  const free = (p: number): void => { m.pdfium.wasmExports.free?.(p) }
  return {
    links: (page) => {
      const pos = malloc(4)
      const out = malloc(4)
      const found: number[] = []
      try {
        m.pdfium.HEAP32[pos >> 2] = 0
        /*
         * Every link on the page; there used to be a 5,000 ceiling (Aaron,
         * 2026-11-24: no arbitrary caps). What ends a runaway instead is the
         * cursor: PDFium moves `pos` past each link it returns, so a cursor
         * that did not move means the enumeration is going nowhere.
         */
        let last = -1
        while (m.FPDFLink_Enumerate(page, pos, out)) {
          const at = m.pdfium.HEAP32[pos >> 2] ?? 0
          if (at <= last) break
          last = at
          const h = m.pdfium.HEAP32[out >> 2] ?? 0
          if (h !== 0) found.push(h)
        }
      } finally {
        free(pos); free(out)
      }
      return found
    },
    rect: (link) => {
      const ptr = malloc(16)
      try {
        if (!m.FPDFLink_GetAnnotRect(link, ptr)) return null
        const f32 = m.pdfium.HEAPF32
        const i = ptr >> 2
        // FS_RECTF { left, top, right, bottom }
        return { left: f32[i]!, top: f32[i + 1]!, right: f32[i + 2]!, bottom: f32[i + 3]! }
      } finally {
        free(ptr)
      }
    },
    dest: (link) => m.FPDFLink_GetDest(doc, link) || 0,
    action: (link) => m.FPDFLink_GetAction(link) || 0,
    actionType: (a) => m.FPDFAction_GetType(a),
    actionDest: (a) => m.FPDFAction_GetDest(doc, a) || 0,
    destPage: (d) => m.FPDFDest_GetDestPageIndex(doc, d),
    uri: (a) => {
      // 7-bit ASCII, NUL-terminated, sized by a first call: not UTF-16.
      const n = m.FPDFAction_GetURIPath(doc, a, 0, 0)
      if (!(n > 1)) return ''
      const ptr = malloc(n)
      try {
        m.FPDFAction_GetURIPath(doc, a, ptr, n)
        const heap = m.pdfium.HEAPU8
        let s = ''
        for (let i = 0; i < n - 1; i++) s += String.fromCharCode(heap[ptr + i] ?? 0)
        return s.replace(/\u0000+$/, '')
      } finally {
        free(ptr)
      }
    },
    pageBox,
  }
}

