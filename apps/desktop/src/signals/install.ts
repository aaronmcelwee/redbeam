/**
 * The window's one Signals, and where it plugs into the browser.
 *
 * Off in a browser tab, in `vite dev` and in the UI sweep: only an installed
 * copy, talking to its own update channel, sends anything.
 */
import { reportEndpoint, osFrom } from '../report/report.js'
import { SettingsStore, browserStorage, SETTINGS_CHANGED } from '../settings/store.js'
import { isTauri } from '../tauri/window.js'
import { APP_VERSION } from '../update/updates.js'
import { watchFriction } from './friction.js'
import { FLUSH_EVERY_MS, Signals, type Channel, type Row, type SignalKind } from './signals.js'

export const SHARE_SETTING = 'general.shareSignals'
const INSTALL_KEY = 'redbeam.signals.install'
const HELD_KEY = 'redbeam.signals.held'
const PANICS_KEY = 'redbeam.signals.panicsSeen'

let instance: Signals | null = null

/** The Worker's /signals, beside /reports on the update channel's host. */
export function signalsEndpoint(reports: string | null = reportEndpoint()): string | null {
  return reports === null ? null : reports.replace(/\/reports$/, '/signals')
}

function sharing(): boolean {
  try { return SettingsStore.open(browserStorage()).bool(SHARE_SETTING) } catch { return false }
}

function storage(key: string): { read(): string | null; write(v: string | null): void } {
  return {
    read() { try { return localStorage.getItem(key) } catch { return null } },
    write(v) {
      try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, v) } catch { /* nothing to keep it in */ }
    },
  }
}

function browserChannel(endpoint: string | null, os: () => string): Channel {
  const install = storage(INSTALL_KEY)
  const held = storage(HELD_KEY)
  let enabledCache = sharing()
  window.addEventListener(SETTINGS_CHANGED, () => { enabledCache = sharing() })
  return {
    enabled: () => enabledCache,
    endpoint,
    version: APP_VERSION,
    get os() { return os() },
    install() {
      let id = install.read()
      if (id === null || !/^[0-9a-f-]{36}$/.test(id)) { id = crypto.randomUUID(); install.write(id) }
      return id
    },
    async send(url, body) {
      try {
        // text/plain: a simple request, so no preflight round trip. keepalive
        // lets the last batch finish while the window closes.
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body, keepalive: body.length < 60_000 })
        return res.ok
      } catch {
        return false
      }
    },
    load() {
      const text = held.read()
      if (text === null) return null
      try {
        const o = JSON.parse(text) as { rows?: Row[]; dropped?: number }
        return Array.isArray(o.rows) ? { rows: o.rows, dropped: Number(o.dropped) || 0 } : null
      } catch { return null }
    },
    save(h) { held.write(h === null ? null : JSON.stringify(h)) },
    now: () => new Date(),
  }
}

/** Called once at startup, before the first render. */
export function installSignals(): void {
  if (instance !== null) return
  if (!isTauri() || import.meta.env.DEV) return
  let os = ''
  void (async () => {
    try {
      const ua = (navigator as unknown as { userAgentData?: { platform?: string; getHighEntropyValues?: (h: string[]) => Promise<Record<string, unknown>> } }).userAgentData
      const v = await ua?.getHighEntropyValues?.(['platformVersion'])
      os = osFrom(ua?.platform, v?.['platformVersion'])
    } catch { /* stays empty */ }
  })()
  const s = new Signals(browserChannel(signalsEndpoint(), () => os))
  instance = s
  s.record('app', 'launch')
  setInterval(() => { void s.flush() }, FLUSH_EVERY_MS)
  window.addEventListener('pagehide', () => { void s.flush({ closing: true }) })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void s.flush()
  })
  window.addEventListener(SETTINGS_CHANGED, () => { if (!sharing()) s.forget() })
  watchFriction(document, (name, detail, ms) => s.record('friction', name, detail, ms))
  void countPanics(s)
}

/**
 * A Rust panic ends the process before anything here can count it. crash.rs
 * writes it to disk; the next launch counts the ones it has not seen. The
 * first launch with signals only marks where it starts.
 */
async function countPanics(s: Signals): Promise<void> {
  const seen = storage(PANICS_KEY)
  const since = seen.read()
  let reports: Array<{ written_at: string; kind: string; message: string }> = []
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    reports = await invoke('crash_reports')
  } catch { return }
  let newest = since ?? new Date().toISOString()
  for (const r of reports) {
    if (since !== null && r.written_at > since && r.kind === 'rust-panic') s.record('error', 'panic:rust', r.message)
    if (r.written_at > newest) newest = r.written_at
  }
  seen.write(newest)
}

/** Count one event. A no-op until installed, and with sharing off. */
export function signal(kind: SignalKind, name: string, detail = '', ms: number | null = null): void {
  instance?.record(kind, name, detail, ms)
}

/** Count an error by its type, scrubbed message and first frames. */
export function signalError(where: string, err: unknown): void {
  instance?.error(where, err)
}

/** Send now (a test hook, and the window closing). */
export function flushSignals(): Promise<void> {
  return instance?.flush() ?? Promise.resolve()
}

export { provideNames } from './signals.js'
