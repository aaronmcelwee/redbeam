/**
 * PDFs opened from Windows: Explorer, "Open with", and REDBEAM as the default
 * PDF viewer. The Rust side is `src-tauri/src/open_with.rs`; the installer
 * registration is `src-tauri/windows/hooks.nsh`.
 *
 * Every call is a no-op (or a "not supported" answer) outside Tauri, so the
 * browser build and the tests never touch it.
 */
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './window.js'

/** The PDF this copy of REDBEAM was started with, handed to the first window once. */
export async function takeLaunchFile(): Promise<string | null> {
  if (!isTauri()) return null
  try {
    const path = await invoke<string | null>('launch_take_file')
    return typeof path === 'string' && path !== '' ? path : null
  } catch { return null }
}

/**
 * Tell the app what this window shows, so a PDF opened from Explorer later
 * comes forward in the window already showing it, fills a window on the
 * start screen, or gets a window of its own.
 */
export async function reportShowing(idle: boolean, file: string | null): Promise<void> {
  if (!isTauri()) return
  try { await invoke('launch_showing', { idle, file }) } catch { /* only routing is lost */ }
}

/** Hand a PDF back to be opened elsewhere: this window was no longer free when it arrived. */
export async function openElsewhere(path: string): Promise<void> {
  if (!isTauri()) return
  await invoke('launch_open', { path })
}

/** A PDF opened from Explorer, routed to this window. Returns the unsubscribe. */
export async function onOpenFile(handler: (path: string) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  // The window's own listener: the event is sent to this window only.
  return getCurrentWebviewWindow().listen<string>('redbeam://open-file', (e) => {
    if (typeof e.payload === 'string' && e.payload !== '') handler(e.payload)
  })
}

export interface PdfHandlerStatus {
  /** False off Windows and in a browser. */
  supported: boolean
  /** The installer registered REDBEAM for PDFs (Open with, Default apps). */
  registered: boolean
  /** The person chose REDBEAM as the default PDF viewer. */
  isDefault: boolean
}

const UNSUPPORTED: PdfHandlerStatus = { supported: false, registered: false, isDefault: false }

export async function pdfHandlerStatus(): Promise<PdfHandlerStatus> {
  if (!isTauri()) return UNSUPPORTED
  try {
    const s = await invoke<Partial<PdfHandlerStatus>>('pdf_handler_status')
    return { supported: s.supported === true, registered: s.registered === true, isDefault: s.isDefault === true }
  } catch { return UNSUPPORTED }
}

/** Open Windows Settings › Default apps on REDBEAM's page, where the person picks it for .pdf. */
export async function choosePdfHandler(): Promise<void> {
  if (!isTauri()) return
  await invoke('pdf_handler_choose')
}

/** "Not now" on the start screen's offer, remembered on this machine. */
const DISMISS_KEY = 'redbeam.default-viewer-offer-dismissed'
export function defaultOfferDismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
}
export function dismissDefaultOffer(): void {
  try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* a private window asks again */ }
}

/**
 * The status, kept current: Windows Settings is another window, so the answer
 * is read again whenever this one comes back into focus.
 */
export function usePdfHandlerStatus(): PdfHandlerStatus {
  const [status, setStatus] = useState<PdfHandlerStatus>(UNSUPPORTED)
  useEffect(() => {
    if (!isTauri()) return
    let live = true
    const read = () => { void pdfHandlerStatus().then((s) => { if (live) setStatus(s) }) }
    read()
    window.addEventListener('focus', read)
    return () => { live = false; window.removeEventListener('focus', read) }
  }, [])
  return status
}
