/**
 * Builds the estimate PDF off the window's thread (estimatePackage.ts says why).
 * The drawings arrive as transfers and the PDF goes back as one.
 */
import { buildEstimatePdf, type EstimatePdfRequest } from './estimatePackage.js'

interface Request { id: number, request: EstimatePdfRequest }

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

scope.onmessage = (e) => {
  const { id, request } = e.data
  void (async () => {
    try {
      const bytes = await buildEstimatePdf(request)
      scope.postMessage({ id, ok: true, bytes }, [bytes.buffer])
    } catch (err) {
      scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })()
}
