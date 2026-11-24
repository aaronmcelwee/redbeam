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
import type { ProjectBridge } from '../project/bridge.js'
import type { EmbedInput, EmbedResult, SheetEmbedReading } from './sheetEmbed.js'
import type { RangedRequest } from './rangedPdf.worker.js'

/** From this size up the takeoff is read and saved by range. */
export const RANGED_FROM = 128 * 1024 * 1024

type Bridge = Partial<Pick<ProjectBridge, 'streamDocument' | 'releaseStream' | 'streamFingerprint'>>

type Reply =
  | { id: number, ok: true, reading?: SheetEmbedReading, result?: EmbedResult, tail?: Uint8Array | null }
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

type Ask = { op: 'read', url: string, size: number } | { op: 'embed', url: string, size: number, input: EmbedInput }

function ask(req: Ask): Promise<Reply> {
  const w = started()
  const id = nextId++
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    w.postMessage({ ...req, id } as RangedRequest)
  })
}

/** A big drawing opened for range reads; null for one small enough to read whole, or a core that cannot stream. */
export interface RangedDrawing {
  size: number
  /** SHA-256 of the file this reads (the version an update must be appended to). */
  fingerprint(): Promise<string>
  readEmbed(): Promise<SheetEmbedReading>
  /** The takeoff written as an update to append; `tail` null when the file already says this. */
  embed(input: EmbedInput): Promise<{ result: EmbedResult, tail: Uint8Array | null }>
  release(): void
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
    async fingerprint() {
      if (bridge.streamFingerprint === undefined) throw new Error('this core cannot hash a stream')
      return bridge.streamFingerprint(stream.token)
    },
    async readEmbed() {
      const r = await ask({ op: 'read', url, size: stream.size })
      if (!r.ok) throw new Error(r.error)
      return r.reading!
    },
    async embed(input) {
      // `now` is a test seam and cannot cross a thread.
      const { now: _now, ...plain } = input
      void _now
      const r = await ask({ op: 'embed', url, size: stream.size, input: plain })
      if (!r.ok) throw new Error(r.error)
      return { result: r.result!, tail: r.tail ?? null }
    },
    release,
  }
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
