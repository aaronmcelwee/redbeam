/// <reference lib="webworker" />
/**
 * PDFium rasterization worker.
 *
 * Everything expensive happens here so it never touches the frame budget on the
 * main thread. Measured on the Barclays PKG A page 48 (325,868 vector paths):
 * tiles cost 24-98ms each, and main-thread frame work during a cold pan stayed
 * at p99 ~6.9ms with 0% of frames over the 16.7ms budget.
 *
 * Two things changed for multi-page:
 *
 * - Several page handles stay open (`PagePool`, LRU-bounded), instead of one,
 *   so paging back and forth does not re-parse the content stream every time.
 *   Handles are native resources; the pool closes what it evicts and reports
 *   opened/closed/open counts so a leak is observable rather than theoretical.
 *
 * - `onmessage` no longer rasterizes. It enqueues, and `Scheduler` picks the
 *   highest-priority job. Otherwise speculative prefetch, being posted earlier,
 *   would run ahead of the tile the user is waiting on.
 */
import { RangeReader, xhrRange } from './rangeReader.js'
import { init } from '@embedpdf/pdfium'
import { type Job } from './jobQueue.js'
import { PagePool } from './pagePool.js'
import { Scheduler } from './scheduler.js'
import {
  createPdfiumGeometryBackend,
  extractPageGeometry,
  type GeometryBackend,
  type PdfiumLike,
} from './geometry.js'
import {
  createPdfiumOutlineBackend,
  extractDocumentIndex,
  type OutlineBackend,
  type PdfiumOutlineLike,
} from './outline.js'
import { extractPageText, type PageBox, type TextBackend } from './text.js'
import { extractPageAnnotations, type AnnotBackend, type AnnotPoint } from './annots.js'
import { rotateFlatPoints, rotateNormBox, rotateNormPoint, wrapTurns } from './rotation.js'
import { createPdfiumLinkBackend, extractPageLinks, type PageLink, type PdfiumLinkLike } from './links.js'
import {
  INDEX_KEY, PRIORITY_INDEX, PRIORITY_VISIBLE, tileExtent,
  type PageInfo, type WorkerRequest, type WorkerResponse,
} from './types.js'

// The pdfium JS wrapper is untyped for our purposes; keep the `any` contained
// to this file rather than leaking it into the viewer API.
/* eslint-disable @typescript-eslint/no-explicit-any */
let pdfium: any = null
let doc: number | null = null
let pool: PagePool<number> | null = null
let pageSizes: PageInfo[] = []

/** How many PDFium page handles stay open. */
let maxPages = 4

/**
 * Ordering lives in Scheduler (see that file for why the quiet gate exists).
 * `onmessage` only enqueues; nothing rasterizes on the message turn.
 */
const sched = new Scheduler({ run: (job) => run(job), quietMs: 60 })

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

const post = (msg: WorkerResponse, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? [])

/**
 * Resolved once the document is open. Every request other than `boot`/`config`
 * waits on it, because the host posts `page` and `tile` without waiting for
 * `booted` and PDFium is not there yet. (The old code papered over this with a
 * 50ms setTimeout in the app.) Messages awaiting one promise resume in the
 * order they awaited, so request ordering survives.
 */
let resolveBoot: () => void = () => {}
let rejectBoot: (e: unknown) => void = () => {}
const booted = new Promise<void>((res, rej) => {
  resolveBoot = res
  rejectBoot = rej
})
// The rejection is reported through the `error` response of whichever request
// was waiting; this keeps it from also surfacing as an unhandled rejection.
void booted.catch(() => {})

// ------------------------------------------------------------------- boot --

async function boot(wasmUrl: string, pdfUrl: string) {
  const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer()
  pdfium = await init({ wasmBinary })
  pdfium.PDFiumExt_Init()

  doc = openByRanges(pdfUrl)
  if (doc === null) {
    const { ptr, length } = await fetchIntoHeap(pdfUrl)
    doc = pdfium.FPDF_LoadMemDocument(ptr, length, '')
  }
  if (!doc) throw new Error('PDFium could not open the PDF')

  pool = new PagePool<number>({
    max: maxPages,
    open: (index) => {
      const h = pdfium.FPDF_LoadPage(doc, index)
      if (!h) throw new Error(`FPDF_LoadPage(${index}) failed`)
      return h
    },
    close: (h) => pdfium.FPDF_ClosePage(h),
    measure: (h) => ({ width: pdfium.FPDF_GetPageWidthF(h), height: pdfium.FPDF_GetPageHeightF(h) }),
  })

  const count: number = pdfium.FPDF_GetPageCount(doc)
  pageSizes = readAllPageSizes(count)
  resolveBoot()
  post({ type: 'booted', pageCount: count, sizes: pageSizes })
}

