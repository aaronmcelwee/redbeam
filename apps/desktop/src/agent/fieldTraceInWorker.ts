/**
 * Trace a hatched field in a worker, so the window keeps drawing (and the
 * person keeps working) while an agent reads a whole sheet. A worker is
 * started for the call and stopped after it. If one cannot be started, or
 * dies, the trace runs on this thread instead: slower, never lost.
 */
import FieldTraceWorker from './fieldTraceWorker.ts?worker'
import { traceField, type FieldTraceInput, type FieldTraceResult } from '@redbeam/domain'

type Reply = { id: number, ok: true, result: FieldTraceResult } | { id: number, ok: false, error: string }

export async function traceFieldInWorker(input: FieldTraceInput): Promise<FieldTraceResult> {
  let worker: Worker
  try {
    worker = new FieldTraceWorker()
  } catch {
    return traceField(input)
  }
  try {
    const reply = await new Promise<Reply | null>((resolve) => {
      worker.onmessage = (e: MessageEvent<Reply>) => resolve(e.data)
      worker.onerror = () => resolve(null)
      // `now` is a function and cannot cross; the worker has its own clock.
      const { now: _now, ...plain } = input
      worker.postMessage({ id: 1, input: plain })
    })
    if (reply === null) return traceField(input)
    if (!reply.ok) throw new Error(reply.error)
    return reply.result
  } finally {
    worker.terminate()
  }
}
