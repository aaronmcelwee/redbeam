/**
 * Whether `whole` begins with every byte of `head`.
 *
 * A save may write only the bytes after the original (see
 * `DrawingFile.write`), which is right only if the original is, byte for
 * byte, where the new file starts. Compared four bytes at a time where the
 * buffers allow it: an 80 MB set takes a few tens of milliseconds, in the
 * save worker.
 */
export function startsWith(whole: Uint8Array, head: Uint8Array): boolean {
  if (whole.length < head.length) return false
  const n = head.length
  let i = 0
  if (whole.byteOffset % 4 === 0 && head.byteOffset % 4 === 0) {
    const a = new Uint32Array(whole.buffer, whole.byteOffset, n >>> 2)
    const b = new Uint32Array(head.buffer, head.byteOffset, n >>> 2)
    for (let k = 0; k < b.length; k++) if (a[k] !== b[k]) return false
    i = b.length * 4
  }
  for (; i < n; i++) if (whole[i] !== head[i]) return false
  return true
}
