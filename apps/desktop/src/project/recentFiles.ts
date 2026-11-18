/**
 * Light mode's recents: PDFs, not project folders.
 *
 * A Light file has no project, so it has no row in the desktop core's recent
 * projects. The list lives in this machine's local storage instead, newest
 * first, in the same shape as a recent project so the start screen draws both
 * with one list.
 */
import type { RecentProject } from './types.js'

const KEY = 'redbeam.recent-files'
const LIMIT = 60

interface Stored { path: string; at: string }

export interface RecentFileStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storage(): RecentFileStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

function read(store: RecentFileStorage | null): Stored[] {
  try {
    const raw = store?.getItem(KEY) ?? null
    const list: unknown = raw === null ? [] : JSON.parse(raw)
    if (!Array.isArray(list)) return []
    return list.filter((x): x is Stored =>
      typeof x === 'object' && x !== null && typeof (x as Stored).path === 'string' && typeof (x as Stored).at === 'string')
  } catch { return [] }
}

function write(store: RecentFileStorage | null, list: Stored[]): void {
  try { store?.setItem(KEY, JSON.stringify(list.slice(0, LIMIT))) } catch { /* a private window keeps no recents */ }
}

const same = (a: string, b: string) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()

export function fileName(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return path.slice(cut + 1)
}

/** The recent PDFs, newest first, as start-screen rows. */
export function recentFiles(store: RecentFileStorage | null = storage()): RecentProject[] {
  return read(store).map((f) => ({
    path: f.path,
    name: fileName(f.path).replace(/\.pdf$/i, ''),
    displayName: null,
    lastOpenedAt: f.at,
    missing: false,
  }))
}

/** A PDF was just opened: it goes to the top. */
export function rememberFile(path: string, store: RecentFileStorage | null = storage(), now = new Date()): void {
  write(store, [{ path, at: now.toISOString() }, ...read(store).filter((f) => !same(f.path, path))])
}

/** Take a PDF off the list. The file is not touched. */
export function forgetFile(path: string, store: RecentFileStorage | null = storage()): void {
  write(store, read(store).filter((f) => !same(f.path, path)))
}
