/**
 * The update offer, as a chip beside Settings (Aaron, 2026-11-26).
 *
 * It used to be a card floating over the top of the drawing, where it sat on
 * top of whatever else lived there (the agent banner, the page). An update is
 * not urgent enough to cover the work, so it now waits at the bottom of the
 * sidebar, next to Settings, in the accent colour, and on the start screen
 * beside the version line. Settings keeps the full row with the long wording.
 *
 * Pressing it does what the row's button did: download and install, then
 * restart. Nothing here takes focus or opens by itself.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Download, Glyph, Refresh, TriangleAlert } from '../shell/icons.js'
import { isPortableCopy, performUpdateAction, useUpdateState } from './session.js'
import { type UpdateState } from './updates.js'
import './updateChip.css'

export interface UpdateChipView {
  /** What the chip says. */
  label: string
  /** The longer sentence, for the tooltip and screen readers. */
  detail: string
  tone: 'go' | 'busy' | 'restart' | 'failed'
  /** What pressing it does; null while a download runs. */
  action: 'install' | 'restart' | 'check' | null
  /** Download progress, 0 to 100, when known. */
  percent: number | null
}

/**
 * What the chip shows for a state, or null for no chip.
 *
 * Only states with something to do get one. A check that failed on its own
 * stays in Settings; a download that failed shows here, because the person
 * pressed the chip and would otherwise see it vanish with no word.
 */
export function updateChipView(state: UpdateState, portable = false, installFailed = false): UpdateChipView | null {
  switch (state.kind) {
    case 'available':
      return {
        label: 'Ready to update',
        detail: portable
          ? `Version ${state.version} is available. This is the portable copy, so this downloads the new zip.`
          : `Version ${state.version} is available. Click to download and install it.`,
        tone: 'go',
        action: 'install',
        percent: null,
      }
    case 'downloading': {
      const percent = state.percent === null ? null : Math.max(0, Math.min(100, state.percent))
      return {
        label: percent === null ? 'Updating…' : `Updating ${Math.round(percent)}%`,
        detail: 'Downloading the update. You can keep working.',
        tone: 'busy',
        action: null,
        percent,
      }
    }
    case 'ready':
      return {
        label: 'Restart to update',
        detail: `Version ${state.version} is installed and starts when you restart REDBEAM. Click to restart now.`,
        tone: 'restart',
        action: 'restart',
        percent: null,
      }
    case 'failed':
      if (!installFailed) return null
      return {
        label: 'Update failed',
        detail: `The update could not be installed: ${state.message}. Click to look again.`,
        tone: 'failed',
        action: 'check',
        percent: null,
      }
    default:
      return null
  }
}

const ICON = { go: Download, busy: Download, restart: Refresh, failed: TriangleAlert } as const

/** The chip itself, drawn from a view. On the collapsed rail CSS hides the label. */
export function UpdateChipButton({ view, onRun }: { view: UpdateChipView; onRun: () => void }) {
  const style = view.percent === null ? undefined : { '--chip-progress': `${view.percent}%` } as CSSProperties
  return (
    <button
      type="button"
      className={`updatechip ${view.tone}`}
      title={view.detail}
      aria-label={`${view.label}. ${view.detail}`}
      aria-busy={view.tone === 'busy' ? true : undefined}
      disabled={view.action === null}
      // A mouse press must not move focus off the drawing (or out of a field).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
      style={style}
      data-testid="update-chip"
    >
      <Glyph icon={ICON[view.tone]} role="row" />
      <span className="updatechiplabel">{view.label}</span>
      {view.tone === 'busy' && <span className="updatechipbar" aria-hidden />}
    </button>
  )
}

export function UpdateChip({ desktop }: { desktop: boolean }) {
  const state = useUpdateState(desktop)
  const prev = useRef<UpdateState['kind']>(state.kind)
  const [installFailed, setInstallFailed] = useState(false)
  useEffect(() => {
    if (state.kind === 'failed') {
      if (prev.current === 'downloading') setInstallFailed(true)
    } else if (state.kind !== 'checking') {
      setInstallFailed(false)
    }
    prev.current = state.kind
  }, [state.kind])

  if (!desktop) return null
  const view = updateChipView(state, isPortableCopy(), installFailed)
  if (view === null) return null
  return (
    <UpdateChipButton
      view={view}
      onRun={() => { if (view.action !== null) void performUpdateAction(view.action) }}
    />
  )
}
