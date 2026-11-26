/**
 * A pdf-lib document that reads its objects from the file only when asked.
 *
 * `PDFDocument.load` parses every object in the file up front. For a drawing
 * set of a few hundred megabytes that is seconds and a lot of memory; for a
 * 2 GB, 1,800-sheet tender set it does not finish. Reading what REDBEAM keeps
 * in a PDF (its takeoff, the page boxes, the markups on each page) and writing
 * an incremental update both touch a tiny fraction of the objects: the
 * catalog, the page tree, each page's dictionary and its annotations. The
 * sheets' content streams and images, which are nearly all of the bytes, are
 * never looked at.
 *
 * So this reads the cross-reference sections (classic tables and streams,
 * following /Prev and a hybrid file's /XRefStm), and fills pdf-lib's context
 * lazily: the first lookup of an object reads just that object's bytes, using
 * the next object's offset to know where it ends, or opens its object stream.
 * The `read` it is given is synchronous, which in the app means a worker
 * fetching byte ranges from the `rbdoc:` protocol.
 *
 * Anything this cannot make sense of (no xref, a broken one, an encrypted
 * file) throws, and the caller falls back to reading the file whole.
 */
import {
  decodePDFRawStream, PDFArray, PDFContext, PDFDict, PDFDocument, PDFName, PDFNumber,
  PDFObjectParser, PDFRawStream, PDFRef, type PDFObject,
} from 'pdf-lib'

export interface ByteSource {
  readonly size: number
  /** Bytes [start, end). Synchronous. */
  read(start: number, end: number): Uint8Array
}

type Entry =
  | { kind: 'at', offset: number, gen: number }
  | { kind: 'packed', stream: number, index: number }
  | { kind: 'free' }

export interface LazyPdf {
  doc: PDFDocument
  /** Offset of the cross-reference section the last `startxref` names. */
  startxref: number
  /** Whether that section is a stream (an update must then be one too). */
  xrefIsStream: boolean
  /** How many object reads went to the source, for tests. */
  stats: { objects: number, bytes: number }
}

const td = new TextDecoder('latin1')
const ascii = (b: Uint8Array) => td.decode(b)

/** The number after the last `startxref`. */
function findStartXref(src: ByteSource): number {
  const from = Math.max(0, src.size - 4096)
  const tail = ascii(src.read(from, src.size))
  const at = tail.lastIndexOf('startxref')
  if (at < 0) throw new Error('no startxref')
  const m = /^startxref\s+(\d+)/.exec(tail.slice(at))
  if (!m) throw new Error('unreadable startxref')
  return Number(m[1])
}

