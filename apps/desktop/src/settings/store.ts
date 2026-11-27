/**
 * Settings persistence and the reset boundary (plan TH.4).
 *
 * Storage is injected so this is testable without a browser and so the desktop
 * can swap in a file-backed store later without touching a consumer.
 *
 * The reset boundary is the load-bearing rule, taken from the Qt ledger:
 * settings are global, reversible PREFERENCES. Project, document, page, scale,
 * scope and calculation data live in their own stores and are outside every
 * reset. resetAll() therefore clears exactly this store's keys and nothing
 * else — a "reset settings" that could delete a takeoff would be unusable.
 */
import {
  RETIRED, SETTINGS, defaults, descriptor, validate, inCategory,
  type SettingCategory, type SettingValue,
} from './registry.js'

export interface SettingsStorage {
  read(): string | null
  write(text: string): void
}

const KEY = 'redbeam.settings.v1'
/** Stamp kept in the stored object; not a setting (load skips `$` keys). */
const STAMP = '$savedAt'

/** Fired on window after any store in this window writes, so a reader holding its own store can re-read. */
export const SETTINGS_CHANGED = 'redbeam:settings'

/** localStorage-backed, with every access guarded. */
export function browserStorage(): SettingsStorage {
  return {
    read() {
      // A private window, cleared site data, or a browser configured to block
      // storage all throw on access rather than returning null.
      try { return localStorage.getItem(KEY) } catch { return null }
    },
    write(text) {
      try { localStorage.setItem(KEY, text) } catch { /* preferences are not worth failing a session over */ }
      writeSettingsFile(text)
    },
  }
}

/*
 * THE COPY ON DISK (Aaron, 2026-11-27: "settings such as beta custom patterns
 * keep being resetted after updates").
 *
 * localStorage is the webview's. A write it has not committed when the
 * updater ends the process to run the installer is gone, and a reset WebView2
 * profile takes every preference with it. So each write also goes to
 * %APPDATA%\com.redbeam.app\settings.json (settings_file.rs), stamped with
 * when it was written, and a launch restores from that file whenever it is
 * newer than what the webview kept. Desktop only; a browser has no file.
 */
function tauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const w = (typeof window === 'undefined' ? undefined : window) as
    { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } | undefined
  const inv = w?.__TAURI_INTERNALS__?.invoke
  return typeof inv === 'function' ? inv : null
}

function writeSettingsFile(text: string): void {
  const inv = tauriInvoke()
  if (inv) void inv('settings_file_write', { text }).catch(() => { /* the webview copy still holds it */ })
}

/** When a stored settings text was written, or 0 for one from before stamps. */
export function savedAt(text: string | null): number {
  if (text === null) return 0
  try {
    const v = (JSON.parse(text) as Record<string, unknown>)[STAMP]
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  } catch { return 0 }
}

/**
 * Which copy a launch should use: the disk copy when it is newer than the
 * webview's (or the webview lost its copy), otherwise null to keep the
 * webview's. Pure, so the upgrade test can drive it.
 */
export function pickRestore(local: string | null, file: string | null): string | null {
  if (file === null) return null
  if (local === null) return file
  return savedAt(file) > savedAt(local) ? file : null
}

/**
 * Bring back the disk copy if the webview lost or missed it. Called once per
 * window at launch; resolves true when it restored, after which the caller's
 * store must `reload()`.
 */
export async function restoreFromFile(storage: SettingsStorage = browserStorage()): Promise<boolean> {
  const inv = tauriInvoke()
  if (!inv) return false
  let file: string | null = null
  try { file = (await inv('settings_file_read')) as string | null } catch { return false }
  const local = storage.read()
  const use = pickRestore(local, typeof file === 'string' ? file : null)
  if (use === null) {
    // The disk copy is older or missing (first run of a build with it): give
    // it the webview's, so the next update has something to come back to.
    if (local !== null && (file === null || savedAt(local) > savedAt(file))) writeSettingsFile(local)
    return false
  }
  try { localStorage.setItem(KEY, use) } catch { /* the store still reloads from the text below */ }
  return true
}

/** In-memory, for tests and for a context window that must not persist. */
export function memoryStorage(initial: Record<string, SettingValue> = {}): SettingsStorage {
  let text: string | null = Object.keys(initial).length > 0 ? JSON.stringify(initial) : null
  return { read: () => text, write: (t) => { text = t } }
}

export interface LoadResult {
  values: Record<string, SettingValue>
  /**
   * Keys that were present but unusable, with why. Surfaced rather than
   * swallowed: a setting silently reverting to its default looks like the app
   * ignoring the user.
   */
  rejected: Array<{ id: string; reason: string }>
}

export class SettingsStore {
  private values: Record<string, SettingValue>
  private readonly listeners = new Set<(v: Record<string, SettingValue>) => void>()
  readonly rejected: Array<{ id: string; reason: string }>

  private constructor(
    private readonly storage: SettingsStorage,
    loaded: LoadResult,
  ) {
    this.values = loaded.values
    this.rejected = loaded.rejected
  }

  static open(storage: SettingsStorage): SettingsStore {
    return new SettingsStore(storage, load(storage))
  }

