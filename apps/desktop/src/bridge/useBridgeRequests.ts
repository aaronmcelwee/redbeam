/**
 * The frontend half of the automation bridge (plan 11.3 / 11.5).
 *
 * Rust emits `redbeam://bridge/request`; the window answers through the
 * `bridge_reply` command. Actions run through the SAME handlers a click uses,
 * so a bridge-driven action cannot drift from what a person would get — which
 * is the whole reason the bridge does not write UI state from Rust directly.
 *
 * SEVERAL PDFS ANSWER AT ONCE. Aaron, 2026-11-24: "MULTIPLE agents ...
 * ALONGSIDE a human. so say 10 tabs open, human working in 2-3 tabs, then
 * collapsed tab groups showing different agents with their own environments".
 * Each open workspace registers what it can do here, under its file
 * (`useBridgeHost`), and the window's one listener (`useBridgeListener`,
 * mounted by App) hands each request to agents/router.ts, which picks the
 * workspace the calling agent means. A workspace no longer listens itself:
 * with several mounted, every one of them would have answered every call.
 *
 * Failures are reported IN BAND, as `{error}`, rather than thrown. A throw
 * here would leave the Rust waiter to time out after twenty seconds with a
 * message about a wedged window, which is a much worse description of "you
 * asked for a screenshot and no canvas is mounted".
 */
import { useEffect, useRef } from 'react'
import { isTauri } from '../tauri/window.js'
import type { Agent } from '../agents/roster.js'
import { samePath } from '../lightTabs.js'

/** Who a call is from, and what it may do to the view of the PDF it landed in. */
export interface CallContext {
  /** The agent, or null for a caller with no name (a script, an old server). */
  agent: Agent | null
  /**
   * Whether this caller may move the PDF's view: turn its pages, zoom it,
   * change its tool, selection or panels. True in a tab the agent opened or
   * was handed; false in the person's own tab, where a call that would move
   * the view is answered `{error, handover: true}` instead of being done.
   */
  drives: boolean
}

/** The context of a call nobody named: it acts on the PDF showing, as every call once did. */
export const UNNAMED_CALL: CallContext = { agent: null, drives: true }

export interface BridgeActions {
  /** Whatever the driving agent should be able to see about this window. */
  uiState: () => Record<string, unknown>
  /**
   * PNG data URL of the current canvas, or of a box of the sheet rendered at
   * a chosen size; null when nothing is mounted.
   */
  screenshot: (params: Record<string, unknown>, ctx: CallContext) => string | null | Promise<string | null>
  /** Named UI action, e.g. selecting a tool or a scope. */
  /**
   * May be async. A write that reports before it has landed turns a failure
   * into a recorded success — committing five scopes in succession lost one
   * that way, silently, with the caller told it had worked.
   */
  invoke: (
    action: string,
    params: Record<string, unknown>,
    ctx: CallContext,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>
  /**
   * One read-only SELECT against this window's store. Light keeps the takeoff
   * here, in the store the PDF was read into, so the bridge's listings and
   * execute_query answer from it (bridge/methods.rs `light_query`).
   */
  query?: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>
  /** Write bytes to a path the agent chose (never replacing a PDF); resolves to the path written. */
  saveFile?: ((path: string, bytes: Uint8Array, overwrite: boolean) => Promise<string>) | undefined
}

/** The bytes of a base64 data URL. */
export function dataUrlBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Whether `sql` only reads. The bridge checks execute_query's SQL before it
 * gets here; this holds for every caller, so a store with no undo entry
 * behind it is never written from outside.
 */
export function isReadOnlySql(sql: string): boolean {
  const t = sql.trim().replace(/;\s*$/, '').trim()
  return /^(select|with)\b/i.test(t) && !t.includes(';')
}

/** How often a window working on a bridge request says so. */
export const ALIVE_EVERY_MS = 2000

// ---------------------------------------------------------------- hosts --

/**
 * The workspaces mounted in this window, by the file each shows. A
 * workspace with no file (there is none in Light) registers under ''.
 */
export class BridgeHosts {
  private readonly hosts: Array<{ file: string; actions: () => BridgeActions }> = []
  private readonly listeners = new Set<() => void>()

  /** Register a workspace. Returns the function that takes it away again. */
  add(file: string, actions: () => BridgeActions): () => void {
    const entry = { file, actions }
    this.hosts.push(entry)
    this.changed()
    return () => {
      const i = this.hosts.indexOf(entry)
      if (i >= 0) this.hosts.splice(i, 1)
      this.changed()
    }
  }

  /** What the workspace showing `file` can do, or undefined while it is not mounted. */
  get(file: string): BridgeActions | undefined {
    // The newest first: a workspace remounting registers before the old one is gone.
    for (let i = this.hosts.length - 1; i >= 0; i--) {
      if (samePath(this.hosts[i]!.file, file)) return this.hosts[i]!.actions()
    }
    return undefined
  }

  files(): string[] {
    return this.hosts.map((h) => h.file)
  }

