/**
 * Light mode: REDBEAM as a PDF viewer with takeoff (Aaron, 2026-11-18).
 *
 * "I want to create a light version of REDBEAM that disables the project
 * feature and just is more of a file viewer like Bluebeam. It still allows me
 * to create scopes and mark up as it is, but it just embeds the stuff in the
 * PDF file as opposed to working in the project." Pro keeps the project, its
 * database and its bidding rounds for the people who use them.
 *
 * This file holds the pieces of that which are decisions rather than wiring:
 * which mode is on, and which palette commands only mean something with a
 * project behind the window.
 */
import { SettingsStore, browserStorage } from './settings/store.js'
import type { RailPanel } from './shell/Shell.js'
import type { SearchScope } from './search/SearchPanel.js'

export type AppMode = 'light' | 'pro'

export const MODE_SETTING = 'general.mode'

/** The mode Settings › General holds. Light unless someone chose Pro. */
export function readMode(store: Pick<SettingsStore, 'str'> = SettingsStore.open(browserStorage())): AppMode {
  return store.str(MODE_SETTING) === 'pro' ? 'pro' : 'light'
}

/** Remember a mode. Returns the refusal, if the store gave one. */
export function writeMode(mode: AppMode, store: Pick<SettingsStore, 'set'> = SettingsStore.open(browserStorage())): string | null {
  return store.set(MODE_SETTING, mode)
}

/**
 * Palette commands that act on the project rather than on the open file.
 *
 * Rounds are how a project splits one job into bids; a Light file has exactly
 * one, made for it, so making, renaming, copying or deleting rounds has
 * nothing to act on. The rest need a folder of drawings or a database on disk.
 */
const PROJECT_ONLY = new Set([
  'new-round', 'rename-round', 'duplicate-round', 'delete-round',
  'set-project-aside', 'context-window', 'refresh-files',
  'search', 'search-folder',
  'close-tab', 'close-other-tabs', 'reopen-tab',
  'pane-files',
  // Light's own "Save takeoff into this PDF" says the same thing with the file's words.
  'save-takeoff',
])

/** Ids of commands built per round, per project or per recent project. */
const PROJECT_ONLY_PREFIX = ['est-', 'project:']

export function isProjectOnlyCommand(id: string): boolean {
  return PROJECT_ONLY.has(id) || PROJECT_ONLY_PREFIX.some((p) => id.startsWith(p))
}

/**
 * The palette as Light mode shows it: project-only commands gone, closing
 * named for a file, and the file verbs added at the top.
 */
export function lightCommands<C extends { id: string; title: string; detail?: string }>(
  all: readonly C[],
  extra: readonly C[],
): C[] {
  const kept = all
    .filter((c) => !isProjectOnlyCommand(c.id))
    .map((c) => {
      if (c.id === 'close-project') return { ...c, title: 'Close file', detail: 'Saves the takeoff into the PDF, then back to the start page' }
      if (c.id === 'pane-estimates') return { ...c, title: c.title.replace('estimates pane', 'takeoff pane') }
      if (c.id === 'export-estimate') return { ...c, title: 'Export takeoff…' }
      if (c.id === 'remove-scope') return { ...c, title: 'Remove scope…' }
      return c
    })
  return [...extra, ...kept]
}

/**
 * The left rail in Light. Files lists a project's folder of drawings; a Light
 * window is one PDF, so the rail is that file's sheets and its search.
 */
export const LIGHT_PANELS: readonly RailPanel[] = ['contents', 'thumbnails', 'search']

/**
 * Settings that only steer projects: reopening the last one, and how long the
 * recent-projects list is. Light's recents are PDFs and are not governed by them.
 */
export const LIGHT_HIDDEN_SETTINGS: readonly string[] = [
  'general.restoreProjectWindows', 'general.recentProjectLimit', 'general.recentExpiry',
]

/** Search reaches in Light: Folder and Project would only repeat Document. */
export const LIGHT_REACHES: readonly SearchScope[] = ['sheet', 'document']
