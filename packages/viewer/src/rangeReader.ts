/**
 * Reads a PDF a block at a time, for PDFium's custom-document loader.
 *
 * PDFium asks for bytes synchronously (FPDF_FILEACCESS.m_GetBlock) and only
 * for what it needs: the trailer and cross-reference table on open, then the
 * objects of each page it draws. So a 500 MB, 1,000-sheet set no longer has
 * to be read whole before the first sheet shows. Reads are rounded out to
 * whole blocks and the most recent blocks are kept, because PDFium reads in
 * small pieces and comes back to the same neighbourhood (an object stream,
 * the xref) over and over.
 */
export type FetchRange = (start: number, endExclusive: number) => Uint8Array

export class RangeReader {
  private readonly blocks = new Map<number, Uint8Array>()
  /** Block reads that went to the source, for tests and the perf readout. */
  fetches = 0

  constructor(
    readonly size: number,
    private readonly fetchRange: FetchRange,
    private readonly blockSize = 1 << 17,
    private readonly keepBlocks = 512,
  ) {}

  /** `length` bytes from `position` into `out`. False when past the end. */
  read(position: number, length: number, out: Uint8Array): boolean {
    if (position < 0 || length < 0 || position + length > this.size) return false
    let done = 0
    while (done < length) {
      const at = position + done
      const index = Math.floor(at / this.blockSize)
      const block = this.block(index)
      const offset = at - index * this.blockSize
      const take = Math.min(length - done, block.length - offset)
      if (take <= 0) return false
      out.set(block.subarray(offset, offset + take), done)
      done += take
    }
    return true
  }

  private block(index: number): Uint8Array {
    const hit = this.blocks.get(index)
    if (hit !== undefined) {
      // Most recently used goes to the back.
      this.blocks.delete(index)
      this.blocks.set(index, hit)
      return hit
    }
    const start = index * this.blockSize
    const end = Math.min(this.size, start + this.blockSize)
    const bytes = this.fetchRange(start, end)
    this.fetches++
    if (bytes.length !== end - start) throw new Error(`asked for ${end - start} bytes at ${start}, got ${bytes.length}`)
    this.blocks.set(index, bytes)
    while (this.blocks.size > this.keepBlocks) this.blocks.delete(this.blocks.keys().next().value!)
    return bytes
  }
}

/**
 * A synchronous ranged GET, which only a worker may make. Returns null when
 * the server ignored the range (sent 200 with the whole file).
 */
export function xhrRange(url: string, start: number, endExclusive: number): { bytes: Uint8Array, total: number | null } | null {
  const xhr = new XMLHttpRequest()
  xhr.open('GET', url, false)
  xhr.responseType = 'arraybuffer'
  xhr.setRequestHeader('Range', `bytes=${start}-${endExclusive - 1}`)
  xhr.send()
  if (xhr.status !== 206) return null
  const range = xhr.getResponseHeader('Content-Range') ?? ''
  const total = /\/(\d+)\s*$/.exec(range)
  return { bytes: new Uint8Array(xhr.response as ArrayBuffer), total: total ? Number(total[1]) : null }
}
