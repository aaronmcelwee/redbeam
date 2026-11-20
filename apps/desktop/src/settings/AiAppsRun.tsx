/**
 * Settings › Claude and ChatGPT (Aaron, 2026-11-20: "one click install on
 * Claude or ChatGPT, so they can drive REDBEAM").
 *
 * A run of three rows in the settings' own shape: the switch that lets an AI
 * app use REDBEAM at all, then one row per app with its install button. An
 * install also turns the switch on, since an installed server that refuses
 * every call is not what the click asked for. Removing an app leaves the
 * switch alone; the switch is the one place that says yes or no.
 *
 * The status is read again when the window regains focus, so installing the
 * Claude app in another window and coming back shows the new answer.
 */
import { useEffect, useState } from 'react'
import {
  AI_UNSUPPORTED, aiInstall, aiRemove, aiSetEnabled, aiStatus,
  type AiClientId, type AiClientStatus, type AiStatus,
} from '../tauri/aiApps.js'

const NAME: Record<AiClientId, string> = { claude: 'Claude', chatgpt: 'ChatGPT' }

/** The words under each app's name. Exported for the tests. */
export function clientNote(c: AiClientStatus, enabled: boolean): string {
  if (c.id === 'claude') {
    if (c.installed) {
      return enabled
        ? 'Added to the Claude desktop app. Quit Claude from the tray and reopen it if REDBEAM is not in its tools yet.'
        : 'Added to Claude, but Claude cannot use REDBEAM until the switch above is on.'
    }
    return c.detected
      ? 'Adds REDBEAM to the Claude desktop app, and to Claude Code if you use it. Then restart Claude.'
      : 'Claude was not found on this computer. Install the Claude desktop app first, or add it now and Claude picks it up when installed.'
  }
  if (c.installed) {
    return enabled
      ? 'Added to the ChatGPT desktop app (Settings › MCP servers, shared with Codex). Restart ChatGPT if it is not listed yet. ChatGPT on the web cannot reach apps on your computer.'
      : 'Added to ChatGPT, but ChatGPT cannot use REDBEAM until the switch above is on.'
  }
  return c.detected
    ? 'Adds REDBEAM to the ChatGPT desktop app and Codex. ChatGPT on the web cannot reach apps on your computer, so use the desktop app.'
    : 'The ChatGPT desktop app was not found. Adding still works: it is picked up when the app is installed. ChatGPT on the web cannot reach apps on your computer.'
}

export function AiAppsRun() {
  const [status, setStatus] = useState<AiStatus>(AI_UNSUPPORTED)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const read = () => { void aiStatus().then((s) => { if (live) setStatus(s) }) }
    read()
    window.addEventListener('focus', read)
    return () => { live = false; window.removeEventListener('focus', read) }
  }, [])

  if (!status.supported) return null

  const run = (work: () => Promise<AiStatus>) => {
    setBusy(true)
    setError(null)
    void work()
      .then(setStatus)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false))
  }

  const on = status.enabled
  return (
    <section className="prefs-run" aria-labelledby="prefs-run-ai">
      <h3 className="prefs-runtitle" id="prefs-run-ai">Claude and ChatGPT</h3>
      <div className="prefs-group">
        <div className="prefs-row">
          <label htmlFor="ai.enabled" className="prefs-rowtext">
            <span className="prefs-label">Let AI apps use REDBEAM</span>
            <span className="prefs-desc">
              {error ?? 'They can open PDFs, read quantities and make takeoffs in the window you see. Their changes go on the undo stack like yours.'}
            </span>
          </label>
          <span className="prefs-ctl">
            <span className="prefs-onoff" aria-hidden="true">{on ? 'On' : 'Off'}</span>
            <button
              id="ai.enabled"
              type="button"
              role="switch"
              className={`prefs-sw${on ? ' on' : ''}`}
              aria-checked={on}
              aria-label="Let AI apps use REDBEAM"
              disabled={busy}
              onClick={() => run(() => aiSetEnabled(!on))}
            ><span /></button>
          </span>
        </div>
        {status.clients.map((c) => (
          <div key={c.id} className="prefs-card">
            <div className="prefs-cardtext">
              <div className="prefs-cardtitle">{NAME[c.id]}</div>
              <div className="prefs-cardnote" title={c.files.join('\n')}>{clientNote(c, on)}</div>
            </div>
            {c.installed ? (
              <button className="act" disabled={busy} onClick={() => run(() => aiRemove(c.id))}>Remove</button>
            ) : (
              <button className="act" disabled={busy} onClick={() => run(() => aiInstall(c.id))}>
                Add to {NAME[c.id]}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
