/**
 * Printing sheets: this one, all of them, or a range.
 *
 * What prints is the PDF itself with the takeoff in it, the same bytes "Save
 * a copy" writes, cut down to the sheets asked for. Printing the PDF rather
 * than what is on screen keeps the linework vector at any paper size, prints
 * a rotated sheet the way it is turned, and prints the takeoff because every
 * markup REDBEAM writes carries the Print flag.
 *
 * The PDF goes to the webview's own PDF viewer in a hidden frame, whose print
 * dialog is the system one: printer, paper size, fit to page.
 */

import { PDFDocument } from 'pdf-lib'

/**
 * Sheets from what a person types: "3", "1-5", "1-5, 8, 12-". 1-based, as the
 * sheet list numbers them; returns 0-based indices in order without repeats,
 * or a reason it could not be read.
 */
export function parsePageRange(text: string, pageCount: number): number[] | string {
  const t = text.trim().toLowerCase().replace(/\s*(?:-|–|\bto\b)\s*/g, '-')
  if (t === '') return 'type sheet numbers, like 1-5, 8'
  if (t === 'all') return Array.from({ length: pageCount }, (_, i) => i)
  const out: number[] = []
  const seen = new Set<number>()
  for (const part of t.split(/[,;\s]+/).filter((p) => p !== '')) {
    const m = /^(\d+)?(-)?(\d+)?$/.exec(part)
    const dash = m?.[2] !== undefined
    if (m === null || (m[1] === undefined && m[3] === undefined)) return `“${part}” is not a sheet number`
    const a = m[1] === undefined ? 1 : Number(m[1])
    const b = !dash ? a : m[3] === undefined ? pageCount : Number(m[3])
    if (a < 1 || b < 1) return 'sheets are numbered from 1'
    if (a > pageCount || b > pageCount) return `there are ${pageCount} sheets`
    const [lo, hi] = a <= b ? [a, b] : [b, a]
    for (let n = lo; n <= hi; n++) {
      if (seen.has(n)) continue
      seen.add(n)
      out.push(n - 1)
    }
  }
  return out.length === 0 ? 'type sheet numbers, like 1-5, 8' : out
}

/** The PDF cut down to these sheets, in this order. The whole file when it is all of them. */
export async function sheetsPdf(bytes: Uint8Array, indices: readonly number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false })
  const count = src.getPageCount()
  if (indices.length === count && indices.every((p, i) => p === i)) return bytes
  const out = await PDFDocument.create({ updateMetadata: false })
  const pages = await out.copyPages(src, indices.filter((i) => i >= 0 && i < count))
  for (const p of pages) out.addPage(p)
  const title = src.getTitle()
  if (title !== undefined) out.setTitle(title)
  return out.save()
}

/** How long the frame is kept after the dialog opens; removing it early cancels the job. */
const FRAME_LIFETIME_MS = 10 * 60 * 1000

/**
 * Open the system print dialog for a PDF. Resolves once the dialog was asked
 * for, rejects when the webview could not show the PDF to print it.
 */
export function printPdf(bytes: Uint8Array, doc: Document = document): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
    const frame = doc.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.title = 'print'
    // Off screen rather than display:none, which some engines refuse to print.
    Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', border: '0', opacity: '0' })
    const cleanup = () => { frame.remove(); URL.revokeObjectURL(url) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('the PDF did not load to print')) }, 60_000)
    frame.onload = () => {
      clearTimeout(timer)
      // The PDF viewer inside the frame needs a moment after load before
      // print() reaches it rather than the empty frame.
      setTimeout(() => {
        try {
          frame.contentWindow?.focus()
          frame.contentWindow?.print()
          setTimeout(cleanup, FRAME_LIFETIME_MS)
          resolve()
        } catch (err) {
          cleanup()
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }, 400)
    }
    frame.src = url
    doc.body.appendChild(frame)
  })
}

/** "sheet A1.203", "3 sheets", "all 60 sheets". */
export function printedWhat(indices: readonly number[], pageCount: number, label: (i: number) => string): string {
  if (indices.length === 1) return `sheet ${label(indices[0]!)}`
  if (indices.length === pageCount) return `all ${pageCount} sheets`
  return `${indices.length} sheets`
}
