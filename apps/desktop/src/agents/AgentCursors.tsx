/**
 * Each agent's cursor on the sheet, with what it is doing written beside it.
 *
 * Aaron, 2026-11-24: "different agents different colors, with colored
 * cursors with a tooltip by the cursor describing actions."
 *
 * An agent has no mouse. Its cursor is put where its latest call acted: the
 * last vertex of the area it drew, the middle of the box it looked at, the
 * point it traced from. A call about no place (a save, a list) leaves the
 * cursor where it was and changes the words. Before its first call with a
 * place, the label sits in the corner of the sheet.
 *
 * The layer never takes the pointer and holds nothing focusable: it is a
 * picture of what agents are doing, not something to click.
 *
 * The workspace's painter calls `sync()` on every paint, so the cursors stay
 * on their points while the person pans and zooms; React renders only when
 * the roster changes.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react'
import { samePath } from '../lightTabs.js'
import { roster, type Agent, type AgentPoint } from './roster.js'
import './agents.css'

export interface AgentCursorsHandle {
  /** Put every cursor back on its point, after the view moved. */
  sync: () => void
}

/** An agent quiet for this long has no cursor: the sheet is not a record of where it once was. */
export const CURSOR_LINGER_MS = 5 * 60_000

/** The agents to draw on `file`'s sheet `page`. */
export function cursorsFor(agents: readonly Agent[], file: string, page: number, now: number): Agent[] {
  return agents.filter((a) => {
    if (a.state === 'gone' || a.activity === null || a.activity.file === null) return false
    if (!samePath(a.activity.file, file)) return false
    if (a.activity.page !== null && a.activity.page !== page) return false
    return a.activity.busy || now - a.activity.at < CURSOR_LINGER_MS
  })
}

/** Docked labels start below the bar that says whose PDF this is, and stack by their own height. */
export const DOCK_TOP = 64
export const DOCK_STEP = 50

/**
 * Where a cursor goes, in the layer's own pixels. On the point when it is in
 * view; held at the nearest edge when the person has panned away from it, so
 * the label still says which way the agent is; docked in the corner when the
 * agent has acted nowhere in particular yet.
 */
export function cursorSpot(
  at: { x: number; y: number } | null, size: { width: number; height: number }, slot: number,
): { x: number; y: number; mode: 'on' | 'edge' | 'docked' } {
  if (at === null || size.width <= 0 || size.height <= 0) return { x: 14, y: DOCK_TOP + slot * DOCK_STEP, mode: 'docked' }
  const pad = 10
  const inside = at.x >= 0 && at.y >= 0 && at.x <= size.width && at.y <= size.height
  if (inside) return { x: at.x, y: at.y, mode: 'on' }
  return {
    x: Math.min(Math.max(at.x, pad), size.width - pad),
    y: Math.min(Math.max(at.y, pad), size.height - pad),
    mode: 'edge',
  }
}

export const AgentCursors = forwardRef<AgentCursorsHandle, {
  file: string
  /** The sheet showing, zero-based. */
  page: number
  /** A normalized point of the sheet showing, in the stage's pixels; null while no sheet is. Must be stable. */
  place: (p: AgentPoint) => { x: number; y: number } | null
}>(function AgentCursors({ file, page, place }, ref) {
  const agents = useSyncExternalStore(roster.subscribe, () => roster.get().agents, () => roster.get().agents)
  const layerRef = useRef<HTMLDivElement | null>(null)
  const nodes = useRef(new Map<string, HTMLDivElement>())
  const shown = cursorsFor(agents, file, page, Date.now())
  const shownRef = useRef(shown)
  shownRef.current = shown

  const position = useCallback((glide: boolean) => {
    const layer = layerRef.current
    if (layer === null) return
    const size = { width: layer.clientWidth, height: layer.clientHeight }
    let docked = 0
    for (const a of shownRef.current) {
      const el = nodes.current.get(a.id)
      if (el === undefined) continue
      const point = a.activity?.point ?? null
      const at = point === null ? null : place(point)
      const spot = cursorSpot(at, size, at === null ? docked : 0)
      if (spot.mode === 'docked') docked++
      // A glide is for the agent moving; the person's own pan must not smear it.
      el.style.transition = glide && el.dataset['mode'] === spot.mode ? '' : 'none'
      el.dataset['mode'] = spot.mode
      // The label flips to the left of a cursor near the right edge.
      const wide = (el.lastElementChild as HTMLElement | null)?.offsetWidth ?? 280
      const over = spot.x + 18 + wide + 6 - size.width
      const flip = over > 0 && spot.x - wide > 0
      el.dataset['flip'] = flip ? 'true' : 'false'
      el.style.setProperty('--shift', `${!flip && over > 0 && spot.mode === 'on' ? Math.round(over) : 0}px`)
      el.dataset['up'] = spot.y > size.height - 56 ? 'true' : 'false'
      el.style.transform = `translate(${Math.round(spot.x)}px, ${Math.round(spot.y)}px)`
    }
  }, [place])

  useImperativeHandle(ref, () => ({ sync: () => position(false) }), [position])
  // The roster changed: an agent acted somewhere new, so its cursor travels there.
  useLayoutEffect(() => { position(true) })
  // Linger runs out without any roster change: look again now and then.
  useEffect(() => {
    if (shown.length === 0) return
    const timer = setInterval(() => roster.tick(), 4000)
    return () => clearInterval(timer)
  }, [shown.length])

  if (shown.length === 0) return <div className="agentcursors" ref={layerRef} aria-hidden="true" />
  return (
    <div className="agentcursors" ref={layerRef} aria-hidden="true">
      {shown.map((a) => {
        const doing = a.activity!
        const quiet = a.state === 'idle' && !doing.busy
        return (
          <div
            key={a.id}
            className="agentcursor"
            data-agent={a.name}
            data-busy={doing.busy ? 'true' : 'false'}
            data-quiet={quiet ? 'true' : 'false'}
            style={{ '--agent': a.color.fill, '--agent-bright': a.color.bright, '--agent-on': a.color.on } as CSSProperties}
            ref={(el) => { if (el === null) nodes.current.delete(a.id); else nodes.current.set(a.id, el) }}
          >
            <svg className="agentcursor-arrow" width="24" height="27" viewBox="0 0 18 20">
              <path d="M2 1.5 L2 16.5 L6.2 12.6 L9.1 18.6 L11.9 17.3 L9 11.4 L14.6 11.2 Z" />
            </svg>
            <span className="agentcursor-label">
              <span className="agentcursor-name">{a.name}</span>
              <span className="agentcursor-doing">{a.state === 'waiting' ? 'Waiting for you' : quiet ? 'Idle' : doing.text}{doing.failed === true && a.state === 'working' ? ' · not done' : ''}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
})
