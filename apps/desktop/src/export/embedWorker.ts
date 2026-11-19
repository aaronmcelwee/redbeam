/**
 * Builds a drawing's PDF with its takeoff in it, off the window's thread.
 *
 * Parsing a 50-80 MB drawing set with pdf-lib, re-reading every annotation and
 * hashing the takeoff costs a few hundred milliseconds on a laptop, and the
 * auto-save does it a few seconds after every change. On the window's thread
 * that is a frozen sheet in the middle of a takeoff; here it is invisible.
 * The bytes travel both ways as transfers, so nothing 80 MB is copied.
 */
import { embedSheet, type EmbedInput } from './sheetEmbed.js'
import { startsWith } from './appendCheck.js'

interface Request { id: number, source: Uint8Array, input: EmbedInput }

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null
  postMessage: (message: unknown, transfer: Transferable[]) => void
}

scope.onmessage = (e) => {
  const { id, source, input } = e.data
  void (async () => {
    try {
      const result = await embedSheet(source, input)
      // Checked here, off the window's thread: only then may the save write
      // just the tail.
      const appendsAt = result.bytes !== null && startsWith(result.bytes, source) ? source.length : undefined
      const transfer: Transferable[] = [source.buffer]
      if (result.bytes !== null && result.bytes.buffer !== source.buffer) transfer.push(result.bytes.buffer)
      scope.postMessage({ id, ok: true, result, source, appendsAt }, transfer)
    } catch (err) {
      scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err), source }, [source.buffer])
    }
  })()
}
