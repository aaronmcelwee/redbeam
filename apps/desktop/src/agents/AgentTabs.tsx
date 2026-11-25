/**
 * Agents in the tab strip.
 *
 * Aaron, 2026-11-24: "say 10 tabs open, human working in 2-3 tabs, then
 * collapsed 'tab groups' showing different agents with their own
 * 'environments' ... It should also name what session is operating that
 * group of files ... collapsed out of the way of the user until they want to
 * drill into it." And, of a first design that hid a session's files in a
 * flyout: "It takes up a lot of space and doesn't show a lot of content. I
 * also want to be able to expand the group and work alongside the agent."
 *
 * So each AI session is a tab group, as a browser has them. Collapsed, it is
 * one pill in the session's colour: its app, the job its chat named, and how
 * many PDFs it has. Click the pill and its PDFs unfold beside it as real
 * tabs, underlined in its colour, to click into and work in beside the
 * agent. Click again and they fold away.
 *
 * A session that needs a PDF the person already has open does not get a
 * second tab of it: it works in theirs as a guest, and their tab carries a
 * dot in the session's colour (`tabMarks`).
 *
 * A finished session leaves no group. What it wrote is in the person's own
 * tabs; what it only read is closed and listed under one quiet "Finished"
 * pill, to reopen or dismiss.
 *
 * WinUI primitives, and nothing invented beside them: TabView tabs, a
 * MenuFlyout on the shell's own `.titlemenu`, InfoBadge (the count and the
 * attention mark), InfoBar (the bar over the sheet, AgentBar).
 */
