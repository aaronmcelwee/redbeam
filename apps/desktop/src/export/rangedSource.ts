/**
 * A drawing reached through `rbdoc:` (docstream.rs) as a `ByteSource` for
 * lazyPdf.ts: each read fetches the byte range it needs, with synchronous
 * requests, so it belongs in a worker.
 */
import { RangeReader, xhrRange } from '@redbeam/viewer/rangeReader'
import { openLazyPdf, type ByteSource, type LazyPdf } from './lazyPdf.js'
import type { UpdateBase } from './pdfIncremental.js'

export function rangedSource(url: string, size: number): ByteSource {
  // Smaller blocks than the viewer's: these reads are scattered page and
  // annotation dictionaries more than content streams.
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

/** Open a drawing by range; `base` is what an update appended to it starts from. */
export function openRangedPdf(url: string, size: number): LazyPdf & { base(): UpdateBase } {
  const src = rangedSource(url, size)
  const lazy = openLazyPdf(src)
  return {
    ...lazy,
    base() {
      const last = src.read(size - 1, size)[0]
      return { length: size, prev: lazy.startxref, useTable: !lazy.xrefIsStream, endsWithNewline: last === 0x0a || last === 0x0d }
    },
  }
}