/**
 * Open the PDF reading only the byte ranges PDFium asks for.
 *
 * The desktop app serves drawings through `rbdoc:`, which answers Range
 * requests from the file on disk, so a 500 MB set never has to be in memory
 * whole: PDFium reads the trailer and cross-reference table, then the objects
 * of the pages it draws. Null when the URL does not take ranges (a blob URL),
 * and the caller reads the file whole instead.
 *
 * FPDF_FILEACCESS keeps the length in an `unsigned long`, which is 32 bits in
 * this WebAssembly build, so PDFium itself cannot address past 4 GiB.
 */
function openByRanges(url: string): number | null {
  if (url.startsWith('blob:') || url.startsWith('data:') || typeof XMLHttpRequest === 'undefined') return null
  let probe: ReturnType<typeof xhrRange>
  try {
    probe = xhrRange(url, 0, 1)
  } catch {
    return null
  }
  if (probe === null || probe.total === null || probe.total <= 0) return null
  const size = probe.total
  if (size > 0xffffffff) throw new Error(`This PDF is ${Math.round(size / 1073741824)} GB; the PDF engine can only address 4 GB.`)
  const reader = new RangeReader(size, (a, b) => {
    const got = xhrRange(url, a, b)
    if (got === null) throw new Error('the drawing stopped answering range reads')
    return got.bytes
  })
  const m = pdfium.pdfium
  const getBlock = m.addFunction((_param: number, position: number, buf: number, size: number) => {
    try {
      // HEAPU8 is read at each call: the heap may have grown since the last.
      return reader.read(position >>> 0, size >>> 0, m.HEAPU8.subarray(buf, buf + (size >>> 0))) ? 1 : 0
    } catch (err) {
      console.warn('[pdf] block read failed', err)
      return 0
    }
  }, 'iiiii')
  // FPDF_FILEACCESS { unsigned long m_FileLen; GetBlock*; void* m_Param } — 12 bytes.
  const access: number = m.wasmExports.malloc(12)
  m.HEAPU32[access >> 2] = size >>> 0
  m.HEAPU32[(access >> 2) + 1] = getBlock
  m.HEAPU32[(access >> 2) + 2] = 0
  const handle: number = pdfium.FPDF_LoadCustomDocument(access, '')
  if (!handle) {
    m.removeFunction(getBlock)
    m.wasmExports.free(access)
    return null
  }
  // The loader and its struct live as long as the document: this worker holds
  // one document and is thrown away with it.
  rangeStats = reader
  return handle
}

/** The open document's range reader, when it was opened that way. */
let rangeStats: RangeReader | null = null

/**
 * Fetch the PDF straight into PDFium's heap.
 *
 * Reading it into an ArrayBuffer first and copying that in held the file twice
 * in this worker, which for a 470 MB specifications book was close to a
 * gigabyte at once. When the response says how long it is (a blob URL does),
 * the body streams into the heap chunk by chunk instead.
 */
async function fetchIntoHeap(url: string): Promise<{ ptr: number, length: number }> {
  const res = await fetch(url)
  const declared = Number(res.headers.get('content-length') ?? '')
  const reader = Number.isFinite(declared) && declared > 0 ? res.body?.getReader() : undefined
  if (reader !== undefined) {
    const ptr: number = pdfium.pdfium.wasmExports.malloc(declared)
    if (!ptr) throw new Error(`could not set aside ${Math.round(declared / 1048576)} MB for the PDF`)
    let at = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (at + value.length > declared) {
        // Longer than it said: give up on streaming and read it whole.
        pdfium.pdfium.wasmExports.free(ptr)
        void reader.cancel()
        return copyIntoHeap(new Uint8Array(await (await fetch(url)).arrayBuffer()))
      }
      // HEAPU8 is re-read every chunk: the heap may have grown, which
      // replaces the view.
      pdfium.pdfium.HEAPU8.set(value, ptr + at)
      at += value.length
    }
    return { ptr, length: at }
  }
  return copyIntoHeap(new Uint8Array(await res.arrayBuffer()))
}

function copyIntoHeap(bytes: Uint8Array): { ptr: number, length: number } {
  const ptr: number = pdfium.pdfium.wasmExports.malloc(bytes.length)
  if (!ptr) throw new Error(`could not set aside ${Math.round(bytes.length / 1048576)} MB for the PDF`)
  pdfium.pdfium.HEAPU8.set(bytes, ptr)
  return { ptr, length: bytes.length }
}

/**
 * Page boxes for the whole document, without opening every page.
 *
 * FPDF_GetPageSizeByIndexF reads the box out of the page dictionary, so a
 * 200-sheet set costs one dictionary walk each rather than 200 content-stream
 * parses. The sizes have to be per-page: a details sheet is not the same size
 * as a plan, and every normalized coordinate and every calibration is relative
 * to the box of the page it was drawn on.
 */
