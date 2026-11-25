/**
 * Reads and writes a drawing too big to hold in memory.
 *
 * The drawing is reached through `rbdoc:` (docstream.rs), one byte range at a
 * time, with synchronous requests, which only a worker may make. lazyPdf.ts
 * then opens just the objects an operation touches: the catalog, the page
 * tree, each page and its markups. On a 2.5 GB, 1,800-sheet set that is a few
 * megabytes. A write produces only the incremental update to append; the core
 * appends it to the file, or to a copy of it (project_stream_copy).
 */
import { openRangedPdf } from './rangedSource.js'
import { embedSheetTail, readSheetEmbedFrom, sheetSizesOf, type EmbedInput } from './sheetEmbed.js'
import { readPageCutouts } from './pdfCutouts.js'
import { writeMarkupsInto, type WritableMarkup, type WriteOptions } from './pdfMarkup.js'
import { incrementalTail, newRefsSince } from './pdfIncremental.js'
import { sheetsPdfFrom } from '../print.js'

export type RangedRequest = { id: number, url: string, size: number } & (
  | { op: 'read' }
  | { op: 'embed', input: EmbedInput }
  | { op: 'cutouts', pageIndex: number }
  | { op: 'sizes' }
  | { op: 'marked', markups: WritableMarkup[], options: WriteOptions }
  | { op: 'sheets', input: EmbedInput | null, indices: number[] }
)

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<RangedRequest>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

async function answer(req: RangedRequest): Promise<{ reply: Record<string, unknown>, transfer: Transferable[] }> {
  const lazy = openRangedPdf(req.url, req.size)
  switch (req.op) {
    case 'read':
      return { reply: { reading: readSheetEmbedFrom(lazy.doc) }, transfer: [] }
    case 'embed': {
      const { result, tail } = embedSheetTail(lazy.doc, lazy.base(), req.input)
      return { reply: { result, tail }, transfer: tail === null ? [] : [tail.buffer] }
    }
    case 'cutouts':
      return { reply: { cutouts: readPageCutouts(lazy.doc, req.pageIndex) }, transfer: [] }
    case 'sizes':
      return { reply: { sizes: sheetSizesOf(lazy.doc) }, transfer: [] }
    case 'marked': {
      const before = lazy.doc.context.largestObjectNumber
      const changed = writeMarkupsInto(lazy.doc, req.markups, req.options)
      const tail = incrementalTail(lazy.base(), lazy.doc, [...changed, ...newRefsSince(lazy.doc, before)])
      return { reply: { tail }, transfer: [tail.buffer] }
    }
    case 'sheets': {
      // The takeoff goes into the open document first, so the sheets carry it.
      if (req.input !== null) embedSheetTail(lazy.doc, lazy.base(), req.input)
      const bytes = await sheetsPdfFrom(lazy.doc, req.indices)
      return { reply: { bytes }, transfer: [bytes.buffer] }
    }
  }
}

scope.onmessage = (e) => {
  const req = e.data
  answer(req).then(
    ({ reply, transfer }) => scope.postMessage({ id: req.id, ok: true, ...reply }, transfer),
    (err: unknown) => scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  )
}