  /**
   * Follow writes from other windows (the storage event) and from other
   * stores in this window (SETTINGS_CHANGED). For a store that lives as long
   * as its window; a throwaway read-only open must not call it. Returns the
   * unsubscribe.
   */
  watch(): () => void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
    const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === KEY) this.reload() }
    const onChanged = () => { this.reload() }
    window.addEventListener('storage', onStorage)
    window.addEventListener(SETTINGS_CHANGED, onChanged)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(SETTINGS_CHANGED, onChanged)
    }
  }

  /** Re-read storage, telling subscribers only when something changed. */
  reload(): void {
    const next = load(this.storage).values
    if (SETTINGS.every((s) => next[s.id] === this.values[s.id])) return
    this.values = next
    for (const fn of this.listeners) fn(this.all())
  }

  get<T extends SettingValue = SettingValue>(id: string): T {
    return this.values[id] as T
  }

  bool(id: string): boolean { return this.get(id) === true }
  int(id: string): number { return Number(this.get(id)) }
  str(id: string): string { return String(this.get(id)) }

  all(): Record<string, SettingValue> { return { ...this.values } }

  /** Set one value. Returns null on success, or the validation error. */
  set(id: string, raw: unknown): string | null {
    const v = validate(id, raw)
    if (!v.ok) return v.error
    if (this.values[id] === v.value) return null
    this.values = { ...this.values, [id]: v.value }
    this.persist([id])
    return null
  }

  /** Restore one category to its defaults. */
  resetCategory(category: SettingCategory): void {
    const next = { ...this.values }
    for (const d of inCategory(category)) next[d.id] = d.default
    this.values = next
    this.persist(inCategory(category).map((d) => d.id))
  }

  /**
   * Restore every setting.
   *
   * Clears exactly this store's keys. Project data, recent projects and
   * credentials are outside the reset boundary by construction: they are not
   * in this store, so there is nothing here that could reach them.
   */
  resetAll(): void {
    this.values = defaults()
    this.persist(SETTINGS.map((s) => s.id))
  }

  /** True when a setting differs from its shipped default. */
  isModified(id: string): boolean {
    const d = descriptor(id)
    return d !== undefined && this.values[id] !== d.default
  }

  modifiedCount(): number {
    return SETTINGS.filter((s) => this.isModified(s.id)).length
  }

  subscribe(fn: (v: Record<string, SettingValue>) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /*
   * WRITE ONLY WHAT CHANGED, OVER WHAT IS STORED NOW.
   *
   * This used to write this store's whole snapshot. Every REDBEAM window opens
   * its own store when it starts, so a window opened before you turned a beta
   * on still held it off, and the next thing it saved (a layout preview an
   * agent toggled, a theme) wrote "off" back. After a restart for an update
   * the switch read off: the reset Aaron saw. Now a write reads the stored
   * object, changes only the ids it was asked to, and keeps everything else:
   * other windows' changes, and keys from a newer build this one does not
   * know, so running an older copy cannot wipe a newer one's settings.
   */
  private persist(changed: readonly string[]): void {
    const stored = readObject(this.storage)
    for (const id of RETIRED.keys()) delete stored[id]
    for (const id of changed) {
      const d = descriptor(id)
      if (d === undefined) continue
      // Only non-default values are written. A settings file that lists every
      // key freezes today's defaults into it, so a later change to a default
      // would not reach anyone who had ever opened the settings panel.
      if (this.values[id] === d.default) delete stored[id]
      else stored[id] = this.values[id]!
    }
    stored[STAMP] = Math.max(Date.now(), savedAtOf(stored) + 1)
    this.storage.write(JSON.stringify(stored))
    // Take what the other windows had written too.
    this.values = valuesFrom(stored)
    for (const fn of this.listeners) fn(this.all())
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new Event(SETTINGS_CHANGED))
    }
  }
}

function savedAtOf(o: Record<string, unknown>): number {
  const v = o[STAMP]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** The stored object as written, unknown keys and all; {} when unreadable. */
function readObject(storage: SettingsStorage): Record<string, unknown> {
  const text = storage.read()
  if (text === null) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) } : {}
  } catch { return {} }
}

function valuesFrom(stored: Record<string, unknown>): Record<string, SettingValue> {
  return load({ read: () => JSON.stringify(stored), write: () => {} }).values
}

/** Read and validate stored values over the defaults. */
export function load(storage: SettingsStorage): LoadResult {
  const values = defaults()
  const rejected: Array<{ id: string; reason: string }> = []

  const text = storage.read()
  if (text === null) return { values, rejected }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A corrupt file must not take the app down with it.
    return { values, rejected: [{ id: '*', reason: 'settings file was not valid JSON; defaults used' }] }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { values, rejected: [{ id: '*', reason: 'settings file was not an object; defaults used' }] }
  }

  for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
    // A retired key is one WE offered and then withdrew. Reporting it as
    // "could not be read" would blame the user for a switch that never did
    // anything; it is dropped, and the file loses it on the next write.
    if (RETIRED.has(id)) continue
    // Bookkeeping such as the write stamp, not a setting.
    if (id.startsWith('$')) continue
    // Any other unknown key is a setting from a newer build. Not an error
    // worth alarming anyone with, but not silently dropped either — it stays
    // out of `values` and is listed.
    const v = validate(id, raw)
    if (v.ok) values[id] = v.value
    else rejected.push({ id, reason: v.error })
  }
  return { values, rejected }
}
