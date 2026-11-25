/**
 * One update check for every window, started when the app starts.
 *
 * The settings row used to check only when someone pressed the button. A
 * publish then sat in R2 until each person happened to open Settings. The
 * check now runs at launch, again every few hours, and when the window is
 * focused after a quiet stretch. It still does not install. Download and
 * restart stay on the button the row already had (`installMode: passive`).
 */
import { useEffect, useState } from 'react'
import {
  shouldPollUpdate, UPDATE_CHECK_INTERVAL_MS, UPDATES_CONFIGURED,
  type UpdatePollReason, type UpdateState,
} from './updates.js'

type Listener = (state: UpdateState) => void

let state: UpdateState = UPDATES_CONFIGURED ? { kind: 'idle' } : { kind: 'unconfigured' }
let lastCheckedAt = 0
let busy = false
let started = false
/** The copy from the portable zip (src-tauri/src/portable.rs). */
let portable = false

export function isPortableCopy(): boolean {
  return portable
}

async function loadPortable(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const info = await invoke<{ portable: boolean }>('app_portable')
    portable = info.portable === true
  } catch {
    portable = false
  }
}
const listeners = new Set<Listener>()

function emit(next: UpdateState): void {
  state = next
  for (const listener of listeners) listener(state)
}

export function getUpdateState(): UpdateState {
  return state
}

export function subscribeUpdateState(listener: Listener): () => void {
  listeners.add(listener)
  listener(state)
  return () => { listeners.delete(listener) }
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

async function checkOnce(): Promise<void> {
  if (busy) return
  if (state.kind === 'downloading' || state.kind === 'ready' || state.kind === 'unconfigured') return
  busy = true
  emit({ kind: 'checking' })
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    lastCheckedAt = Date.now()
    emit(update === null
      ? { kind: 'current' }
      : { kind: 'available', version: update.version, notes: update.body ?? null })
  } catch (err) {
    // A failed check is not "up to date". The row says it could not check.
    lastCheckedAt = Date.now()
    emit({ kind: 'failed', message: messageOf(err) })
  } finally {
    busy = false
  }
}

async function maybeCheck(reason: UpdatePollReason): Promise<void> {
  if (!shouldPollUpdate(state, lastCheckedAt, Date.now(), reason)) return
  await checkOnce()
}

/** Start the unattended checks. Further calls do nothing. */
export function startAutomaticUpdateChecks(): void {
  if (started || !UPDATES_CONFIGURED) return
  if (typeof window === 'undefined') return
  started = true
  void loadPortable().then(() => {
    emit(state)
    return maybeCheck('startup')
  })
  window.setInterval(() => { void maybeCheck('interval') }, UPDATE_CHECK_INTERVAL_MS)
  window.addEventListener('focus', () => { void maybeCheck('focus') })
}

/** What has to finish before the app may quit for an update; false keeps it running. */
let beforeQuit: ((leave: () => void) => Promise<boolean>) | null = null

/** Set by the window that holds unsaved work (a Light file). Null when there is none. */
export function setBeforeQuit(fn: ((leave: () => void) => Promise<boolean>) | null): void {
  beforeQuit = fn
}

/**
 * The button on the update row.
 *
 * `check` looks again. `install` downloads and runs the passive installer.
 * `restart` relaunches into what was just staged. None of these run from
 * the timer above.
 */
export async function performUpdateAction(action: 'check' | 'install' | 'restart', saved = false): Promise<void> {
  /*
   * The portable copy updates by downloading the new zip. Nothing quits, so
   * there is nothing to save first.
   */
  if (action === 'install' && portable) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('portable_open_download')
    } catch (err) {
      emit({ kind: 'failed', message: messageOf(err) })
    }
    return
  }
  /*
   * Installing and restarting both end this process without the window ever
   * being asked to close, so an open Light file is saved into its PDF here
   * first. A refused save leaves the update where it was and asks.
   */
  if (action !== 'check' && !saved && beforeQuit !== null) {
    let ok = true
    try { ok = await beforeQuit(() => { void performUpdateAction(action, true) }) } catch { ok = true }
    if (!ok) return
  }
  if (action === 'restart') {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
    return
  }

  if (action === 'install') {
    if (busy || state.kind !== 'available') return
    busy = true
    emit({ kind: 'downloading', percent: null })
    try {
      const { check } = await import('@tauri-apps/plugin-updater')
      const update = await check()
      if (update === null) {
        emit({ kind: 'current' })
        return
      }
      let total = 0
      let got = 0
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0
        if (event.event === 'Progress') {
          got += event.data.chunkLength
          emit({ kind: 'downloading', percent: total > 0 ? (got / total) * 100 : null })
        }
      })
      emit({ kind: 'ready', version: update.version })
    } catch (err) {
      emit({ kind: 'failed', message: messageOf(err) })
    } finally {
      busy = false
    }
    return
  }

  await checkOnce()
}

export function useUpdateState(desktop: boolean): UpdateState {
  const [current, setCurrent] = useState(getUpdateState)
  useEffect(() => subscribeUpdateState(setCurrent), [])
  useEffect(() => {
    if (desktop) startAutomaticUpdateChecks()
  }, [desktop])
  return current
}
