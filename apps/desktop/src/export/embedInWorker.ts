/**
 * The app's `SheetEmbedder`: builds the PDF in `embedWorker.ts`, so an
 * auto-save never stalls the sheet. One worker, started on the first save and
 * kept; saves are already queued one per drawing, and two drawings saving at
 * once simply wait their turn inside it.
 *
 * If a worker cannot be started (or dies), the PDF is built on this thread as
 * before: slower, never lost.
 */
import EmbedWorker from './embedWorker.ts?worker'
import { embedSheet, type EmbedResult } from './sheetEmbed.js'
import type { SheetEmbedder } from './drawingEmbed.js'

type Reply =
  | { id: number, ok: true, result: EmbedResult, source: Uint8Array, appendsAt?: number }
  | { id: number, ok: false, error: string, source: Uint8Array }

let worker: Worker | null = null
let broken = false
let nextId = 1
const waiting = new Map<number, (reply: Reply | null) => void>()

function started(): Worker | null {
  if (worker !== null || broken) return worker
  try {
    const w = new EmbedWorker()
    w.onmessage = (e: MessageEvent<Reply>) => {
      const done = waiting.get(e.data.id)
      waiting.delete(e.data.id)
      done?.(e.data)
    }
    w.onerror = () => {
      // Whatever was in flight is answered on this thread instead.
      broken = true
      worker = null
      for (const done of waiting.values()) done(null)
      waiting.clear()
      w.terminate()
    }
    worker = w
  } catch {
    broken = true
  }
  return worker
}

export const embedInWorker: SheetEmbedder = async (source, input) => {
  const w = started()
  if (w === null) return { result: await embedSheet(source, input), source }
  // The bytes move to the worker. If it dies holding them this save fails,
  // and the next one reads the drawing from disk again.
  const id = nextId++
  const reply = await new Promise<Reply | null>((resolve) => {
    waiting.set(id, resolve)
    // `now` is a test seam and cannot cross a thread.
    const { now: _now, ...plain } = input
    void _now
    w.postMessage({ id, source, input: plain }, [source.buffer])
  })
  if (reply === null) throw new Error('the save worker stopped; the next save will build the PDF here')
  if (!reply.ok) throw new Error(reply.error)
  return { result: reply.result, source: reply.source, ...(reply.appendsAt === undefined ? {} : { appendsAt: reply.appendsAt }) }
}