export function openLazyPdf(src: ByteSource): LazyPdf {
  const context = PDFContext.create()
  const entries = new Map<number, Entry>()
  /** Every offset any section gave an object, newest first (for object streams a later update replaced). */
  const history = new Map<number, number[]>()
  const stats = { objects: 0, bytes: 0 }
  const read = (a: number, b: number) => {
    stats.bytes += b - a
    return src.read(a, b)
  }

  /** Parse one object from bytes that start at its `n g obj` header. */
  const parseAt = (bytes: Uint8Array): PDFObject => {
    const parser = PDFObjectParser.forBytes(bytes, context) as unknown as {
      parseObject(): PDFObject
      skipWhitespaceAndComments(): void
      parseRawInt(): number
      matchKeyword(k: number[]): boolean
    }
    parser.skipWhitespaceAndComments()
    parser.parseRawInt()
    parser.skipWhitespaceAndComments()
    parser.parseRawInt()
    parser.skipWhitespaceAndComments()
    // "obj"
    if (!parser.matchKeyword([0x6f, 0x62, 0x6a])) throw new Error('no obj keyword')
    parser.skipWhitespaceAndComments()
    return parser.parseObject()
  }

  // ---- the cross-reference sections, newest first; the first entry seen wins
  const startxref = findStartXref(src)
  let xrefIsStream = false
  let trailer: PDFDict | null = null
  const sectionStarts: number[] = []
  const seen = new Set<number>()
  const queue: number[] = [startxref]
  while (queue.length > 0) {
    const at = queue.shift()!
    if (seen.has(at) || at < 0 || at >= src.size) continue
    seen.add(at)
    sectionStarts.push(at)
    const head = ascii(read(at, Math.min(src.size, at + 32)))
    let dict: PDFDict
    if (head.startsWith('xref')) {
      const r = readTable(src, read, at, entries, context, history)
      dict = r.trailer
    } else {
      // An xref stream: read until the end of its object (bounded by the file).
      const obj = readObjectGrowing(src, read, at, parseAt)
      if (!(obj instanceof PDFRawStream)) throw new Error('xref is neither a table nor a stream')
      if (at === startxref) xrefIsStream = true
      dict = obj.dict
      readXrefStream(obj, entries, history)
    }
    if (trailer === null) trailer = dict
    const prev = dict.get(PDFName.of('Prev'))
    if (prev instanceof PDFNumber) queue.push(prev.asNumber())
    const stm = dict.get(PDFName.of('XRefStm'))
    if (stm instanceof PDFNumber) queue.unshift(stm.asNumber())
  }
  if (trailer === null) throw new Error('no trailer')
  if (trailer.get(PDFName.of('Encrypt')) !== undefined) throw new Error('encrypted')

  // Where each object ends: the next thing in the file after it.
  const starts = [...new Set([
    ...[...entries.values()].flatMap((e) => e.kind === 'at' ? [e.offset] : []),
    ...sectionStarts,
    src.size,
  ])].sort((a, b) => a - b)
  const endOf = (offset: number): number => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (starts[mid]! <= offset) lo = mid + 1
      else hi = mid
    }
    return starts[lo]! > offset ? starts[lo]! : src.size
  }

  const objectStreams = new Map<number, Map<number, PDFObject>>()
  const loadPacked = (streamNum: number): Map<number, PDFObject> => {
    const hit = objectStreams.get(streamNum)
    if (hit !== undefined) return hit
    const out = new Map<number, PDFObject>()
    objectStreams.set(streamNum, out)
    // The newest object with that number that is an object stream: an update
    // may have reused the number of a stream whose objects older sections
    // still point into.
    let raw: PDFRawStream | null = null
    for (const offset of history.get(streamNum) ?? []) {
      let obj: PDFObject
      try { obj = parseAt(read(offset, endOf(offset))) } catch { continue }
      if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Type')) === PDFName.of('ObjStm')) { raw = obj; break }
    }
    if (raw === null) return out
    const data = unpredict(decodePDFRawStream(raw).decode(), raw.dict)
    const n = raw.dict.lookup(PDFName.of('N'), PDFNumber).asNumber()
    const first = raw.dict.lookup(PDFName.of('First'), PDFNumber).asNumber()
    const header = ascii(data.subarray(0, first)).trim().split(/\s+/).map(Number)
    for (let i = 0; i < n; i++) {
      const num = header[2 * i]!
      const off = header[2 * i + 1]!
      const end = i + 1 < n ? header[2 * i + 3]! : data.length
      const parser = PDFObjectParser.forBytes(data.subarray(first + off, first + end), context)
      out.set(num, parser.parseObject())
    }
    return out
  }

  const load = (ref: PDFRef): PDFObject | undefined => {
    const e = entries.get(ref.objectNumber)
    if (e === undefined || e.kind === 'free') return undefined
    stats.objects++
    if (e.kind === 'at') return parseAt(read(e.offset, endOf(e.offset)))
    return loadPacked(e.stream).get(ref.objectNumber)
  }

  // pdf-lib reads objects through context.indirectObjects (a Map keyed by the
  // interned PDFRef). This one fills itself on a miss.
  const backing = new Map<PDFRef, PDFObject>()
  const missing = new Set<PDFRef>()
  const lazy = new Proxy(backing, {
    get(target, prop) {
      if (prop === 'get') {
        return (ref: PDFRef) => {
          if (target.has(ref)) return target.get(ref)
          if (missing.has(ref)) return undefined
          const obj = load(ref)
          if (obj === undefined) missing.add(ref)
          else target.set(ref, obj)
          return obj
        }
      }
      if (prop === 'has') return (ref: PDFRef) => target.has(ref) || (entries.get(ref.objectNumber)?.kind ?? 'free') !== 'free'
      if (prop === 'set') return (ref: PDFRef, v: PDFObject) => { missing.delete(ref); return target.set(ref, v) }
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  ;(context as unknown as { indirectObjects: Map<PDFRef, PDFObject> }).indirectObjects = lazy

  const size = trailer.get(PDFName.of('Size'))
  // A loop, not Math.max(...keys): a spec book can hold hundreds of thousands
  // of objects, and spreading them as arguments overflows the call stack.
  let largest = size instanceof PDFNumber ? size.asNumber() - 1 : 0
  for (const n of entries.keys()) if (n > largest) largest = n
  context.largestObjectNumber = largest
  const ref = (k: string) => { const v = trailer!.get(PDFName.of(k)); return v instanceof PDFRef ? v : undefined }
  const info: PDFContext['trailerInfo'] = {}
  const root = ref('Root')
  if (root === undefined) throw new Error('no /Root')
  info.Root = root
  const infoRef = ref('Info')
  if (infoRef !== undefined) info.Info = infoRef
  const id = trailer.get(PDFName.of('ID'))
  if (id !== undefined) info.ID = id
  context.trailerInfo = info
  const Doc = PDFDocument as unknown as new (c: PDFContext, ignoreEncryption: boolean, updateMetadata: boolean) => PDFDocument
  const doc = new Doc(context, false, false)
  return { doc, startxref, xrefIsStream, stats }
}

/** Read an object whose end we do not know yet, doubling the window. */
function readObjectGrowing(
  src: ByteSource, read: (a: number, b: number) => Uint8Array, at: number, parseAt: (b: Uint8Array) => PDFObject,
): PDFObject {
  for (let span = 64 * 1024; ; span *= 4) {
    const end = Math.min(src.size, at + span)
    const bytes = read(at, end)
    try {
      const obj = parseAt(bytes)
      if (obj instanceof PDFRawStream) {
        // A stream cut off by the window parses short; check it was complete.
        const len = obj.dict.get(PDFName.of('Length'))
        if (len instanceof PDFNumber && obj.contents.length < len.asNumber() && end < src.size) continue
        if (!(len instanceof PDFNumber) && end < src.size && !ascii(bytes).includes('endstream')) continue
      }
      return obj
    } catch (err) {
      if (end >= src.size) throw err
    }
  }
}

/** A classic `xref` table and its trailer. */
function readTable(
  src: ByteSource, read: (a: number, b: number) => Uint8Array, at: number,
  entries: Map<number, Entry>, context: PDFContext, history: Map<number, number[]>,
): { trailer: PDFDict } {
  for (let span = 64 * 1024; ; span *= 4) {
    const end = Math.min(src.size, at + span)
    const text = ascii(read(at, end))
    const t = text.indexOf('trailer')
    const close = t < 0 ? -1 : text.indexOf('>>', t)
    if ((t < 0 || close < 0 || !/startxref|xref|\d+\s+\d+\s+obj/.test(text.slice(close))) && end < src.size) continue
    if (t < 0) throw new Error('xref table without a trailer')
    const lines = text.slice(4, t)
    const re = /(\d+)\s+(\d+)\s*(?:\r\n|\r|\n|$)|(\d{10})\s(\d{5})\s([nf])/g
    let objNum = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(lines)) !== null) {
      if (m[1] !== undefined) {
        objNum = Number(m[1])
      } else {
        if (m[5] === 'n') pushHistory(history, objNum, Number(m[3]))
        if (!entries.has(objNum)) {
          entries.set(objNum, m[5] === 'n' ? { kind: 'at', offset: Number(m[3]), gen: Number(m[4]) } : { kind: 'free' })
        }
        objNum++
      }
    }
    // Latin-1 round trip: re-encode the slice byte for byte.
    const tail = text.slice(t + 'trailer'.length)
    const bytes = new Uint8Array(tail.length)
    for (let i = 0; i < tail.length; i++) bytes[i] = tail.charCodeAt(i) & 0xff
    const p2 = PDFObjectParser.forBytes(bytes, context) as unknown as { skipWhitespaceAndComments(): void, parseObject(): PDFObject }
    p2.skipWhitespaceAndComments()
    const dict = p2.parseObject()
    if (!(dict instanceof PDFDict)) throw new Error('trailer is not a dictionary')
    return { trailer: dict }
  }
}

