/**
 * Big drawings, read and saved by byte range (rangedPdf.worker.ts).
 *
 * A drawing past `RANGED_FROM` bytes is never read whole for its takeoff:
 * opening reads the few objects the takeoff lives in, and a save appends the
 * update to the file without the file having been in memory. Smaller drawings
 * keep the whole-file path, which is already fast for them. This is a choice
 * of method, not a limit: every size opens and saves.
 */
import RangedWorker from './rangedPdf.worker.ts?worker'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { ProjectBridge, StreamCopyDest } from '../project/bridge.js'
import type { EmbedInput, EmbedResult, SheetEmbedReading } from './sheetEmbed.js'
import type { RangedRequest } from './rangedPdf.worker.js'
import { copyInput, type CopyOptions } from './drawingEmbed.js'
import type { RawCutouts } from './pdfCutouts.js'
import type { WritableMarkup, WriteOptions } from './pdfMarkup.js'

/** From this size up the takeoff is read and saved by range. */
export const RANGED_FROM = 128 * 1024 * 1024

type Bridge = Partial<Pick<ProjectBridge, 'streamDocument' | 'releaseStream' | 'streamFingerprint' | 'streamCopy'>>

type Reply =
  | {
    id: number, ok: true, reading?: SheetEmbedReading, result?: EmbedResult, tail?: Uint8Array | null,
    cutouts?: RawCutouts[], sizes?: Array<{ width: number, height: number } | null>, bytes?: Uint8Array,
  }
  | { id: number, ok: false, error: string }

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, (r: Reply) => void>()

function started(): Worker {
  if (worker !== null) return worker
  const w = new RangedWorker()
  w.onmessage = (e: MessageEvent<Reply>) => {
    const done = waiting.get(e.data.id)
    waiting.delete(e.data.id)
    done?.(e.data)
  }
  const fail = (ev: Event | ErrorEvent) => {
    worker = null
    const message = 'message' in ev ? String(ev.message) : 'the PDF worker stopped'
    for (const [id, done] of waiting) done({ id, ok: false, error: message })
    waiting.clear()
    w.terminate()
  }
  w.onerror = fail
  w.onmessageerror = fail
  worker = w
  return w
}

type Ask = RangedRequest extends infer R ? R extends unknown ? Omit<R, 'id'> : never : never

async function ask(req: Ask): Promise<Extract<Reply, { ok: true }>> {
  const w = started()
  const id = nextId++
  const r = await new Promise<Reply>((resolve) => {
    waiting.set(id, resolve)
    w.postMessage({ ...req, id } as RangedRequest)
  })
  if (!r.ok) throw new Error(r.error)
  return r
}

/** `now` is a test seam and cannot cross a thread. */
function plainInput(input: EmbedInput): EmbedInput {
  const { now: _now, ...plain } = input
  void _now
  return plain
}

/** Where `RangedDrawing.copyTo` writes. */
export type CopyDest = StreamCopyDest

/** A big drawing opened for range reads; null for one small enough to read whole, or a core that cannot stream. */
export interface RangedDrawing {
  size: number
  /** The `rbdoc:` address, for a worker that opens the drawing itself (estimatePackage.ts). */
  url: string
  /** SHA-256 of the file this reads (the version an update must be appended to). */
  fingerprint(): Promise<string>
  readEmbed(): Promise<SheetEmbedReading>
  /** The takeoff written as an update to append; `tail` null when the file already says this. */
  embed(input: EmbedInput): Promise<{ result: EmbedResult, tail: Uint8Array | null }>
  /** The cutouts recorded on one sheet's areas (pdfCutouts.ts). */
  cutouts(pageIndex: number): Promise<RawCutouts[]>
  /** Each sheet's size (sheetEmbed.ts `sheetSizes`). */
  sizes(): Promise<Array<{ width: number, height: number } | null>>
  /** Markups written as annotations (pdfMarkup.ts), as an update to append to a copy. */
  markedTail(markups: WritableMarkup[], options: WriteOptions): Promise<Uint8Array>
  /** A new PDF of just these sheets, with the takeoff in them when `input` is given. */
  sheets(input: EmbedInput | null, indices: number[]): Promise<Uint8Array>
  /** Copy the file with `tail` appended; the path written, null when a Save As was cancelled. */
  copyTo(dest: CopyDest, tail: Uint8Array | null): Promise<string | null>
  release(): void
}

/**
 * Run `use` on a big drawing opened by range, releasing it after; null when
 * the drawing is small enough to read whole (or the core cannot stream), so
 * the caller reads it the usual way. A failure inside `use` is thrown: a big
 * drawing is never quietly read whole instead.
 */
export async function withRanged<T>(bridge: Bridge, projectPath: string, relativePath: string, use: (d: RangedDrawing) => Promise<T>): Promise<{ value: T } | null> {
  const ranged = await openRanged(bridge, projectPath, relativePath)
  if (ranged === null) return null
  try {
    return { value: await use(ranged) }
  } finally {
    ranged.release()
  }
}

export async function openRanged(bridge: Bridge, projectPath: string, relativePath: string, opts: { always?: boolean } = {}): Promise<RangedDrawing | null> {
  if (bridge.streamDocument === undefined) return null
  const stream = await bridge.streamDocument(projectPath, relativePath)
  if (stream === null) return null
  const release = () => { void bridge.releaseStream?.(stream.token) }
  if (stream.size < RANGED_FROM && opts.always !== true) {
    release()
    return null
  }
  const url = convertFileSrc(stream.token, 'rbdoc')
  return {
    size: stream.size,
    url,
    async fingerprint() {
      if (bridge.streamFingerprint === undefined) throw new Error('this core cannot hash a stream')
      return bridge.streamFingerprint(stream.token)
    },
    async readEmbed() {
      return (await ask({ op: 'read', url, size: stream.size })).reading!
    },
    async embed(input) {
      const r = await ask({ op: 'embed', url, size: stream.size, input: plainInput(input) })
      return { result: r.result!, tail: r.tail ?? null }
    },
    async cutouts(pageIndex) {
      return (await ask({ op: 'cutouts', url, size: stream.size, pageIndex })).cutouts!
    },
    async sizes() {
      return (await ask({ op: 'sizes', url, size: stream.size })).sizes!
    },
    async markedTail(markups, options) {
      return (await ask({ op: 'marked', url, size: stream.size, markups, options })).tail!
    },
    async sheets(input, indices) {
      return (await ask({ op: 'sheets', url, size: stream.size, input: input === null ? null : plainInput(input), indices })).bytes!
    },
    async copyTo(dest, tail) {
      if (bridge.streamCopy === undefined) throw new Error('this core cannot copy a stream')
      return bridge.streamCopy(stream.token, dest, tail ?? new Uint8Array(0))
    },
    release,
  }
}

/** `embedCopy` for a big drawing: the copy is made by the core, with the takeoff appended. */
export async function copyRanged(big: RangedDrawing, opts: CopyOptions, dest: CopyDest): Promise<string | null> {
  const { tail } = await big.embed(await copyInput(opts))
  return big.copyTo(dest, tail)
}

/** What the takeoff in a big drawing says, read by range; null to read it the usual way. */
export async function readEmbedRanged(bridge: Bridge, projectPath: string, relativePath: string): Promise<SheetEmbedReading | null> {
  let ranged: RangedDrawing | null = null
  try {
    ranged = await openRanged(bridge, projectPath, relativePath)
    if (ranged === null) return null
    return await ranged.readEmbed()
  } catch (err) {
    console.warn(`[ranged] could not read ${relativePath} by range; reading it whole`, err)
    return null
  } finally {
    ranged?.release()
  }
}
