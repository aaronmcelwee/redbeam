/**
 * Claude and ChatGPT: the switch that lets them use REDBEAM, and the one-click
 * installs. The Rust side is `src-tauri/src/ai_apps.rs`; the server they start
 * is `REDBEAM.exe --mcp` (`src-tauri/src/mcp.rs`).
 *
 * Outside Tauri every call answers "not supported", so the browser build and
 * the tests never touch it.
 */
import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './window.js'

export type AiClientId = 'claude' | 'chatgpt'

export interface AiClientStatus {
  id: AiClientId
  /** The app looks installed on this computer. */
  detected: boolean
  /** REDBEAM is in its config, pointing at this copy. */
  installed: boolean
  /** The config files an install writes. */
  files: string[]
}

export interface AiStatus {
  supported: boolean
  /** The switch, remembered across launches. */
  enabled: boolean
  /** Answering calls right now. */
  running: boolean
  clients: AiClientStatus[]
}

export const AI_UNSUPPORTED: AiStatus = { supported: false, enabled: false, running: false, clients: [] }

function clean(s: Partial<AiStatus> | null | undefined): AiStatus {
  if (s === null || s === undefined) return AI_UNSUPPORTED
  return {
    supported: s.supported === true,
    enabled: s.enabled === true,
    running: s.running === true,
    clients: Array.isArray(s.clients) ? s.clients : [],
  }
}

export async function aiStatus(): Promise<AiStatus> {
  if (!isTauri()) return AI_UNSUPPORTED
  try { return clean(await invoke<Partial<AiStatus>>('ai_apps_status')) } catch { return AI_UNSUPPORTED }
}

export async function aiSetEnabled(enabled: boolean): Promise<AiStatus> {
  return clean(await invoke<Partial<AiStatus>>('ai_apps_set_enabled', { enabled }))
}

export async function aiInstall(client: AiClientId): Promise<AiStatus> {
  return clean(await invoke<Partial<AiStatus>>('ai_apps_install', { client }))
}

export async function aiRemove(client: AiClientId): Promise<AiStatus> {
  return clean(await invoke<Partial<AiStatus>>('ai_apps_remove', { client }))
}
