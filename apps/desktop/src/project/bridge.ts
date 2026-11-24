/**
 * The TypeScript side of `src-tauri/src/project.rs`.
 *
 * Every function here has a browser fallback, because the app is expected to
 * run in a plain tab for fast iteration and the picker must degrade rather than
 * throw. What each fallback does is stated at its call site; the short version:
 * the browser can remember a list of paths and let you type one, but it cannot
 * open a folder dialog and cannot read a folder, so it says so.
 *
 * # Permissions
 *
 * None of these calls need a capability grant. They invoke application
 * commands defined in this app's own crate, and Tauri v2's ACL gates the
 * webview hop for `core:*` and `plugin:*` commands only. In particular this
 * file deliberately does NOT import `@tauri-apps/plugin-fs` or
 * `@tauri-apps/plugin-dialog`: doing so would pull the filesystem and dialog
 * surfaces into the webview and require `fs:` / `dialog:` permissions, when the
 * Rust side can do the same work with none.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { isTauri } from '../tauri/window.js'
import type {
  DrawingPickOutcome, FilePickOutcome, PickOutcome, ProjectInfo, ProjectNesting, RecentProject, ScanResult,
} from './types.js'

/**
 * The shape of `invoke` this module needs. Injectable so tests need no runtime.
 *
 * `args` may be raw bytes, with what would have been the named arguments in
 * `options.headers`: Tauri then hands the bytes to Rust as the request body
 * instead of encoding them as JSON. See `writeDocument`.
 */
export type InvokeFn = <T>(
  cmd: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: { headers: Record<string, string> },
) => Promise<T>

/** The slice of `Storage` the browser fallback uses. */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ProjectBridgeOptions {
  invoke?: InvokeFn
  /** Override the environment check. */
  desktop?: boolean
  /** Where browser-mode recents live. Defaults to `localStorage`. */
  storage?: KeyValueStore | null
  now?: () => Date
}

export const BROWSER_RECENTS_KEY = 'redbeam.recent-projects'

/** Kept in step with `MAX_RECENTS` in project.rs. */
export const MAX_RECENTS = 200

const BROWSER_NO_DIALOG =
  'a browser tab cannot open a file dialog — type a project folder path instead'

const BROWSER_NO_SCAN =
  'a browser tab cannot read a folder; run the desktop app to ingest a project'

const BROWSER_NO_READ =
  'a browser tab cannot read a project file; run the desktop app'