  /** Called whenever a workspace mounts or goes. Returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private changed(): void {
    for (const fn of [...this.listeners]) fn()
  }
}

/** This window's workspaces. */
export const bridgeHosts = new BridgeHosts()

/**
 * A workspace's side: say what this PDF can do for the bridge. Registered
 * once per mount; the ref hands every call the latest handlers.
 */
export function useBridgeHost(file: string, actions: BridgeActions, hosts: BridgeHosts = bridgeHosts): void {
  const ref = useRef(actions)
  useEffect(() => { ref.current = actions }, [actions])
  useEffect(() => hosts.add(file, () => ref.current), [file, hosts])
}

// -------------------------------------------------------------- listener --

export interface BridgeRequest {
  id: number
  action: string
  params?: Record<string, unknown>
  /** `{id, client, label}` of the calling agent; null or absent for a caller with no name. */
  agent?: unknown
}

/**
 * The window's one listener. `answer` resolves to the reply, or to null when
 * this window is not the one the request is for (another window answers).
 *
 * Held in a ref so the listener is registered ONCE. Re-registering on every
 * render would drop in-flight requests and leak listeners.
 */
export function useBridgeListener(answer: (req: BridgeRequest) => Promise<Record<string, unknown> | null>): void {
  const ref = useRef(answer)
  useEffect(() => { ref.current = answer }, [answer])

  useEffect(() => {
    if (!isTauri()) return
    let stop: (() => void) | undefined
    let cancelled = false

    void (async () => {
      const [{ listen }, { invoke }] = await Promise.all([
        import('@tauri-apps/api/event'),
        import('@tauri-apps/api/core'),
      ])

      const un = await listen<BridgeRequest>('redbeam://bridge/request', (event) => { void (async () => {
        const { id } = event.payload
        let result: Record<string, unknown> | null
        /*
         * "Still working on it", every two seconds until the answer goes.
         * The app waits on a request for as long as these keep coming, so
         * long work (an export of a big set) is never cut off by a clock;
         * a window that stops answering still fails after a short silence
         * (bridge/ui.rs).
         */
        const beat = setInterval(() => { void invoke('bridge_alive', { id }).catch(() => {}) }, ALIVE_EVERY_MS)
        try {
          result = await ref.current(event.payload)
        } catch (e) {
          // In band, so the caller learns what actually went wrong instead of
          // waiting out the Rust timeout.
          result = { error: e instanceof Error ? e.message : String(e) }
        }
        clearInterval(beat)
        if (result !== null) void invoke('bridge_reply', { id, result })
      })() })

      if (cancelled) un()
      else stop = un
    })()

    return () => { cancelled = true; stop?.() }
  }, [])
}

/**
 * Run one request against one workspace: the four things a workspace
 * answers. Everything about WHICH workspace is agents/router.ts.
 */
export async function runOnHost(
  host: BridgeActions, action: string, params: Record<string, unknown>, ctx: CallContext,
): Promise<Record<string, unknown>> {
  try {
    switch (action) {
      case 'get_ui_state':
        return host.uiState()
      case 'screenshot': {
        const dataUrl = await host.screenshot(params, ctx)
        if (dataUrl === null) return { error: 'no canvas is mounted yet; the PDF is still opening. Poll redbeam_get_ui_state until pageCount > 0.' }
        /*
         * Saved to a file instead of sent back (NOIC report, 2026-11-26:
         * "export a sheet image with the layout drawn on it, so check images
         * can go to you without driving the live window"). The picture is the
         * same one the reply would carry; only where it goes differs.
         */
        const path = typeof params['path'] === 'string' ? params['path'].trim() : ''
        if (path !== '') {
          if (!/\.png$/i.test(path)) return { error: 'path must end in .png' }
          if (host.saveFile === undefined) return { error: 'this build cannot write files' }
          const bytes = dataUrlBytes(dataUrl)
          const written = await host.saveFile(path, bytes, params['overwrite'] === true)
          return { saved: true, path: written, bytes: bytes.length }
        }
        return { dataUrl, bytes: dataUrl.length }
      }
      case 'invoke_ui_action': {
        const name = typeof params['action'] === 'string' ? params['action'] : ''
        if (name === '') return { error: 'invoke_ui_action needs `action`' }
        return await host.invoke(name, params, ctx)
      }
      case 'query': {
        const sql = typeof params['sql'] === 'string' ? params['sql'] : ''
        const args = Array.isArray(params['params']) ? params['params'] as unknown[] : []
        const run = host.query
        if (run === undefined) return { error: 'this window has no store to read' }
        if (!isReadOnlySql(sql)) return { error: 'query runs ONE read-only SELECT; writes go through the undo stack' }
        return { rows: await run(sql, args) }
      }
      default:
        return { error: `unknown ui action: ${action}` }
    }
  } catch (e) {
    const handover = typeof e === 'object' && e !== null && (e as { handover?: unknown }).handover === true
    return { error: e instanceof Error ? e.message : String(e), ...(handover ? { handover: true } : {}) }
  }
}

/**
 * Thrown inside a workspace when a call would move the view of a PDF its
 * caller does not drive. The router asks the person, and tries again if
 * they hand the tab over.
 */
export class HandoverNeeded extends Error {
  readonly handover = true
  constructor(what: string) {
    super(what)
    this.name = 'HandoverNeeded'
  }
}