function readAllPageSizes(count: number): PageInfo[] {
  const out: PageInfo[] = []
  const ptr = pdfium.pdfium.wasmExports.malloc(8) // FS_SIZEF { float width, height }
  try {
    for (let i = 0; i < count; i++) {
      let w = 0
      let h = 0
      const ok = pdfium.FPDF_GetPageSizeByIndexF?.(doc, i, ptr)
      if (ok) {
        const f32: Float32Array = pdfium.pdfium.HEAPF32
        w = f32[ptr >> 2] ?? 0
        h = f32[(ptr >> 2) + 1] ?? 0
      }
      if (!w || !h) {
        // Fall back to actually opening it. Correctness beats the shortcut.
        const e = pool!.acquire(i)
        w = e.width
        h = e.height
      }
      out.push({ width: w, height: h })
    }
  } finally {
    pdfium.pdfium.wasmExports.free(ptr)
    // Anything the fallback opened above is speculative. Close it so the pool
    // starts empty and only holds pages somebody actually asked for.
    pool!.closeAll()
  }
  return out
}

/**
 * The page's clockwise quarter turns as displayed (/Rotate). Text, paths,
 * links and annotations come back from PDFium in the unrotated page space,
 * and are turned by this before they leave the worker, so they line up with
 * the rendered sheet and with everything stored against it.
 */
function turnsOf(handle: number): 0 | 1 | 2 | 3 {
  const r = typeof pdfium?.FPDFPage_GetRotation === 'function' ? pdfium.FPDFPage_GetRotation(handle) as number : 0
  return wrapTurns(Number.isFinite(r) ? r : 0)
}

// ------------------------------------------------------------------ render --

/**
 * Render one tile. We render the FULL page transformed into a small bitmap
 * window; PDFium culls objects that fall outside it, which is why tile cost
 * drops sharply as you zoom in. (Poppler does not do this — its per-tile cost
 * is flat at ~1.7-2.6s on the same page regardless of output size.)
 */
/** Pages whose annotation flags this worker has rewritten. Cleared when none stay hidden. */
const flaggedPages = new Set<number>()

/**
 * Show or hide the page's own annotations without writing the PDF.
 *
 * FPDF_ANNOT_FLAG_HIDDEN is 2. Other flags are left alone. Returns false when
 * this PDFium build cannot set flags, so the caller can drop annotations from
 * the bitmap entirely rather than leave a "hidden" markup on screen.
 */
function applyHiddenFlags(handle: number, page: number, hidden: readonly number[]): boolean {
  const setFlags = pdfium?.FPDFAnnot_SetFlags
  const getFlags = pdfium?.FPDFAnnot_GetFlags
  const getCount = pdfium?.FPDFPage_GetAnnotCount
  const getAnnot = pdfium?.FPDFPage_GetAnnot
  if (typeof setFlags !== 'function' || typeof getFlags !== 'function'
      || typeof getCount !== 'function' || typeof getAnnot !== 'function') {
    return false
  }
  if (hidden.length === 0 && !flaggedPages.has(page)) return true
  const hide = new Set(hidden)
  const count = getCount(handle) as number
  for (let i = 0; i < count; i++) {
    const annot = getAnnot(handle, i) as number
    if (!annot) continue
    try {
      const flags = (getFlags(annot) as number) >>> 0
      const next = hide.has(i) ? (flags | 2) : (flags & ~2)
      if (next !== flags) setFlags(annot, next)
    } finally {
      if (typeof pdfium.FPDFPage_CloseAnnot === 'function') pdfium.FPDFPage_CloseAnnot(annot)
    }
  }
  if (hidden.length === 0) flaggedPages.delete(page)
  else flaggedPages.add(page)
  return true
}

function renderTile(
  handle: number,
  pw: number,
  ph: number,
  job: { page: number; tx: number; ty: number; tile: number; zoom: number; hidden?: number[]; annots?: false },
): ImageData {
  const { tx, ty, tile, zoom } = job
  const fullW = Math.round(pw * zoom)
  const fullH = Math.round(ph * zoom)
  /*
   * Clip the tile to the page.
   *
   * `renderInto` fills its whole bitmap white before drawing, because that
   * white IS the paper — PDFium paints no background of its own. So a tile
   * that runs past the page edge used to contribute a full tile of white
   * beyond it, and at a zoom where the scaled page is smaller than one tile
   * the result was a 512x512 white square with a 147x190 page in its corner.
   * That is what a letter-size spec sheet looked like at 24%.
   *
   * Sizing the bitmap to the intersection instead means the raster is exactly
   * the page and nothing more, at every zoom. The blit needs no change: it
   * draws each tile at its own natural size from the same tile origin, so an
   * edge tile is simply smaller.
   */
  const { bw, bh } = tileExtent(fullW, fullH, tile, tx, ty)
  return renderInto(handle, bw, bh, -tx * tile, -ty * tile, fullW, fullH, annotFlags(handle, job) | 0x10)
}

