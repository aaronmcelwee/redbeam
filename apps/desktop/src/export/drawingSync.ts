/**
 * The project-folder half of the drawing embed: a `DrawingFile` backed by the
 * desktop bridge, with the file's SHA-256 as its version so a write is refused
 * when Bluebeam or OneDrive changed the drawing after REDBEAM read it.
 */
import type { ProjectBridge } from '../project/bridge.js'
import type { DrawingFile } from './drawingEmbed.js'

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

type Bridge = Pick<ProjectBridge, 'readDocument' | 'writeDocument'>

export function projectDrawingFile(bridge: Bridge, projectPath: string, relativePath: string): DrawingFile {
  return {
    read: async () => {
      const bytes = await bridge.readDocument(projectPath, relativePath)
      return { bytes, version: await sha256Hex(bytes) }
    },
    write: async (bytes, expectedVersion) => {
      const out = await bridge.writeDocument(projectPath, relativePath, bytes, expectedVersion)
      return out.outcome === 'written'
    },
  }
}

/**
 * The drawing as REDBEAM last read or wrote it, kept in memory.
 *
 * Every auto-save read the whole drawing back from disk through the IPC hop
 * and hashed it, 50-80 MB each time, a few seconds after every change, only
 * to find the bytes it had itself just written. Keeping them is safe because
 * the version still guards the write: the desktop side compares it with the
 * file on disk, so if Bluebeam or OneDrive changed the drawing meanwhile the
 * write is refused, the copy is dropped, and the save is retried from a fresh
 * read (`DrawingFile.fromMemory`).
 *
 * Only the most recent few drawings are kept: a drawing set is big.
 */
const KEPT = 2
const kept = new Map<string, { bytes: Uint8Array, version: string }>()

function keep(key: string, bytes: Uint8Array, version: string): void {
  kept.delete(key)
  kept.set(key, { bytes, version })
  while (kept.size > KEPT) kept.delete(kept.keys().next().value!)
}

/** Forget every kept drawing (tests, and a window closing its file). */
export function forgetKeptDrawings(): void { kept.clear() }

/**
 * `projectDrawingFile`, remembering the drawing between saves.
 *
 * The bytes `read` returns are handed over, not shared: the embed may move
 * them to a worker. They come back through `keep` when nothing was written,
 * or are replaced by what `write` wrote.
 */
export function keptDrawingFile(bridge: Bridge, projectPath: string, relativePath: string): DrawingFile {
  const key = `${projectPath}\u0000${relativePath}`
  let lastFromMemory = false
  return {
    read: async () => {
      const hit = kept.get(key)
      kept.delete(key)
      lastFromMemory = hit !== undefined
      if (hit !== undefined) return hit
      const bytes = await bridge.readDocument(projectPath, relativePath)
      return { bytes, version: await sha256Hex(bytes) }
    },
    write: async (bytes, expectedVersion) => {
      const out = await bridge.writeDocument(projectPath, relativePath, bytes, expectedVersion)
      if (out.outcome === 'written') keep(key, bytes, out.fingerprint)
      return out.outcome === 'written'
    },
    keep: (bytes, version) => keep(key, bytes, version),
    fromMemory: () => lastFromMemory,
  }
}
