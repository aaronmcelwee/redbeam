/**
 * Reads and writes REDBEAM's takeoff in a drawing too big to hold in memory.
 *
 * The drawing is reached through `rbdoc:` (docstream.rs), one byte range at a
 * time, with synchronous requests, which only a worker may make. lazyPdf.ts
 * then opens just the objects the takeoff touches: the catalog, the page
 * tree, each page and its markups. On a 2.5 GB, 1,800-sheet set that is a few
 * megabytes. A save produces only the incremental update to append.
 */
import { RangeReader, xhrRange } from '@redbeam/viewer/rangeReader'
import { openLazyPdf, type ByteSource } from './lazyPdf.js'
import { embedSheetTail, readSheetEmbedFrom, type EmbedInput } from './sheetEmbed.js'
import type { UpdateBase } from './pdfIncremental.js'

export type RangedRequest =
  | { id: number, op: 'read', url: string, size: number }
  | { id: number, op: 'embed', url: string, size: number, input: EmbedInput }

function sourceFor(url: string, size: number): ByteSource {
  // Smaller blocks than the viewer's: these reads are scattered page and
  // annotation dictionaries, not content streams.
  const reader = new RangeReader(size, (a, b) => {
    const got = xhrRange(url, a, b)
    if (got === null) throw new Error('the drawing stopped answering range reads')
    return got.bytes
  }, 1 << 16, 256)
  return {
    size,
    read(a, b) {
      const out = new Uint8Array(b - a)
      if (!reader.read(a, b - a, out)) throw new Error(`could not read bytes ${a}-${b}`)
      return out
    },
  }
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<RangedRequest>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

scope.onmessage = (e) => {
  const req = e.data
  try {
    const src = sourceFor(req.url, req.size)
    const lazy = openLazyPdf(src)
    if (req.op === 'read') {
      scope.postMessage({ id: req.id, ok: true, reading: readSheetEmbedFrom(lazy.doc) })
      return
    }
    const last = src.read(req.size - 1, req.size)[0]
    const base: UpdateBase = {
      length: req.size,
      prev: lazy.startxref,
      useTable: !lazy.xrefIsStream,
      endsWithNewline: last === 0x0a || last === 0x0d,
    }
    const { result, tail } = embedSheetTail(lazy.doc, base, req.input)
    scope.postMessage({ id: req.id, ok: true, result, tail }, tail === null ? [] : [tail.buffer])
  } catch (err) {
    scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
