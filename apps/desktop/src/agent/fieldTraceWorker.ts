/**
 * Traces a hatched field off the window's thread: a whole A0 sheet is a grid
 * of millions of cells and a second or two of work (fieldTrace.ts says what).
 */
import { traceField, type FieldTraceInput } from '@redbeam/domain'

interface Request { id: number, input: FieldTraceInput }

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null
  postMessage: (message: unknown) => void
}

scope.onmessage = (e) => {
  const { id, input } = e.data
  try {
    scope.postMessage({ id, ok: true, result: traceField(input) })
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