/**
 * Whether this raster draws the PDF's own annotations: 0x01 or 0.
 *
 * `annots: false` is the person (or an agent) switching every embedded markup
 * off to see the drawing underneath. Otherwise the per-page hidden list
 * applies; when flags cannot be set and something should be hidden, all are
 * omitted, a hide-all fallback rather than a no-op.
 */
function annotFlags(handle: number, job: { page: number; hidden?: number[]; annots?: boolean }): number {
  if (job.annots === false) return 0
  const hidden = job.hidden ?? []
  const flagsOk = applyHiddenFlags(handle, job.page, hidden)
  return flagsOk || hidden.length === 0 ? 0x01 : 0
}

/** Largest region render, in pixels. A 4096 square is 64 MB of wasm heap. */
const REGION_MAX_SIDE = 6000
const REGION_MAX_AREA = 24_000_000

/**
 * Render a box of the page at an exact pixel size.
 *
 * The same trick as a tile: the WHOLE page is laid out at the zoom that makes
 * the box `width` pixels wide, and the bitmap window is placed over the box.
 * PDFium culls what falls outside, so a small box at a high zoom costs about
 * what the detail in it costs.
 */
function renderRegion(
  handle: number,
  job: { page: number; x0: number; y0: number; x1: number; y1: number; width: number; height: number; annots: boolean; hidden?: number[] },
): ImageData {
  const bw = Math.max(1, Math.round(job.width))
  const bh = Math.max(1, Math.round(job.height))
  const bx = Math.max(1e-6, job.x1 - job.x0)
  const by = Math.max(1e-6, job.y1 - job.y0)
  const fullW = Math.round(bw / bx)
  const fullH = Math.round(bh / by)
  const flags = (job.annots ? annotFlags(handle, job) : 0) | 0x10
  return renderInto(handle, bw, bh, -Math.round(job.x0 * fullW), -Math.round(job.y0 * fullH), fullW, fullH, flags)
}

function renderInto(
  handle: number,
  bw: number,
  bh: number,
  ox: number,
  oy: number,
  fullW: number,
  fullH: number,
  flags = 0x01 | 0x10,
): ImageData {
  const bmp = pdfium.FPDFBitmap_Create(bw, bh, 4 /* BGRA */)
  try {
    pdfium.FPDFBitmap_FillRect(bmp, 0, 0, bw, bh, 0xffffffff)
    // FPDF_ANNOT (0x01) | FPDF_REVERSE_BYTE_ORDER (0x10).
    //
    // REVERSE_BYTE_ORDER gives RGBA directly, which is what ImageData wants.
    //
    // ANNOT renders the PDF's own annotation appearances. Without it a drawing
    // that already carries markups — anything round-tripped through Bluebeam,
    // which is most of a real bid set — renders with those markups MISSING,
    // and an estimator cannot tell that from a drawing that never had them.
    pdfium.FPDF_RenderPageBitmap(bmp, handle, ox, oy, fullW, fullH, 0, flags)

    const bufPtr = pdfium.FPDFBitmap_GetBuffer(bmp)
    const stride = pdfium.FPDFBitmap_GetStride(bmp)
    const heap: Uint8Array = pdfium.pdfium.HEAPU8
    const out = new Uint8ClampedArray(bw * bh * 4)
    for (let y = 0; y < bh; y++) {
      out.set(heap.subarray(bufPtr + y * stride, bufPtr + y * stride + bw * 4), y * bw * 4)
    }
    return new ImageData(out, bw, bh)
  } finally {
    pdfium.FPDFBitmap_Destroy(bmp)
  }
}

// -------------------------------------------------------------------- text --

/**
 * The PDFium surface `extractPageText` needs, and nothing else.
 *
 * Scratch memory is allocated once and reused: FPDFText_GetCharBox takes four
 * double out-parameters, and mallocing 32 bytes per character on a sheet with
 * thousands of them is pure churn. The buffer is read back through HEAPF64
 * fetched fresh each call, because the wasm heap can be resized underneath us
 * and a cached typed-array view would then be detached.
 */
let charBoxPtr = 0