import { Fragment, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { FileText, Glyph, X } from '../shell/icons.js'
import { useDismiss } from '../shell/dismiss.js'
import { samePath } from '../lightTabs.js'
import { handovers, type HandoverAsk } from './handover.js'
import { roster, type Agent } from './roster.js'
import './agents.css'

export interface AgentTabItem { file: string; name: string; owner?: string; handed?: { by: string; color: string } }

/** The roster, re-rendering only what reads it. */
export function useAgents(): readonly Agent[] {
  return useSyncExternalStore(roster.subscribe, () => roster.get().agents, () => roster.get().agents)
}

/** The handover questions waiting for the person. */
export function useHandoverAsks(): readonly HandoverAsk[] {
  return useSyncExternalStore(handovers.subscribe, handovers.get, handovers.get)
}

export interface AgentGroup {
  agent: Agent
  tabs: AgentTabItem[]
  /** The person's PDFs this agent has asked to work in. */
  asks: AgentTabItem[]
}

/**
 * Each live session with the tabs it drives, in the order the sessions
 * arrived. One with no tab, nothing asked, no PDF of the person's it is a
 * guest in and nothing happening is left out: a pill is for something the
 * person can look at or answer. Finished sessions are not groups
 * (`finishedSessions`).
 */
export function agentGroups(agents: readonly Agent[], tabs: readonly AgentTabItem[], asks: readonly HandoverAsk[]): AgentGroup[] {
  const out: AgentGroup[] = []
  for (const agent of agents) {
    if (agent.state === 'gone') continue
    const own = tabs.filter((t) => t.owner === agent.id)
    const asked = asks
      .filter((a) => a.agentId === agent.id)
      .map((a) => tabs.find((t) => samePath(t.file, a.file)))
      .filter((t): t is AgentTabItem => t !== undefined)
    const guest = agent.guestIn.some((f) => tabs.some((t) => samePath(t.file, f)))
    if (own.length === 0 && asked.length === 0 && !guest && agent.state === 'idle') continue
    out.push({ agent, tabs: own, asks: asked })
  }
  return out
}

/** The sessions that have finished and not been dismissed, newest first. */
export function finishedSessions(agents: readonly Agent[]): Agent[] {
  return agents.filter((a) => a.state === 'gone' && a.ended !== null).sort((a, b) => b.ended!.at - a.ended!.at)
}

export function useAgentTabGroups(tabs: readonly AgentTabItem[]): AgentGroup[] {
  const agents = useAgents()
  const asks = useHandoverAsks()
  return useMemo(() => agentGroups(agents, tabs, asks), [agents, tabs, asks])
}

const plainName = (name: string): string => name.replace(/\.pdf$/i, '')
const baseName = (file: string): string => plainName(file.replace(/\\/g, '/').replace(/^.*\//, ''))

/** A time of day the way the person's Windows writes it: "5:12 PM". */
export function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * How a session stands, in a line. The action while a call runs or has just
 * run; what it is waiting on; else when it was last heard from. Never an
 * action that is no longer happening.
 */
export function agentStatus(agent: Agent): string {
  if (agent.state === 'gone') return endedLine(agent)
  if (agent.state === 'waiting') return agent.waitingFor === null ? 'Waiting for you' : `Waiting for you: ${agent.waitingFor}`
  if (agent.state === 'working' && agent.activity !== null) return agent.activity.text
  return `Quiet since ${clock(agent.seenAt)}`
}

/** "Finished 5:12 PM", and why when the session did not end itself. */
export function endedLine(agent: Agent): string {
  const end = agent.ended
  if (end === null) return 'Finished'
  const when = clock(end.at)
  if (end.by === 'person') return `Ended by you ${when}`
  if (end.by === 'app') return `Finished ${when} · its app closed`
  if (end.by === 'lost') return `Finished ${when} · its app stopped answering`
  return `Finished ${when}`
}

/** An agent's colours, for everything drawn under this element (agents.css). */
export const tint = (agent: Agent): CSSProperties => ({
  '--agent': agent.color.fill, '--agent-bright': agent.color.bright, '--agent-on': agent.color.on,
} as CSSProperties)

/** The sessions working in `file` as guests of the person. */
export function guestsOf(agents: readonly Agent[], file: string): Agent[] {
  return agents.filter((a) => a.state !== 'gone' && a.guestIn.some((f) => samePath(f, file)))
}

/**
 * The dots one of the person's own tabs carries: one per session working in
 * it as a guest, and one for a session that handed it back, until opened.
 */
export function tabMarks(tab: AgentTabItem, agents: readonly Agent[]): { color: string; title: string }[] {
  const marks = guestsOf(agents, tab.file).map((a) => ({
    color: a.color.bright,
    title: `${a.name} is also working in this PDF · ${agentStatus(a)}`,
  }))
  if (tab.handed !== undefined) marks.push({ color: tab.handed.color, title: `New from ${tab.handed.by}, which has finished` })
  return marks
}

// ------------------------------------------------------------- the strip --

type Flyout = { kind: 'session'; agentId: string; x: number; y: number } | { kind: 'finished'; x: number; y: number }

/**
 * The agents' side of the tab strip. Renders nothing while no session is
 * about and none has finished, so a window nobody is driving looks exactly
 * as it always has.
 */
export function AgentStrip({
  tabs, activeFile, onSelect, onClose, onHandOver, onTakeOver, onEndSession, onDismissSession, onReopenFile,
}: {
  tabs: readonly AgentTabItem[]
  /** The PDF showing, to mark its group and its tab. */
  activeFile: string | null
  onSelect: (file: string) => void
  onClose: (file: string) => void
  onHandOver?: (file: string, agentId: string, yes: boolean) => void
  onTakeOver?: (file: string) => void
  onEndSession?: (agentId: string) => void
  onDismissSession?: (agentId: string) => void
  onReopenFile?: (file: string) => void
}) {
  const agents = useAgents()
  const groups = useAgentTabGroups(tabs)
  const finished = useMemo(() => finishedSessions(agents), [agents])
  const [open, setOpen] = useState<Flyout | null>(null)
  const menuRef = useDismiss(open !== null, () => setOpen(null))
  if (groups.length === 0 && finished.length === 0) return null
  const shown = open?.kind === 'session' ? groups.find((g) => g.agent.id === open.agentId) ?? null : null
  const place = (el: HTMLElement, width: number) => {
    const r = el.getBoundingClientRect()
    return { x: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), y: r.bottom }
  }

  return (
    <div
      className="agentstrip" role="group" aria-label="AI sessions" data-many={groups.length > 3 ? 'true' : 'false'}
      style={{ '--person-tabs': tabs.filter((t) => t.owner === undefined).length } as CSSProperties}
    >
      {open?.kind === 'session' && shown !== null && (
        <div
          className="titlemenu tabctx agentflyout" role="menu" aria-label={shown.agent.name} ref={menuRef}
          style={{ left: open.x, top: open.y, ...tint(shown.agent) }}
        >
          <div className="agentflyout-head">
            <span className="agentdot" aria-hidden="true" data-state={shown.agent.state} />
            <div className="grow">
              <div className="agentflyout-name">{shown.agent.name}</div>
              <div className="agentflyout-doing">{operating(shown)}</div>
            </div>
          </div>
          {onHandOver !== undefined && shown.asks.map((t) => (
            <div key={`ask:${t.file}`} className="agentflyout-ask" role="group" aria-label={`${shown.agent.name} asks to work in ${plainName(t.name)}`}>
              <span className="grow">Wants to turn pages and zoom in your PDF <strong>{plainName(t.name)}</strong>.</span>
              <button type="button" className="primarybtn small" onClick={() => { setOpen(null); onHandOver(t.file, shown.agent.id, true) }}>Let it work there</button>
              <button type="button" className="ghostbtn small" onClick={() => { setOpen(null); onHandOver(t.file, shown.agent.id, false) }}>Not now</button>
            </div>
          ))}
          <div className="menusep" role="separator" />
          {shown.tabs.length > 0 && (
            <button className="menuitem" role="menuitem" onClick={() => { setOpen(null); roster.setCollapsed(shown.agent.id, !shown.agent.collapsed) }}>
              <span className="grow">{shown.agent.collapsed ? 'Show its tabs' : 'Fold its tabs away'}</span>
            </button>
          )}
          {onTakeOver !== undefined && shown.tabs.filter((t) => activeFile !== null && samePath(t.file, activeFile)).map((t) => (
            <button key={`take:${t.file}`} className="menuitem" role="menuitem" onClick={() => { setOpen(null); onTakeOver(t.file) }}>
              <span className="grow">Make {plainName(t.name)} my tab</span>
            </button>
          ))}
          {onEndSession !== undefined && (
            <button className="menuitem" role="menuitem" onClick={() => { setOpen(null); onEndSession(shown.agent.id) }}>
              <Glyph icon={X} role="row" />
              <span className="grow">End this session</span>
            </button>
          )}
        </div>
      )}
      {open?.kind === 'finished' && finished.length > 0 && (
        <div className="titlemenu tabctx agentflyout agentfinished" role="menu" aria-label="Finished AI sessions" ref={menuRef} style={{ left: open.x, top: open.y }}>
          {finished.map((a) => (
            <section key={a.id} className="agentfinished-one" style={tint(a)}>
              <div className="agentflyout-head">
                <span className="agentdot" aria-hidden="true" data-state="gone" />
                <div className="grow">
                  <div className="agentflyout-name">{a.name}</div>
                  <div className="agentflyout-doing">{endedLine(a)}</div>
                  {a.ended!.summary !== null && <div className="agentfinished-summary">{a.ended!.summary}</div>}
                </div>
                {onDismissSession !== undefined && (
                  <button className="tabclose" aria-label={`Dismiss ${a.name}`} onClick={() => onDismissSession(a.id)}>
                    <Glyph icon={X} role="small" />
                  </button>
                )}
              </div>
              {a.ended!.handedBack.length > 0 && <div className="agentfinished-label">Now in your tabs</div>}
              {a.ended!.handedBack.map((f) => (
                <button key={`back:${f}`} className="menuitem" role="menuitem" title={f} onClick={() => { setOpen(null); onSelect(f) }}>
                  <Glyph icon={FileText} role="row" />
                  <span className="grow">{baseName(f)}</span>
                </button>
              ))}
              {a.ended!.closed.length > 0 && <div className="agentfinished-label">Only read, so closed. Pick one to reopen it.</div>}
              {a.ended!.closed.map((f) => (
                <button key={`closed:${f}`} className="menuitem" role="menuitem" title={f} disabled={onReopenFile === undefined} onClick={() => { setOpen(null); onReopenFile?.(f) }}>
                  <Glyph icon={FileText} role="row" />
                  <span className="grow">{baseName(f)}</span>
                </button>
              ))}
              {a.ended!.handedBack.length === 0 && a.ended!.closed.length === 0 && <div className="agentflyout-none">It had no PDFs of its own open.</div>}
            </section>
          ))}
          {onDismissSession !== undefined && finished.length > 1 && (
            <>
              <div className="menusep" role="separator" />
              <button className="menuitem" role="menuitem" onClick={() => { setOpen(null); for (const a of finished) onDismissSession(a.id) }}>
                <span className="grow">Dismiss all</span>
              </button>
            </>
          )}
        </div>
      )}
      {groups.map((group) => {
        const { agent, tabs: own, asks } = group
        const showingOne = activeFile !== null && own.some((t) => samePath(t.file, activeFile))
        // The group the person is inside is never folded shut around them.
        const unfolded = own.length > 0 && (!agent.collapsed || showingOne)
        const menuOpen = open?.kind === 'session' && open.agentId === agent.id
        const openMenu = (el: HTMLElement) => setOpen({ kind: 'session', agentId: agent.id, ...place(el, 360) })
        return (
          <Fragment key={agent.id}>
            <button
              type="button"
              className="agentpill"
              data-agent={agent.name}
              data-state={agent.state}
              data-unfolded={unfolded ? 'true' : 'false'}
              data-asking={asks.length > 0 ? 'true' : 'false'}
              aria-expanded={unfolded}
              aria-haspopup="menu"
              title={`${agent.name} ${operating(group)}\nClick to ${unfolded ? 'fold its tabs away' : 'show its tabs'}. Right-click for more.`}
              style={tint(agent)}
              onClick={(e) => {
                if (menuOpen) { setOpen(null); return }
                // Nothing to unfold, or something to answer: the menu is what a click is for.
                if (own.length === 0 || asks.length > 0) { openMenu(e.currentTarget); return }
                roster.setCollapsed(agent.id, unfolded)
              }}
              onContextMenu={(e) => { e.preventDefault(); openMenu(e.currentTarget) }}
            >
              <span className="agentdot" aria-hidden="true" data-state={agent.state} />
              <span className="agentpill-name"><strong>{agent.app}</strong>{agent.task !== null ? ` · ${agent.task}` : ''}</span>
              {agent.state === 'waiting' && <span className="agentpill-state">Waiting for you</span>}
              {asks.length > 0
                ? <span className="agentcount attention" aria-label="Asking you something">!</span>
                : !unfolded && own.length > 0 && <span className="agentcount" aria-label={`${own.length} PDF${own.length === 1 ? '' : 's'}`}>{own.length}</span>}
            </button>
            {unfolded && own.map((t) => {
              const active = activeFile !== null && samePath(t.file, activeFile)
              return (
                <div
                  key={t.file}
                  role="tab"
                  aria-selected={active}
                  className={`tab agenttab${active ? ' active' : ''}`}
                  data-agent={agent.name}
                  title={`${t.file}\n${agent.name} is operating this PDF`}
                  style={tint(agent)}
                  onClick={() => onSelect(t.file)}
                >
                  <Glyph icon={FileText} role="inline" />
                  <span className="tabname">{plainName(t.name)}</span>
                  <button className="tabclose" aria-label={`Close ${plainName(t.name)}`} onClick={(e) => { e.stopPropagation(); onClose(t.file) }}>
                    <Glyph icon={X} role="small" />
                  </button>
                </div>
              )
            })}
          </Fragment>
        )
      })}
      {finished.length > 0 && (
        <button
          type="button"
          className="agentpill finished"
          aria-haspopup="menu"
          aria-expanded={open?.kind === 'finished'}
          title="AI sessions that have finished: what they left you, and what they closed"
          onClick={(e) => setOpen(open?.kind === 'finished' ? null : { kind: 'finished', ...place(e.currentTarget, 380) })}
        >
          <span className="agentpill-name">Finished</span>
          <span className="agentcount">{finished.length}</span>
        </button>
      )}
    </div>
  )
}

/** "is operating these 3 PDFs · Searching for “CL-105”": the line under a session's name. */
export function operating(group: AgentGroup): string {
  const n = group.tabs.length
  const files = n === 0 ? 'has no PDFs of its own open' : `is operating ${n === 1 ? 'this PDF' : `these ${n} PDFs`}`
  return `${files} · ${agentStatus(group.agent)}`
}

// ------------------------------------------------------- the start page --

/**
 * The start page while agents are at work: the person has no PDF of their
 * own open, so there is no tab strip to carry the chips. A card lists each
 * agent and its PDFs, to look in on.
 */
export function AgentsOnStart({
  tabs, onSelect, onClose,
}: {
  tabs: readonly AgentTabItem[]
  onSelect: (file: string) => void
  onClose: (file: string) => void
}) {
  const groups = useAgentTabGroups(tabs).filter((g) => g.tabs.length > 0)
  if (groups.length === 0) return null
  return (
    <aside className="agentsonstart" aria-label="AI agents at work">
      <h2>AI agents at work</h2>
      {groups.map(({ agent, tabs: own }) => (
        <section key={agent.id} className="agentsonstart-agent" data-state={agent.state} style={tint(agent)}>
          <header>
            <span className="agentdot" aria-hidden="true" data-state={agent.state} />
            <span className="agentname">{agent.app}</span>
            {agent.task !== null && <span className="agenttask">{agent.task}</span>}
            <span className="agentdoing">{agentStatus(agent)}</span>
          </header>
          <ul>
            {own.map((t) => (
              <li key={t.file}>
                <button type="button" className="agentsonstart-open" title={t.file} onClick={() => onSelect(t.file)}>
                  <Glyph icon={FileText} role="inline" />
                  <span className="tabname">{plainName(t.name)}</span>
                </button>
                <button type="button" className="tabclose" aria-label={`Close ${plainName(t.name)}`} onClick={() => onClose(t.file)}>
                  <Glyph icon={X} role="small" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  )
}

// ------------------------------------------------------------ on the sheet --

/**
 * Over the sheet of an agent's own PDF while the person looks in on it, as a
 * WinUI InfoBar: "Claude · Nokia takeoff is operating this PDF. The view
 * follows it." with the way to take the tab.
 *
 * What a session asks the person is NOT shown here. It was, on whichever tab
 * they were in, and on the SLS four such bars stacked over the drawing Aaron
 * was working on (2026-11-24). His rule is that nothing an agent does opens
 * over his work, so a question lives on the session's pill ("!") and is
 * answered from the pill's menu when he chooses to look.
 */
export function AgentBar({
  file, owner, onTakeOver,
}: {
  file: string
  /** The agent that drives this tab, if one does. */
  owner: string | undefined
  onTakeOver?: (file: string) => void
}) {
  const agents = useAgents()
  const driver = owner === undefined ? undefined : agents.find((a) => a.id === owner)
  if (driver === undefined) return null
  return (
    <div className="agentbar">
      {driver !== undefined && (
        <div className="agentinfobar" role="status" style={tint(driver)}>
          <span className="agentdot" aria-hidden="true" data-state={driver.state} />
          <span className="agentinfobar-text">
            <strong>{driver.name}</strong>
            {driver.state === 'gone' ? ' worked in this PDF and has finished.'
              : driver.state === 'waiting' ? ' is operating this PDF and is waiting for you. Answer it in its chat.'
                : ' is operating this PDF. The view follows it.'}
          </span>
          {onTakeOver !== undefined && (
            <button type="button" className="ghostbtn small" onClick={() => onTakeOver(file)}>Make this tab mine</button>
          )}
        </div>
      )}
    </div>
  )
}
