/**
 * What's new: a ContentDialog that opens by itself on the first launch after
 * an update, and on request from Settings › About or the prompt.
 *
 * After an update it lists every release since the one this copy last showed,
 * newest first, because people skip several releases between launches. Opened
 * by hand it lists the latest few. The notes are CHANGELOG.md's, bundled at
 * build time (changelog.ts says the shape a release entry takes).
 *
 * Like the bug report, it is a dialog because it is about the app rather than
 * the takeoff, and it is answered once ("Got it") and gone.
 */
import { Fragment, useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useReturnFocus } from '../returnFocus.js'
import { useFocusTrap } from '../shell/focusTrap.js'
import { Glyph, Sparkles, X } from '../shell/icons.js'
import { APP_VERSION } from '../update/updates.js'
import { friendlyDate, inlineRuns, recentReleases, unseenReleases, type Release } from './changelog.js'
import { RELEASES } from './changelogSource.js'
import { WHATS_NEW_EVENT } from './open.js'
import { browserSeenStorage, launchDecision, markSeen, type LaunchDecision } from './seen.js'
import './whatsnew.css'

/** How many releases the dialog shows when opened by hand. */
const RECENT_COUNT = 10

/*
 * Decided when this module loads, before anything in the window has written
 * its own keys: on a fresh install storage is still empty here, which is how
 * a first launch is told apart from an update.
 */
const LAUNCH: LaunchDecision = launchDecision(browserSeenStorage(), APP_VERSION)
/** The host remounts when the window moves between the start screen and a file; the launch notes show once. */
let launchHandled = false

type Shown = { kind: 'update'; releases: Release[]; since: string | null } | { kind: 'manual'; releases: Release[] }

/**
 * Mount once per window. `auto` is false where the window is not the person's
 * own launch (a second view on a project), so the notes show once.
 */
export function WhatsNewHost({ auto }: { auto: boolean }) {
  const [shown, setShown] = useState<Shown | null>(() => {
    if (!auto || launchHandled || !LAUNCH.show) return null
    const releases = unseenReleases(RELEASES, LAUNCH.since, APP_VERSION)
    return releases.length === 0 ? null : { kind: 'update', releases, since: LAUNCH.since }
  })

  useEffect(() => {
    // Seen as soon as it is decided, so a second window opened meanwhile does not show it again.
    if (!auto) return
    launchHandled = true
    markSeen(browserSeenStorage(), APP_VERSION)
  }, [auto])

  useEffect(() => {
    const open = () => setShown({ kind: 'manual', releases: recentReleases(RELEASES, APP_VERSION, RECENT_COUNT) })
    window.addEventListener(WHATS_NEW_EVENT, open)
    return () => window.removeEventListener(WHATS_NEW_EVENT, open)
  }, [])

  const close = useCallback(() => setShown(null), [])
  return shown === null ? null : <WhatsNewDialog shown={shown} onClose={close} />
}

function subtitle(shown: Shown): string {
  if (shown.kind === 'manual') return `You have version ${APP_VERSION}. These are the latest changes.`
  const n = shown.releases.length
  if (n === 1) return `REDBEAM updated to ${APP_VERSION}.`
  const since = shown.since === null ? '' : ` since ${shown.since}`
  return `REDBEAM updated to ${APP_VERSION}. Here is everything new in the ${n} releases${since}.`
}

function WhatsNewDialog({ shown, onClose }: { shown: Shown; onClose: () => void }) {
  const trap = useFocusTrap<HTMLDivElement>(true)
  useReturnFocus(true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault(); e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <div className="wn" role="presentation">
      <div className="wn-card" role="dialog" aria-modal="true" aria-labelledby="wn-title" aria-describedby="wn-sub" ref={trap}>
        <header className="wn-head">
          <span className="wn-mark" aria-hidden="true"><Glyph icon={Sparkles} role="inline" /></span>
          <div className="wn-headtext">
            <h2 id="wn-title">What’s new</h2>
            <p id="wn-sub">{subtitle(shown)}</p>
          </div>
          <button type="button" className="wn-x" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <Glyph icon={X} role="small" />
          </button>
        </header>

        <div className="wn-body" tabIndex={-1}>
          {shown.releases.length === 0 && <p className="wn-empty">There are no release notes in this copy.</p>}
          {shown.releases.map((r) => (
            <section key={r.version} className="wn-release" aria-label={`Version ${r.version}`}>
              <div className="wn-version">
                <span className="wn-vnum">{r.version}</span>
                {r.date !== '' && <span>{friendlyDate(r.date)}</span>}
              </div>
              <ReleaseBlocks release={r} />
            </section>
          ))}
        </div>

        <footer className="wn-actions">
          <button type="button" className="wn-btn primary" onClick={onClose} autoFocus>Got it</button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

/** A release's headlines, points and paragraphs, with consecutive points in one list. */
function ReleaseBlocks({ release }: { release: Release }) {
  const out: JSX.Element[] = []
  let items: JSX.Element[] = []
  const flush = () => {
    if (items.length > 0) out.push(<ul key={`ul${out.length}`}>{items}</ul>)
    items = []
  }
  release.blocks.forEach((b, i) => {
    if (b.kind === 'item') { items.push(<li key={i}><Inline text={b.text} /></li>); return }
    flush()
    out.push(b.kind === 'heading'
      ? <h3 key={i}><Inline text={b.text} /></h3>
      : <p key={i}><Inline text={b.text} /></p>)
  })
  flush()
  return <>{out}</>
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineRuns(text).map((r, i) => {
        let node: JSX.Element = <Fragment key={i}>{r.text}</Fragment>
        if (r.code) node = <code key={i}>{r.text}</code>
        if (r.em) node = <em key={i}>{node}</em>
        if (r.strong) node = <strong key={i}>{node}</strong>
        return node
      })}
    </>
  )
}