function textBackend(): TextBackend {
  return {
    loadTextPage: (page) => pdfium.FPDFText_LoadPage(page) as number,
    closeTextPage: (tp) => pdfium.FPDFText_ClosePage(tp),
    countChars: (tp) => pdfium.FPDFText_CountChars(tp) as number,
    charCode: (tp, i) => pdfium.FPDFText_GetUnicode(tp, i) as number,
    charBox: (tp, i) => {
      if (!charBoxPtr) charBoxPtr = pdfium.pdfium.wasmExports.malloc(32)
      const p = charBoxPtr
      // FPDFText_GetCharBox(text_page, index, left, right, bottom, top)
      const ok = pdfium.FPDFText_GetCharBox(tp, i, p, p + 8, p + 16, p + 24)
      if (!ok) return null
      const d: Float64Array = pdfium.pdfium.HEAPF64
      const b = p >> 3
      return { left: d[b]!, right: d[b + 1]!, bottom: d[b + 2]!, top: d[b + 3]! }
    },
    pageBox: (page) => readPageBox(page),
  }
}

/**
 * PDFium's annotation surface, marshalled the same way the text backend is:
 * one malloc per call for the out-params, read back off the heap, freed.
 * Strings come back UTF-16LE with a terminator, sized by a first call with
 * no buffer.
 */
function annotBackend(): AnnotBackend {
  const P = pdfium
  const malloc = (n: number): number => P.pdfium.wasmExports.malloc(n) as number
  const free = (ptr: number): void => { P.pdfium.wasmExports.free(ptr) }
  const points = (ptr: number, n: number): AnnotPoint[] => {
    const f32: Float32Array = P.pdfium.HEAPF32
    const i = ptr >> 2
    const out: AnnotPoint[] = []
    for (let k = 0; k < n; k++) out.push({ x: f32[i + k * 2]!, y: f32[i + k * 2 + 1]! })
    return out
  }
  return {
    count: (page) => P.FPDFPage_GetAnnotCount(page) as number,
    open: (page, i) => P.FPDFPage_GetAnnot(page, i) as number,
    close: (a) => { P.FPDFPage_CloseAnnot(a) },
    subtype: (a) => P.FPDFAnnot_GetSubtype(a) as number,
    rect: (a) => {
      const ptr = malloc(16)
      try {
        if (!P.FPDFAnnot_GetRect(a, ptr)) return null
        const f32: Float32Array = P.pdfium.HEAPF32
        const i = ptr >> 2
        // FS_RECTF { left, top, right, bottom }
        return { left: f32[i]!, top: f32[i + 1]!, right: f32[i + 2]!, bottom: f32[i + 3]! }
      } finally {
        free(ptr)
      }
    },
    vertices: (a) => {
      const n = P.FPDFAnnot_GetVertices(a, 0, 0) as number
      if (!(n > 0)) return []
      const ptr = malloc(n * 8)
      try {
        P.FPDFAnnot_GetVertices(a, ptr, n)
        return points(ptr, n)
      } finally {
        free(ptr)
      }
    },
    line: (a) => {
      if (typeof P.FPDFAnnot_GetLine !== 'function') return null
      const ptr = malloc(16)
      try {
        if (!P.FPDFAnnot_GetLine(a, ptr, ptr + 8)) return null
        const [s, e] = points(ptr, 2)
        return [s!, e!]
      } finally {
        free(ptr)
      }
    },
    inkPaths: (a) => {
      const paths = P.FPDFAnnot_GetInkListCount(a) as number
      const out: AnnotPoint[][] = []
      for (let k = 0; k < paths; k++) {
        const n = P.FPDFAnnot_GetInkListPath(a, k, 0, 0) as number
        if (!(n > 0)) continue
        const ptr = malloc(n * 8)
        try {
          P.FPDFAnnot_GetInkListPath(a, k, ptr, n)
          out.push(points(ptr, n))
        } finally {
          free(ptr)
        }
      }
      return out
    },
    hasKey: (a, key) => typeof P.FPDFAnnot_HasKey === 'function' && Boolean(P.FPDFAnnot_HasKey(a, key)),
    stringValue: (a, key) => {
      // Bytes including the UTF-16 terminator; 2 means an empty string.
      const len = P.FPDFAnnot_GetStringValue(a, key, 0, 0) as number
      if (!(len > 2)) return ''
      const ptr = malloc(len)
      try {
        P.FPDFAnnot_GetStringValue(a, key, ptr, len)
        const heap: Uint8Array = P.pdfium.HEAPU8
        return new TextDecoder('utf-16le').decode(heap.subarray(ptr, ptr + len - 2))
      } finally {
        free(ptr)
      }
    },
    color: (a) => {
      const ptr = malloc(16)
      try {
        // FPDFANNOT_COLORTYPE_Color is 0: the stroke, not the interior.
        if (!P.FPDFAnnot_GetColor(a, 0, ptr, ptr + 4, ptr + 8, ptr + 12)) return null
        const u32: Uint32Array = P.pdfium.HEAPU32
        const i = ptr >> 2
        return { r: u32[i]!, g: u32[i + 1]!, b: u32[i + 2]!, a: u32[i + 3]! }
      } finally {
        free(ptr)
      }
    },
    pageBox: (page) => readPageBox(page),
  }
}

