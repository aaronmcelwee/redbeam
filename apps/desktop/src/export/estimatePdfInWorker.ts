/**
 * The estimate PDF, built in `estimatePdfWorker.ts` so the window keeps
 * drawing while a big set is read and written. A worker is started for the
 * export and stopped after it: exports are rare and the worker holds the
 * drawings while it works.
 *
 * If a worker cannot be started, or dies, the PDF is built on this thread
 * instead: slower, never lost. The drawings' bytes are transferred, so a
 * failed worker leaves them unusable; they are read again for the retry.
 */
import EstimateWorker from './estimatePdfWorker.ts?worker'
import { buildEstimatePdf, type EstimatePdfRequest } from './estimatePackage.js'

type Reply = { id: number, ok: true, bytes: Uint8Array } | { id: number, ok: false, error: string }

/**
 * Build the PDF. `request` is made by `make`, twice if the worker fails, since
 * the first copy's drawings went to the worker.
 */
export async function estimatePdfInWorker(make: () => Promise<EstimatePdfRequest>): Promise<Uint8Array> {
  let worker: Worker
  try {
    worker = new EstimateWorker()
  } catch {
    return buildEstimatePdf(await make())
  }
  const request = await make()
  try {
    const reply = await new Promise<Reply | null>((resolve) => {
      worker.onmessage = (e: MessageEvent<Reply>) => resolve(e.data)
      worker.onerror = () => resolve(null)
      const transfer = request.drawings.flatMap((d) => (d.bytes === null ? [] : [d.bytes.buffer as ArrayBuffer]))
      worker.postMessage({ id: 1, request }, [...new Set(transfer)])
    })
    if (reply === null) return buildEstimatePdf(await make())
    if (!reply.ok) throw new Error(reply.error)
    return reply.bytes
  } finally {
    worker.terminate()
  }
}