/** Entries of an xref stream. Offsets past 2 GB are read without 32-bit overflow. */
function readXrefStream(stream: PDFRawStream, entries: Map<number, Entry>, history: Map<number, number[]>): void {
  const dict = stream.dict
  const W = dict.lookup(PDFName.of('W'), PDFArray)
  const w = [0, 1, 2].map((i) => W.lookup(i, PDFNumber).asNumber())
  const size = dict.lookup(PDFName.of('Size'), PDFNumber).asNumber()
  const index = dict.lookupMaybe(PDFName.of('Index'), PDFArray)
  const subsections: Array<[number, number]> = []
  if (index !== undefined) {
    for (let i = 0; i + 1 < index.size(); i += 2) subsections.push([index.lookup(i, PDFNumber).asNumber(), index.lookup(i + 1, PDFNumber).asNumber()])
  } else {
    subsections.push([0, size])
  }
  const data = unpredict(decodePDFRawStream(stream).decode(), dict)
  let p = 0
  const field = (width: number, dflt: number) => {
    if (width === 0) return dflt
    let v = 0
    for (let i = 0; i < width; i++) v = v * 256 + (data[p++] ?? 0)
    return v
  }
  for (const [first, count] of subsections) {
    for (let k = 0; k < count; k++) {
      const type = field(w[0]!, 1)
      const a = field(w[1]!, 0)
      const b = field(w[2]!, 0)
      const num = first + k
      if (type === 1) pushHistory(history, num, a)
      if (entries.has(num)) continue
      if (type === 0) entries.set(num, { kind: 'free' })
      else if (type === 1) entries.set(num, { kind: 'at', offset: a, gen: b })
      else if (type === 2) entries.set(num, { kind: 'packed', stream: a, index: b })
    }
  }
}

