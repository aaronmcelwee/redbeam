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
  /**
   * The AI agent that opened it (agents/roster.ts), when one did. Its tab
   * sits in that agent's group, stays live while the person works in their
   * own tabs, and the agent may turn its pages. A tab without one is the
   * person's: nothing an agent does moves its view.
   */
  owner?: string
  /**
   * Set on a tab a finished AI session handed to the person: who it came
   * from and their colour, shown as a dot until the person opens it.
   */
  handed?: { by: string; color: string }
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

// ------------------------------------------------------------- agents --

/** The tab for `file`, if it is open. */
export function tabFor<T extends LightFile>(tabs: readonly T[], file: string): T | undefined {
  return tabs.find((t) => samePath(t.file, file))
}

/**
 * The open tab a bridge call means by `want`: a full path, or just the file's
 * name when exactly one open tab has it. Two open PDFs with the same name in
 * different folders are not guessed between.
 */
export function tabNamed<T extends LightFile>(tabs: readonly T[], want: string): T | undefined {
  const w = want.trim()
  if (w === '') return undefined
  const exact = tabFor(tabs, w)
  if (exact !== undefined) return exact
  const base = (p: string) => p.replace(/\\/g, '/').replace(/^.*\//, '').toLowerCase()
  const named = tabs.filter((t) => base(t.file) === base(w))
  return named.length === 1 ? named[0] : undefined
}

/** The tabs with `file` handed to `owner` (an agent's id), or back to the person (null). */
export function withOwner(tabs: readonly LightFile[], file: string, owner: string | null): LightFile[] {
  return tabs.map((t) => {
    if (!samePath(t.file, file)) return t
    const { owner: _was, ...rest } = t
    return owner === null ? rest : { ...rest, owner }
  })
}

/** The tabs with `file` marked as handed back by a session, or the mark taken off (null). */
export function withHanded(tabs: readonly LightFile[], file: string, handed: { by: string; color: string } | null): LightFile[] {
  return tabs.map((t) => {
    if (!samePath(t.file, file)) return t
    const { handed: _was, ...rest } = t
    return handed === null ? rest : { ...rest, handed }
  })
}

/** The person's own tabs, in order: the ones no agent opened. */
export function ownTabs<T extends LightFile>(tabs: readonly T[]): T[] {
  return tabs.filter((t) => t.owner === undefined)
}

/** One agent's tabs, in the order it opened them. */
export function agentTabs<T extends LightFile>(tabs: readonly T[], agent: string): T[] {
  return tabs.filter((t) => t.owner === agent)
}

/**
 * The tab to show when the one showing closes. The person's own neighbour:
 * closing a PDF never drops them into an agent's tab they did not ask to
 * watch. Null (the start page) when they have no other tab of their own.
 */
export function nextOwnTab(tabs: readonly LightFile[], file: string): LightFile | null {
  const i = tabs.findIndex((t) => samePath(t.file, file))
  if (i < 0) return null
  for (let j = i + 1; j < tabs.length; j++) if (tabs[j]!.owner === undefined) return tabs[j]!
  for (let j = i - 1; j >= 0; j--) if (tabs[j]!.owner === undefined) return tabs[j]!
  return null
}

/**
 * Ctrl+Tab from `file`: the person's own tabs only, wrapping. From an
 * agent's tab being watched, it goes to their first (or last) own tab.
 */
export function stepOwnTab(tabs: readonly LightFile[], file: string, step: 1 | -1): LightFile | null {
  const own = ownTabs(tabs)
  if (own.length === 0) return null
  const i = own.findIndex((t) => samePath(t.file, file))
  if (i < 0) return step === 1 ? own[0]! : own[own.length - 1]!
  if (own.length < 2) return null
  return own[(i + step + own.length) % own.length] ?? null
}

// ------------------------------------------------------------ session --

const SESSION_KEY = 'redbeam.light-tabs'
/** Most tabs brought back at start. A session of fifty files is a mistake to repeat. */
export const SESSION_LIMIT = 20

export interface LightSession { files: string[]; active: string | null }

/** What was open when the window last changed tabs. Empty when nothing was, or storage is off. */
export function readSession(storage: Pick<Storage, 'getItem'> | null = safeStorage()): LightSession {
  try {
    const raw = storage?.getItem(SESSION_KEY)
    if (raw === null || raw === undefined) return { files: [], active: null }
    const v = JSON.parse(raw) as unknown
    if (v === null || typeof v !== 'object') return { files: [], active: null }
    const o = v as Record<string, unknown>
    const files = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === 'string' && f !== '').slice(0, SESSION_LIMIT) : []
    const active = typeof o.active === 'string' && files.some((f) => samePath(f, o.active as string)) ? o.active : (files[0] ?? null)
    return { files, active }
  } catch {
    return { files: [], active: null }
  }
}

export function writeSession(s: LightSession, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(SESSION_KEY, JSON.stringify({ files: s.files.slice(0, SESSION_LIMIT), active: s.active })) } catch { /* a convenience only */ }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}