/**
 * The page's box in PDFium page space.
 *
 * Read, never assumed. On the real PKG A sheet this returns
 * (-1728, -1296.12, 1728, 1296.12) — an origin-centred CropBox — and character
 * boxes are expressed in that space. Deriving the box as (0, 0, width, height)
 * from FPDF_GetPageWidthF puts every text run half a sheet away from its
 * glyphs. FS_RECTF is { left, top, right, bottom } as four floats.
 */
function readPageBox(page: number): PageBox {
  const ptr = pdfium.pdfium.wasmExports.malloc(16)
  try {
    const ok = pdfium.FPDF_GetPageBoundingBox?.(page, ptr)
    if (ok) {
      const f32: Float32Array = pdfium.pdfium.HEAPF32
      const i = ptr >> 2
      const box = { left: f32[i]!, top: f32[i + 1]!, right: f32[i + 2]!, bottom: f32[i + 3]! }
      if (box.right - box.left > 0 && box.top - box.bottom > 0) return box
    }
  } finally {
    pdfium.pdfium.wasmExports.free(ptr)
  }
  // Only reached if PDFium refuses the box. Falling back to the page size is a
  // guess about the origin, which is the bug above — but a guess beats no text.
  return {
    left: 0,
    bottom: 0,
    right: pdfium.FPDF_GetPageWidthF(page) as number,
    top: pdfium.FPDF_GetPageHeightF(page) as number,
  }
}

// ------------------------------------------------------------------ index --

/**
 * The PDFium surface `extractDocumentIndex` needs, and nothing else.
 *
 * No cached scratch pointer here, unlike text and geometry: the two string
 * calls need a buffer sized to the string they are about to return, and a
 * whole document costs a few hundred short-lived mallocs rather than the
 * hundreds of thousands a segment walk makes.
 */
function outlineBackend(): OutlineBackend {
  return createPdfiumOutlineBackend(pdfium as PdfiumOutlineLike, doc!)
}

// ---------------------------------------------------------------- geometry --

/**
 * The PDFium surface `extractPageGeometry` needs, and nothing else.
 *
 * Scratch memory is allocated once and reused. A path segment's point is two
 * floats and there are 775,322 of them on the heavy sheet; mallocing per call
 * would dominate the walk. The heap view is fetched fresh every read, because
 * the wasm heap can be resized underneath us and a cached typed-array view
 * would then be detached.
 */
let geomPtr = 0

function geometryBackend(): GeometryBackend {
  // 6 floats for FS_MATRIX, 4 for a bounds rect, 2 for a point: 48 bytes covers
  // every out-parameter at a distinct offset, allocated once for the worker's
  // lifetime rather than per call on a 775,322-point walk.
  if (!geomPtr) geomPtr = pdfium.pdfium.wasmExports.malloc(48)
  // The page box comes from the worker's own reader, which is the same one the
  // text layer uses — one place decides what a page's box is.
  return createPdfiumGeometryBackend(pdfium as PdfiumLike, geomPtr, (page) => readPageBox(page))
}

// ------------------------------------------------------------------- queue --