export interface ProjectBridge {
  /** True when the Rust core is reachable. */
  readonly desktop: boolean
  pickFolder(): Promise<PickOutcome>
  /** Open a PDF and take its folder as the project. */
  pickDrawing(): Promise<DrawingPickOutcome>
  /**
   * Pick a PDF and nothing else: no project resolved, no database made, no
   * recents touched. `path` is the file's absolute path. For quick view
   * (Aaron, 2026-09-18: opening a drawing "should not create a project
   * instantly. It should just open the file for quick viewing").
   */
  pickFile(): Promise<FilePickOutcome>
  /** The same for a path that arrived without a dialog — a drawing dropped on the window. */
  locateFile(path: string): Promise<FilePickOutcome>
  /**
   * Whether `path` sits inside a project that already has a database.
   * Does not open it. In the browser there is no folder to look above, so
   * `parent` is always null.
   */
  projectNesting(path: string): Promise<ProjectNesting>
  openProject(path: string, options?: { create?: boolean; own?: boolean }): Promise<ProjectInfo>
  listRecents(): Promise<RecentProject[]>
  forgetRecent(path: string): Promise<RecentProject[]>
  /** Name a recent project; an empty name goes back to the folder name. */
  renameRecent(path: string, name: string): Promise<RecentProject[]>
  /**
   * Set the project's database aside (into `.redbeam/removed-<stamp>/`) and
   * forget it. The drawings are untouched. Desktop only.
   */
  removeProjectData(path: string): Promise<RecentProject[]>
  /**
   * The older project whose `redbeam.db` sits in `folder` or above it, or
   * null. Opens nothing. `prefix` plus a file name in `folder` is that file's
   * path as the old project knew it. Always null in the browser.
   */
  findOldProject(folder: string): Promise<OldProject | null>
  /**
   * Set aside an old project's database once its takeoff is inside the PDFs:
   * moved into `.redbeam/superseded-<stamp>/`, never deleted. Desktop only.
   */
  supersedeOldProject(root: string): Promise<void>
  /** Show the folder in Explorer / Finder. Desktop only. */
  revealProject(path: string): Promise<void>
  clearRecents(): Promise<void>
  scanProject(path: string, extensions?: string[]): Promise<ScanResult>
  /**
   * A document's bytes, for the paths that need the file itself rather than a
   * URL to it — PDF write-back, so far.
   *
   * Rejects in browser mode. A caller that treats "no bytes" as "empty file"
   * would write a valid, blank PDF over a real drawing's name, so this is one
   * of the few places where failing is better than degrading.
   */
  readDocument(projectPath: string, relativePath: string): Promise<Uint8Array>
  /**
   * Replace a drawing with new bytes, only if its SHA-256 is still
   * `expectedSha256` (the file the bytes were built from). Written through a
   * temporary file and a rename. `busy` means another program holds it open.
   * Rejects in browser mode.
   */
  writeDocument(projectPath: string, relativePath: string, bytes: Uint8Array, expectedSha256: string): Promise<DocumentWrite>
  /**
   * Write a NEW drawing inside the project, refusing if anything is already
   * at that path. For a working copy of a file that is not ours to write into.
   * Rejects in browser mode.
   */
  createDocument?(projectPath: string, relativePath: string, bytes: Uint8Array): Promise<DocumentWrite>
  /**
   * Add `tail` to the end of a drawing, only if it is still `expectedLength`
   * bytes with SHA-256 `expectedSha256`. For an incremental update, which only
   * ever adds to the file: the rest of it is not written again. Rejects in
   * browser mode.
   */
  appendDocument(projectPath: string, relativePath: string, tail: Uint8Array, expectedSha256: string, expectedLength: number): Promise<DocumentWrite>
}

/** See `ProjectBridge.findOldProject`. */
export interface OldProject { root: string, prefix: string }

export type DocumentWrite =
  | { outcome: 'written'; fingerprint: string }
  | { outcome: 'changed' }
  | { outcome: 'busy'; message: string }

// ------------------------------------------------------------- utilities --

/** Folder name of a path, tolerating either separator and a trailing slash. */
export function projectNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const name = cut >= 0 ? trimmed.slice(cut + 1) : trimmed
  return name === '' ? trimmed : name
}

