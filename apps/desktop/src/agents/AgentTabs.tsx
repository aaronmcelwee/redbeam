/**
 * Agents in the tab strip.
 *
 * Aaron, 2026-11-24: "say 10 tabs open, human working in 2-3 tabs, then
 * collapsed 'tab groups' showing different agents with their own
 * 'environments' ... It should also name what session is operating that
 * group of files ... collapsed out of the way of the user until they want to
 * drill into it. Keep everything aligned with WinUI 3 design principles.
 * Don't try to design something new if a primitive already exists."
 *
 * The person's tabs keep the strip (shell/Shell.tsx DocumentTabStrip). To
 * their right, each AI session is one drop-down button in its colour: the
 * app, the job the chat said it is doing, and a count of its PDFs. Its
 * flyout names the session, says what it is doing now, and lists its PDFs
 * to look in on. The person looks in on the agent; the agent's work does
 * not come to them.
 *
 * WinUI primitives used, and nothing invented beside them: DropDownButton
 * and MenuFlyout (the chip and its list, on the shell's own `.titlemenu`),
 * InfoBadge (the count, and the attention mark when a session asks
 * something), InfoBar (the bar over the sheet, AgentBar), and the list rows
 * and buttons the shell already has.
 */
import { useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { ChevronDown, FileText, Glyph, X } from '../shell/icons.js'
import { useDismiss } from '../shell/dismiss.js'
import { samePath } from '../lightTabs.js'
import { handovers, type HandoverAsk } from './handover.js'
import { roster, type Agent } from './roster.js'
import './agents.css'

export interface AgentTabItem { file: string; name: string; owner?: string }

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
 * Each agent with the tabs it drives, in the order the agents arrived. An
 * agent with no tab and nothing asked is left out once it is gone or idle:
 * a chip is for something the person can look at or answer.
 */
export function agentGroups(agents: readonly Agent[], tabs: readonly AgentTabItem[], asks: readonly HandoverAsk[]): AgentGroup[] {
  const out: AgentGroup[] = []
  for (const agent of agents) {
    const own = tabs.filter((t) => t.owner === agent.id)
    const asked = asks
      .filter((a) => a.agentId === agent.id)
      .map((a) => tabs.find((t) => samePath(t.file, a.file)))
      .filter((t): t is AgentTabItem => t !== undefined)
    if (own.length === 0 && asked.length === 0 && agent.state !== 'working') continue
    out.push({ agent, tabs: own, asks: asked })
  }
  return out
}

export function useAgentTabGroups(tabs: readonly AgentTabItem[]): AgentGroup[] {
  const agents = useAgents()
  const asks = useHandoverAsks()
  return useMemo(() => agentGroups(agents, tabs, asks), [agents, tabs, asks])
}

const plainName = (name: string): string => name.replace(/\.pdf$/i, '')

/** What an agent is doing, for its chip: the action while it works, else how it stands. */
export function agentStatus(agent: Agent): string {
  if (agent.state === 'gone') return 'Finished'
  if (agent.state === 'working' && agent.activity !== null) return agent.activity.text
  return 'Idle'
}

/** An agent's colours, for everything drawn under this element (agents.css). */
export const tint = (agent: Agent): CSSProperties => ({
  '--agent': agent.color.fill, '--agent-bright': agent.color.bright, '--agent-on': agent.color.on,
} as CSSProperties)

// ------------------------------------------------------------- the strip --

/**
 * The agents' side of the tab strip. Renders nothing while no agent is
 * about, so a window nobody is driving looks exactly as it always has.
 *
 * Each session is ONE control, whatever it has open: a drop-down button
 * (WinUI DropDownButton) carrying its dot, its name and a count (InfoBadge).
 * Its PDFs are not laid out along the strip, where they would push the
 * person's own tabs into the overflow menu; they are in the flyout the button
 * opens (MenuFlyout), under a line saying who is operating them and what it
 * is doing now. Picking one shows it. That is the whole of "collapsed until
 * you want to drill in": one button per session, one click to its files.
 */
export function AgentStrip({
  tabs, activeFile, onSelect, onClose, onHandOver, onTakeOver,
}: {
  tabs: readonly AgentTabItem[]
  /** The PDF showing, to mark its group and its row. */
  activeFile: string | null
  onSelect: (file: string) => void
  onClose: (file: string) => void
  onHandOver?: (file: string, agentId: string, yes: boolean) => void
  onTakeOver?: (file: string) => void
}) {
  const groups = useAgentTabGroups(tabs)
  const [open, setOpen] = useState<{ agentId: string; x: number; y: number } | null>(null)
  const menuRef = useDismiss(open !== null, () => setOpen(null))
  if (groups.length === 0) return null
  const shown = open === null ? null : groups.find((g) => g.agent.id === open.agentId) ?? null

  return (
    <div className="agentstrip" role="group" aria-label="AI sessions" data-many={groups.length > 3 ? 'true' : 'false'}>
      {open !== null && shown !== null && (
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
          {shown.tabs.map((t) => {
            const active = activeFile !== null && samePath(t.file, activeFile)
            return (
              <div key={t.file} className={`tabmenurow agentfile${active ? ' active' : ''}`}>
                <button
                  className="grow" role="menuitemradio" aria-checked={active} title={t.file}
                  onClick={() => { setOpen(null); onSelect(t.file) }}
                >
                  <Glyph icon={FileText} role="row" />
                  <span className="tabname">{plainName(t.name)}</span>
                </button>
                <button className="tabclose" aria-label={`Close ${plainName(t.name)}`} onClick={() => onClose(t.file)}>
                  <Glyph icon={X} role="small" />
                </button>
              </div>
            )
          })}
          {shown.tabs.length === 0 && <div className="agentflyout-none">No PDFs of its own open.</div>}
          {(shown.tabs.length > 1 || (onTakeOver !== undefined && shown.tabs.some((t) => activeFile !== null && samePath(t.file, activeFile)))) && <div className="menusep" role="separator" />}
          {onTakeOver !== undefined && shown.tabs.filter((t) => activeFile !== null && samePath(t.file, activeFile)).map((t) => (
            <button key={`take:${t.file}`} className="menuitem" role="menuitem" onClick={() => { setOpen(null); onTakeOver(t.file) }}>
              <span className="grow">Make {plainName(t.name)} my tab</span>
            </button>
          ))}
          {shown.tabs.length > 1 && (
            <button className="menuitem" role="menuitem" onClick={() => { setOpen(null); for (const t of shown.tabs) onClose(t.file) }}>
              <Glyph icon={X} role="row" />
              <span className="grow">Close its {shown.tabs.length} PDFs</span>
            </button>
          )}
        </div>
      )}
      {groups.map((group) => {
        const { agent, tabs: own, asks } = group
        const showingOne = activeFile !== null && own.some((t) => samePath(t.file, activeFile))
        const expanded = open?.agentId === agent.id
        return (
          <button
            key={agent.id}
            type="button"
            className="agentchip"
            data-state={agent.state}
            data-showing={showingOne ? 'true' : 'false'}
            data-asking={asks.length > 0 ? 'true' : 'false'}
            aria-haspopup="menu"
            aria-expanded={expanded}
            title={`${agent.name}: ${operating(group)}`}
            style={tint(agent)}
            onClick={(e) => {
              if (expanded) { setOpen(null); return }
              const r = e.currentTarget.getBoundingClientRect()
              setOpen({ agentId: agent.id, x: Math.max(8, Math.min(r.left, window.innerWidth - 368)), y: r.bottom })
            }}
          >
            <span className="agentdot" aria-hidden="true" data-state={agent.state} />
            <span className="agentname">{agent.app}</span>
            {agent.task !== null && <span className="agenttask">{agent.task}</span>}
            {asks.length > 0
              ? <span className="agentcount attention" aria-label="Asking you something">!</span>
              : own.length > 0 && <span className="agentcount" aria-label={`${own.length} PDF${own.length === 1 ? '' : 's'}`}>{own.length}</span>}
            <Glyph icon={ChevronDown} role="small" />
          </button>
        )
      })}
    </div>
  )
}

/** "is operating 3 PDFs · Searching for “CL-105”": the line under a session's name. */
export function operating(group: AgentGroup): string {
  const n = group.tabs.length
  const files = n === 0 ? 'has no PDFs of its own open' : `${group.agent.state === 'gone' ? 'worked in' : 'is operating'} ${n === 1 ? 'this PDF' : `these ${n} PDFs`}`
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
 * Over the sheet of the PDF showing, as WinUI InfoBars: who else is in it,
 * and what any session is asking.
 *
 *  - An agent's own PDF, being watched: "Claude · Nokia takeoff is operating
 *    this PDF. The view follows it." with the way to take the tab.
 *  - A session wants to move the view of one of the person's PDFs, this one
 *    or another: the question, with its two answers. It is asked here
 *    whichever tab they are in, because here is where they are looking.
 */
export function AgentBar({
  file, owner, tabs, onHandOver, onTakeOver,
}: {
  file: string
  /** The agent that drives this tab, if one does. */
  owner: string | undefined
  /** Every open tab, to name the PDF a question is about. */
  tabs?: readonly AgentTabItem[]
  onHandOver?: (file: string, agentId: string, yes: boolean) => void
  onTakeOver?: (file: string) => void
}) {
  const agents = useAgents()
  const asks = useHandoverAsks()
  const driver = owner === undefined ? undefined : agents.find((a) => a.id === owner)
  if (driver === undefined && asks.length === 0) return null
  return (
    <div className="agentbar">
      {driver !== undefined && (
        <div className="agentinfobar" role="status" style={tint(driver)}>
          <span className="agentdot" aria-hidden="true" data-state={driver.state} />
          <span className="agentinfobar-text">
            <strong>{driver.name}</strong>
            {driver.state === 'gone' ? ' worked in this PDF and has finished.' : ' is operating this PDF. The view follows it.'}
          </span>
          {onTakeOver !== undefined && (
            <button type="button" className="ghostbtn small" onClick={() => onTakeOver(file)}>Make this tab mine</button>
          )}
        </div>
      )}
      {onHandOver !== undefined && asks.map((a) => {
        const agent = agents.find((x) => x.id === a.agentId)
        if (agent === undefined) return null
        const here = samePath(a.file, file)
        const name = tabs?.find((t) => samePath(t.file, a.file))?.name ?? a.file.replace(/\\/g, '/').replace(/^.*\//, '')
        return (
          <div key={`${a.agentId}|${a.file}`} className="agentinfobar" role="alert" style={tint(agent)}>
            <span className="agentdot" aria-hidden="true" data-state={agent.state} />
            <span className="agentinfobar-text">
              <strong>{agent.name}</strong> wants to turn pages and zoom in {here ? 'this PDF' : <>your PDF <strong>{plainName(name)}</strong></>}. Your view stays as it is unless you allow it.
            </span>
            <button type="button" className="primarybtn small" onClick={() => onHandOver(a.file, agent.id, true)}>{here ? 'Let it work here' : 'Let it work there'}</button>
            <button type="button" className="ghostbtn small" onClick={() => onHandOver(a.file, agent.id, false)}>Not now</button>
          </div>
        )
      })}
    </div>
  )
}