async function run(job: Job) {
  if (!pool) return
  const t0 = now()
  if (job.kind === 'index') {
    // Handled BEFORE the pool is touched, deliberately. The outline lives in
    // the document catalog and FPDF_GetPageLabel takes a page index rather than
    // a handle, so indexing a 110-sheet set opens no pages and evicts nothing
    // the user is looking at. Same failure discipline as text and geometry:
    // report on the index message so only the waiting caller is rejected, never
    // throw and take the scheduler's drain loop — and every queued tile — down.
    try {
      const idx = extractDocumentIndex(outlineBackend(), pageSizes.length)
      post({ type: 'index', outline: idx.outline, labels: idx.labels, shape: idx.shape, ms: now() - t0 })
    } catch (err) {
      post({
        type: 'index',
        outline: [],
        labels: [],
        shape: 'none',
        ms: now() - t0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return
  }
  // Resolve the page index to a handle HERE, not when the job was queued. No
  // raw handle is ever stored outside the pool, so an eviction between queueing
  // and running is harmless — it just re-opens. This is the specific shape the
  // Qt build got wrong: global static maps keyed by raw page pointers, which
  // went stale when the tile manager reallocated underneath them.
  const entry = pool.acquire(job.page)
  if (job.kind === 'tile') {
    const img = renderTile(entry.handle, entry.width, entry.height, job)
    const bmp = await createImageBitmap(img)
    post(
      { type: 'tile', key: job.key, page: job.page, tx: job.tx, ty: job.ty, zoom: job.zoom, bmp, ms: now() - t0 },
      [bmp],
    )
  } else if (job.kind === 'text') {
    // Extraction failures are reported on the text message itself, so exactly
    // the request that was waiting is rejected. Letting this throw would take
    // the scheduler's drain loop down with it and stall every queued tile.
    try {
      const pt = extractPageText(textBackend(), entry.handle, job.page)
      const turns = turnsOf(entry.handle)
      if (turns !== 0) pt.runs = pt.runs.map((r) => rotateNormBox(r, turns))
      post({
        type: 'text',
        key: job.key,
        page: job.page,
        text: pt.text,
        runs: pt.runs,
        box: pt.box,
        charCount: pt.charCount,
        scanned: pt.scanned,
        ms: now() - t0,
      })
    } catch (err) {
      post({
        type: 'text',
        key: job.key,
        page: job.page,
        text: '',
        runs: [],
        box: { left: 0, bottom: 0, right: entry.width, top: entry.height },
        charCount: 0,
        scanned: true,
        ms: now() - t0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } else if (job.kind === 'annots') {
    // As text: a failure is reported on the annots message, so only the
    // waiting request is rejected and the drain loop keeps going.
    try {
      const turns = turnsOf(entry.handle)
      const annotations = extractPageAnnotations(annotBackend(), entry.handle, job.page).map((a) => turns === 0 ? a : ({
        ...a,
        rect: rotateNormBox(a.rect, turns),
        vertices: a.vertices.map((p) => rotateNormPoint(p, turns)),
        ink: a.ink.map((stroke) => stroke.map((p) => rotateNormPoint(p, turns))),
        turns,
      }))
      // Links ride the same message: a failure to read them costs the links,
      // never the annotations the Select tool is waiting for.
      let links: PageLink[] = []
      try {
        links = extractPageLinks(
          createPdfiumLinkBackend(pdfium as unknown as PdfiumLinkLike, doc!, () => readPageBox(entry.handle)),
          entry.handle, pageSizes.length,
        ).map((l) => (turns === 0 ? l : { ...l, rect: rotateNormBox(l.rect, turns) }))
      } catch { links = [] }
      post({ type: 'annots', key: job.key, page: job.page, annotations, links, ms: now() - t0 })
    } catch (err) {
      post({
        type: 'annots', key: job.key, page: job.page, annotations: [], ms: now() - t0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } else if (job.kind === 'geometry') {
    // Same failure discipline as text: report on the geometry message so only
    // the request that was waiting is rejected, rather than throwing and taking
    // the scheduler's drain loop — and every queued tile — down with it.
    try {
      // The clip arrives in displayed coordinates; extraction works unrotated.
      const turns = turnsOf(entry.handle)
      const clip = job.clip === undefined ? undefined : rotateNormBox(job.clip, 4 - turns)
      const g = extractPageGeometry(geometryBackend(), entry.handle, job.page, {
        ...(clip !== undefined ? { clip } : {}),
        ...(job.minLengthPoints !== undefined ? { minLengthPoints: job.minLengthPoints } : {}),
        ...(job.curveSteps !== undefined ? { curveSteps: job.curveSteps } : {}),
        ...(job.maxSegments !== undefined ? { maxSegments: job.maxSegments } : {}),
      })
      if (turns !== 0) rotateFlatPoints(g.segments, turns)
      post(
        {
          type: 'geometry',
          key: job.key,
          page: job.page,
          segments: g.segments,
          segmentCount: g.segmentCount,
          box: g.box,
          clip: turns === 0 ? g.clip : rotateNormBox(g.clip, turns),
          pageObjects: g.pageObjects,
          pathObjects: g.pathObjects,
          truncated: g.truncated,
          ms: now() - t0,
        },
        [g.segments.buffer],
      )
    } catch (err) {
      post({
        type: 'geometry',
        key: job.key,
        page: job.page,
        segments: new Float32Array(0),
        segmentCount: 0,
        box: { left: 0, bottom: 0, right: entry.width, top: entry.height },
        clip: { x0: 0, y0: 0, x1: 1, y1: 1 },
        pageObjects: 0,
        pathObjects: 0,
        truncated: false,
        ms: now() - t0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  } else if (job.kind === 'region') {
    // As text: reported on the region message, so only the waiting caller is
    // rejected and the drain loop keeps going.
    try {
      if (job.width * job.height > REGION_MAX_AREA || job.width > REGION_MAX_SIDE || job.height > REGION_MAX_SIDE) {
        throw new Error(`a ${job.width} x ${job.height} render is over the ${REGION_MAX_SIDE}px / ${REGION_MAX_AREA / 1e6} MP limit`)
      }
      const img = renderRegion(entry.handle, job)
      const bmp = await createImageBitmap(img)
      post({ type: 'region', key: job.key, bmp, ms: now() - t0 }, [bmp])
    } catch (err) {
      post({ type: 'region', key: job.key, ms: now() - t0, error: err instanceof Error ? err.message : String(err) })
    }
  } else {
    const w = Math.max(1, Math.round(job.width))
    const h = Math.max(1, Math.round((w * entry.height) / (entry.width || 1)))
    const img = renderInto(entry.handle, w, h, 0, 0, w, h)
    const bmp = await createImageBitmap(img)
    post({ type: 'thumb', key: job.key, page: job.page, width: w, height: h, bmp, ms: now() - t0 }, [bmp])
  }
}

// ---------------------------------------------------------------- messages --

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const m = e.data
  try {
    switch (m.type) {
      case 'boot':
        try {
          await boot(m.wasmUrl, m.pdfUrl)
        } catch (err) {
          rejectBoot(err)
          throw err
        }
        break

      case 'config':
        if (m.maxPages !== undefined) maxPages = Math.max(1, Math.floor(m.maxPages))
        if (m.quietMs !== undefined) sched.quietMs = Math.max(0, m.quietMs)
        break

      case 'page': {
        await booted
        // Opening the page is the expensive part; do it now so the first tile
        // request does not pay for it, and report the authoritative box.
        const entry = pool!.acquire(m.index)
        pageSizes[m.index] = { width: entry.width, height: entry.height }
        post({ type: 'page', index: m.index, width: entry.width, height: entry.height, rotation: turnsOf(entry.handle) * 90 })
        break
      }

      case 'rotate':
      case 'turn': {
        await booted
        // The page dictionary's /Rotate, in this worker's copy of the PDF only:
        // the file on disk is written by the app's save. Reopened so its size
        // and every later render, text and path read see the new turn.
        const entry = pool!.acquire(m.page)
        const next = m.type === 'turn' ? turnsOf(entry.handle) + m.turns : m.rotation / 90
        pdfium.FPDFPage_SetRotation(entry.handle, wrapTurns(next))
        pool!.drop(m.page)
        const fresh = pool!.acquire(m.page)
        pageSizes[m.page] = { width: fresh.width, height: fresh.height }
        post({ type: 'rotated', page: m.page, width: fresh.width, height: fresh.height, rotation: turnsOf(fresh.handle) * 90 })
        break
      }

      case 'tile':
        await booted
        sched.enqueue({
          kind: 'tile',
          key: m.key,
          page: m.page,
          priority: m.priority,
          tx: m.tx,
          ty: m.ty,
          tile: m.tile,
          zoom: m.zoom,
          ...(m.hidden !== undefined && m.hidden.length > 0 ? { hidden: m.hidden } : {}),
          ...(m.annots === false ? { annots: false as const } : {}),
        })
        break

      case 'region':
        await booted
        sched.enqueue({
          kind: 'region', key: m.key, page: m.page, priority: PRIORITY_VISIBLE,
          x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1, width: m.width, height: m.height,
          annots: m.annots,
          ...(m.hidden !== undefined && m.hidden.length > 0 ? { hidden: m.hidden } : {}),
        })
        break

      case 'thumb':
        await booted
        sched.enqueue({ kind: 'thumb', key: m.key, page: m.page, priority: m.priority, width: m.width })
        break

      case 'text':
        await booted
        sched.enqueue({ kind: 'text', key: m.key, page: m.page, priority: m.priority })
        break

      case 'annots':
        await booted
        sched.enqueue({ kind: 'annots', key: m.key, page: m.page, priority: m.priority })
        break

      case 'geometry':
        await booted
        sched.enqueue({
          kind: 'geometry',
          key: m.key,
          page: m.page,
          priority: m.priority,
          ...(m.clip !== undefined ? { clip: m.clip } : {}),
          ...(m.minLengthPoints !== undefined ? { minLengthPoints: m.minLengthPoints } : {}),
          ...(m.curveSteps !== undefined ? { curveSteps: m.curveSteps } : {}),
          ...(m.maxSegments !== undefined ? { maxSegments: m.maxSegments } : {}),
        })
        break

      case 'index':
        await booted
        // Keyed rather than keyless so the queue's own de-duplication applies:
        // two callers opening the sheet list at once collapse into one walk.
        sched.enqueue({ kind: 'index', key: INDEX_KEY, priority: PRIORITY_INDEX })
        break

      case 'cancel':
        // Also gated, so a cancel cannot overtake the enqueue it is meant to undo.
        await booted
        sched.cancel(m.keys)
        break

      case 'stats':
        await booted
        post({
          type: 'stats',
          opened: pool?.opened ?? 0,
          closed: pool?.closed ?? 0,
          open: pool?.openCount ?? 0,
          pages: pool?.pages ?? [],
          queued: sched.queue.size,
          ...(rangeStats === null ? {} : { rangeReads: rangeStats.fetches }),
        })
        break
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