function toFilePick(raw: unknown): FilePickOutcome {
  const r = asRecord(raw)
  return {
    supported: bool(r.supported),
    path: nullableStr(r.path),
    project: r.project === null || r.project === undefined ? null : toProjectInfo(r.project),
    relativePath: nullableStr(r.relativePath),
    reason: nullableStr(r.reason),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const nullableStr = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

const bool = (value: unknown): boolean => value === true

function toProjectInfo(raw: unknown): ProjectInfo {
  const r = asRecord(raw)
  const path = str(r.path)
  return {
    path,
    name: str(r.name) || projectNameFromPath(path),
    dbPath: str(r.db_path),
    created: bool(r.created),
    hasDatabase: bool(r.has_database),
  }
}

function toNesting(raw: unknown, fallback: string): ProjectNesting {
  const r = asRecord(raw)
  const parent = nullableStr(r.parent)
  const parentName = nullableStr(r.parent_name ?? r.parentName)
  return {
    asked: str(r.asked) || fallback,
    parent,
    parentName: parentName ?? (parent === null ? null : projectNameFromPath(parent)),
  }
}

function toRecent(raw: unknown): RecentProject {
  const r = asRecord(raw)
  const path = str(r.path)
  return {
    path,
    name: str(r.name) || projectNameFromPath(path),
    displayName: nullableStr(r.display_name ?? r.displayName),
    lastOpenedAt: str(r.last_opened_at),
    missing: bool(r.missing),
  }
}

function toScanResult(raw: unknown): ScanResult {
  const r = asRecord(raw)
  const files = Array.isArray(r.files) ? r.files : []
  return {
    root: str(r.root),
    truncated: bool(r.truncated),
    unreadable: Array.isArray(r.unreadable) ? r.unreadable.map((u) => str(u)) : [],
    scannedAt: str(r.scanned_at),
    files: files.map((file) => {
      const f = asRecord(file)
      return {
        relativePath: str(f.relative_path),
        absolutePath: str(f.absolute_path),
        displayName: str(f.display_name),
        kind: str(f.kind, 'other'),
        status: str(f.status, 'current'),
        sizeBytes: typeof f.size_bytes === 'number' ? f.size_bytes : 0,
        modifiedAt: nullableStr(f.modified_at),
        contentFingerprint: nullableStr(f.content_fingerprint),
        availability: str(f.availability, 'local'),
        fileDateHint: nullableStr(f.file_date_hint),
      }
    }),
  }
}

// -------------------------------------------------------- browser recents --

function readBrowserRecents(storage: KeyValueStore | null): RecentProject[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(BROWSER_RECENTS_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((entry) => {
      const r = asRecord(entry)
      const path = str(r.path)
      return {
        path,
        name: str(r.name) || projectNameFromPath(path),
        displayName: nullableStr(r.displayName),
        lastOpenedAt: str(r.lastOpenedAt),
        // A browser cannot check whether the folder exists, so it never claims
        // one is missing. Saying "missing" on no evidence would be worse than
        // saying nothing.
        missing: false,
      }
    })
  } catch {
    // A corrupt list is a nuisance, not a reason to refuse to start.
    return []
  }
}

function writeBrowserRecents(storage: KeyValueStore | null, projects: RecentProject[]): void {
  if (!storage) return
  try {
    storage.setItem(BROWSER_RECENTS_KEY, JSON.stringify(projects.slice(0, MAX_RECENTS)))
  } catch {
    // Private browsing, or a full quota. The app works without a recents list.
  }
}

function defaultStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Some embedding contexts throw on the mere access.
    return null
  }
}

// ------------------------------------------------------------------ build --