function pushHistory(history: Map<number, number[]>, num: number, offset: number): void {
  const list = history.get(num)
  if (list === undefined) history.set(num, [offset])
  else list.push(offset)
}

/**
 * Undo a PNG predictor (/DecodeParms /Predictor 10-15), which pdf-lib's
 * decoder leaves in place. Acrobat and Bluebeam write xref streams with
 * Predictor 12.
 */
export function unpredict(data: Uint8Array, dict: PDFDict): Uint8Array {
  const parms = dict.lookup(PDFName.of('DecodeParms'))
  if (!(parms instanceof PDFDict)) return data
  const predictor = parms.lookup(PDFName.of('Predictor'))
  const p = predictor instanceof PDFNumber ? predictor.asNumber() : 1
  if (p < 10) return data
  const num = (k: string, d: number) => { const v = parms.lookup(PDFName.of(k)); return v instanceof PDFNumber ? v.asNumber() : d }
  const colors = num('Colors', 1)
  const bpc = num('BitsPerComponent', 8)
  const columns = num('Columns', 1)
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowLen = Math.ceil((colors * bpc * columns) / 8)
  const rows = Math.floor(data.length / (rowLen + 1))
  const out = new Uint8Array(rows * rowLen)
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)]!
    const src = r * (rowLen + 1) + 1
    const dst = r * rowLen
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + i]!
      const a = i >= bpp ? out[dst + i - bpp]! : 0
      const b = r > 0 ? out[dst - rowLen + i]! : 0
      const c = r > 0 && i >= bpp ? out[dst - rowLen + i - bpp]! : 0
      let v: number
      switch (type) {
        case 1: v = x + a; break
        case 2: v = x + b; break
        case 3: v = x + ((a + b) >> 1); break
        case 4: {
          const pa = Math.abs(b - c)
          const pb = Math.abs(a - c)
          const pc = Math.abs(a + b - 2 * c)
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: v = x
      }
      out[dst + i] = v & 0xff
    }
  }
  return out
}
