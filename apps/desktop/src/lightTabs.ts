/**
 * Light mode's tabs: several PDFs open in one window, as Bluebeam does.
 *
 * Aaron, 2026-11-23: "they cannot open multiple PDF files. When they open a
 * new file, it replaces the currently open one."
 *
 * One tab is live at a time: the window shows one drawing, and only that one
 * holds a viewer, a store and a takeoff in memory. Leaving a tab saves its
 * takeoff into its PDF first (the same save as closing the window), so the
 * tabs that are not showing hold nothing that is not already in their files.
 * Going back to one opens it again from its PDF.
 *
 * Pure list arithmetic here; App.tsx owns the state and the saving.
 */

export interface LightFile {
  /** The folder the PDF is in. */
  folder: string
  /** The PDF's full path. */
  file: string
  /** Its name in that folder. */
  relativePath: string
}

/** A full path to the file quick view opens. */
export function lightFileOf(path: string): LightFile {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return { folder: path.slice(0, cut), file: path, relativePath: path.slice(cut + 1) }
}

/** Windows paths: case and slash direction do not make a different file. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
  return norm(a) === norm(b)
}

/** The tabs with `f` added at the end, or as they were when it is already open. */
export function withTab(tabs: readonly LightFile[], f: LightFile): LightFile[] {
  return tabs.some((t) => samePath(t.file, f.file)) ? [...tabs] : [...tabs, f]
}

/**
 * The tabs without `file`, and the tab to show next when it was the one
 * showing: the one to its right, else to its left, else none.
 */
export function withoutTab(
  tabs: readonly LightFile[], file: string, showing: string | null,
): { tabs: LightFile[]; next: LightFile | null } {
  const i = tabs.findIndex((t) => samePath(t.file, file))
  if (i < 0) return { tabs: [...tabs], next: null }
  const rest = tabs.filter((_, j) => j !== i)
  if (showing === null || !samePath(showing, file)) return { tabs: rest, next: null }
  return { tabs: rest, next: rest[i] ?? rest[i - 1] ?? null }
}

/** The tab `step` places along from `file`, wrapping: Ctrl+Tab and Ctrl+Shift+Tab. */
export function stepTab(tabs: readonly LightFile[], file: string, step: 1 | -1): LightFile | null {
  if (tabs.length < 2) return null
  const i = tabs.findIndex((t) => samePath(t.file, file))
  if (i < 0) return null
  return tabs[(i + step + tabs.length) % tabs.length] ?? null
}

// ------------------------------------------------------------ session --

const SESSION_KEY = 'redbeam.light-tabs'
/*
 * Every tab comes back at start, however many (Aaron, 2026-11-24: no
 * arbitrary caps). A restored tab is a name until it is shown: only the
 * active one opens its PDF.
 */

export interface LightSession { files: string[]; active: string | null }

/** What was open when the window last changed tabs. Empty when nothing was, or storage is off. */
export function readSession(storage: Pick<Storage, 'getItem'> | null = safeStorage()): LightSession {
  try {
    const raw = storage?.getItem(SESSION_KEY)
    if (raw === null || raw === undefined) return { files: [], active: null }
    const v = JSON.parse(raw) as unknown
    if (v === null || typeof v !== 'object') return { files: [], active: null }
    const o = v as Record<string, unknown>
    const files = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === 'string' && f !== '') : []
    const active = typeof o.active === 'string' && files.some((f) => samePath(f, o.active as string)) ? o.active : (files[0] ?? null)
    return { files, active }
  } catch {
    return { files: [], active: null }
  }
}

export function writeSession(s: LightSession, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(SESSION_KEY, JSON.stringify({ files: s.files, active: s.active })) } catch { /* a convenience only */ }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}