export function createProjectBridge(opts: ProjectBridgeOptions = {}): ProjectBridge {
  const desktop = opts.desktop ?? isTauri()
  const invoke: InvokeFn =
    opts.invoke ??
    (<T>(cmd: string, args?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }) =>
      tauriInvoke<T>(cmd, args ?? {}, options))
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage
  const now = opts.now ?? (() => new Date())

  return {
    desktop,

    async pickFolder(): Promise<PickOutcome> {
      if (!desktop) {
        return { supported: false, path: null, reason: BROWSER_NO_DIALOG }
      }
      const raw = await invoke<unknown>('project_pick_folder')
      const r = asRecord(raw)
      return {
        supported: bool(r.supported),
        path: nullableStr(r.path),
        reason: nullableStr(r.reason),
      }
    },

    async pickDrawing(): Promise<DrawingPickOutcome> {
      if (!desktop) {
        return { supported: false, project: null, relativePath: null, reason: BROWSER_NO_DIALOG }
      }
      const raw = await invoke<unknown>('project_pick_drawing')
      const r = asRecord(raw)
      const project = r.project === null || r.project === undefined
        ? null
        : toProjectInfo(r.project)
      return {
        supported: bool(r.supported),
        project,
        relativePath: nullableStr(r.relativePath),
        reason: nullableStr(r.reason),
      }
    },

    async pickFile(): Promise<FilePickOutcome> {
      if (!desktop) {
        return { supported: false, path: null, project: null, relativePath: null, reason: BROWSER_NO_DIALOG }
      }
      return toFilePick(await invoke<unknown>('project_pick_file'))
    },

    async locateFile(path): Promise<FilePickOutcome> {
      if (!desktop) {
        return { supported: false, path: null, project: null, relativePath: null, reason: BROWSER_NO_DIALOG }
      }
      return toFilePick(await invoke<unknown>('project_locate_file', { path }))
    },

    async projectNesting(path): Promise<ProjectNesting> {
      const trimmed = path.trim()
      if (trimmed === '') throw new Error('no project folder was given')
      if (!desktop) return { asked: trimmed, parent: null, parentName: null }
      return toNesting(await invoke<unknown>('project_nesting', { path: trimmed }), trimmed)
    },

    async openProject(path, options = {}): Promise<ProjectInfo> {
      const trimmed = path.trim()
      if (trimmed === '') throw new Error('no project folder was given')

      if (!desktop) {
        // The browser store is IndexedDB and ignores the path entirely, so the
        // folder is remembered as a label rather than resolved. The recents
        // list still works, which is the part worth having in dev.
        const info: ProjectInfo = {
          path: trimmed,
          name: projectNameFromPath(trimmed),
          dbPath: 'IndexedDB (browser fallback)',
          created: false,
          hasDatabase: false,
        }
        const existing = readBrowserRecents(storage).filter(
          (p) => p.path.toLowerCase() !== trimmed.toLowerCase(),
        )
        writeBrowserRecents(storage, [
          {
            path: info.path,
            name: info.name,
            displayName: readBrowserRecents(storage)
              .find((p) => p.path.toLowerCase() === trimmed.toLowerCase())?.displayName ?? null,
            lastOpenedAt: now().toISOString(),
            missing: false,
          },
          ...existing,
        ])
        return info
      }

      return toProjectInfo(
        await invoke<unknown>('project_open', {
          path: trimmed,
          create: options.create ?? false,
          ...(options.own === true ? { own: true } : {}),
        }),
      )
    },

    async listRecents(): Promise<RecentProject[]> {
      if (!desktop) return readBrowserRecents(storage)
      const raw = await invoke<unknown>('project_recents')
      return Array.isArray(raw) ? raw.map(toRecent) : []
    },

    async forgetRecent(path): Promise<RecentProject[]> {
      if (!desktop) {
        const remaining = readBrowserRecents(storage).filter(
          (p) => p.path.toLowerCase() !== path.toLowerCase(),
        )
        writeBrowserRecents(storage, remaining)
        return remaining
      }
      const raw = await invoke<unknown>('project_forget_recent', { path })
      return Array.isArray(raw) ? raw.map(toRecent) : []
    },

    async renameRecent(path, name): Promise<RecentProject[]> {
      const trimmed = name.trim()
      if (!desktop) {
        const list = readBrowserRecents(storage).map((p) =>
          p.path.toLowerCase() === path.toLowerCase()
            ? { ...p, displayName: trimmed === '' ? null : trimmed }
            : p)
        writeBrowserRecents(storage, list)
        return list
      }
      const raw = await invoke<unknown>('project_rename_recent', { path, name: trimmed })
      return Array.isArray(raw) ? raw.map(toRecent) : []
    },

    async removeProjectData(path): Promise<RecentProject[]> {
      if (!desktop) throw new Error('The browser build keeps its data in IndexedDB and cannot set a project folder aside.')
      const raw = await invoke<unknown>('project_remove_data', { path })
      return Array.isArray(raw) ? raw.map(toRecent) : []
    },

    async findOldProject(folder): Promise<OldProject | null> {
      if (!desktop || folder.trim() === '') return null
      const raw = await invoke<unknown>('project_old_data', { path: folder })
      if (raw === null || raw === undefined) return null
      const r = asRecord(raw)
      const root = str(r.root)
      return root === '' ? null : { root, prefix: str(r.prefix) }
    },

    async supersedeOldProject(root): Promise<void> {
      if (!desktop) throw new Error('The browser build has no project database on disk to set aside.')
      await invoke<unknown>('project_supersede_data', { path: root })
    },

    async revealProject(path): Promise<void> {
      if (!desktop) throw new Error('The browser build has no file manager to show the folder in.')
      await invoke<void>('project_reveal', { path })
    },

    async clearRecents(): Promise<void> {
      if (!desktop) {
        writeBrowserRecents(storage, [])
        return
      }
      await invoke<void>('project_clear_recents')
    },

    async scanProject(path, extensions): Promise<ScanResult> {
      if (!desktop) {
        // `truncated: true` is load bearing, not decoration: it tells the
        // ingest not to reconcile. An empty scan treated as authoritative
        // would flag every document in the project as missing.
        return {
          root: path,
          files: [],
          truncated: true,
          unreadable: [BROWSER_NO_SCAN],
          scannedAt: now().toISOString(),
        }
      }
      return toScanResult(
        await invoke<unknown>('project_scan', {
          path,
          ...(extensions === undefined ? {} : { extensions }),
        }),
      )
    },

    async readDocument(projectPath, relativePath): Promise<Uint8Array> {
      if (!desktop) throw new Error(BROWSER_NO_READ)
      const bytes = await invoke<ArrayBuffer | Uint8Array | number[]>(
        'project_read_document',
        { path: projectPath, relativePath },
      )
      // A transport that falls back to JSON yields a number array. Handling it
      // here rather than at the call site is what keeps a caller from ending up
      // with a Uint8Array full of NaN and a PDF that will not parse.
      if (bytes instanceof Uint8Array) return bytes
      if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
      return new Uint8Array(bytes)
    },

    async writeDocument(projectPath, relativePath, bytes, expectedSha256): Promise<DocumentWrite> {
      if (!desktop) throw new Error(BROWSER_NO_READ)
      /*
       * The bytes go as the raw request body, the paths as headers.
       *
       * This sent `bytes: Array.from(bytes)` inside the JSON arguments, so an
       * 80 MB drawing set became an 80-million-element array and then a ~300 MB
       * JSON string, built on the UI thread: four seconds and more with the
       * window frozen, and a gigabyte of garbage to collect after it. Harmless
       * while this ran only on leaving a drawing; since 0.3.17 it runs a few
       * seconds after every change, which is what made pan and zoom stutter.
       * Headers are ASCII, so the paths are percent-encoded (Rust decodes).
       */
      return invoke<DocumentWrite>('project_write_document', bytes, {
        headers: {
          'x-redbeam-path': encodeURIComponent(projectPath),
          'x-redbeam-relative-path': encodeURIComponent(relativePath),
          'x-redbeam-expected-sha256': expectedSha256,
        },
      })
    },

    async createDocument(projectPath, relativePath, bytes): Promise<DocumentWrite> {
      if (!desktop) throw new Error(BROWSER_NO_READ)
      return invoke<DocumentWrite>('project_create_document', bytes, {
        headers: {
          'x-redbeam-path': encodeURIComponent(projectPath),
          'x-redbeam-relative-path': encodeURIComponent(relativePath),
        },
      })
    },

    async appendDocument(projectPath, relativePath, tail, expectedSha256, expectedLength): Promise<DocumentWrite> {
      if (!desktop) throw new Error(BROWSER_NO_READ)
      return invoke<DocumentWrite>('project_append_document', tail, {
        headers: {
          'x-redbeam-path': encodeURIComponent(projectPath),
          'x-redbeam-relative-path': encodeURIComponent(relativePath),
          'x-redbeam-expected-sha256': expectedSha256,
          'x-redbeam-expected-length': String(expectedLength),
        },
      })
    },
  }
}

/** The bridge the app uses. Tests build their own with `createProjectBridge`. */
export const projectBridge: ProjectBridge = createProjectBridge()
