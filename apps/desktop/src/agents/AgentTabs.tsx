/**
 * Agents in the tab strip.
 *
 * Aaron, 2026-11-24: "say 10 tabs open, human working in 2-3 tabs, then
 * collapsed 'tab groups' showing different agents with their own
 * 'environments'. i want visibility into agent actions. different agents
 * different colors".
 *
 * The person's tabs keep the strip (shell/Shell.tsx DocumentTabStrip). To
 * their right, each agent is one chip in its colour: its name, how many PDFs
 * it has open, and what it is doing this second. A click unfolds the chip
 * into its tabs, and a click on one of those shows that PDF — the person
 * looks in on the agent; the agent's work does not come to them.
 *
 * An agent asking to work in one of the person's own PDFs asks here too
 * (handover.ts), beside its chip, so the question is on screen whichever
 * tab they are in.
 */
import { useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { ChevronDown, ChevronRight, FileText, Glyph, X } from '../shell/icons.js'
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

const tint = (agent: Agent): CSSProperties => ({ '--agent': agent.color.fill } as CSSProperties)

// ------------------------------------------------------------- the strip --

/**
 * The agents' side of the tab strip. Renders nothing while no agent is
 * about, so a window nobody is driving looks exactly as it always has.
 */
export function AgentStrip({
  tabs, activeFile, onSelect, onClose, onHandOver, onTakeOver,
}: {
  tabs: readonly AgentTabItem[]
  /** The PDF showing, to mark its tab. */
  activeFile: string | null
  onSelect: (file: string) => void
  onClose: (file: string) => void
  onHandOver?: (file: string, agentId: string, yes: boolean) => void
  onTakeOver?: (file: string) => void
}) {
  const groups = useAgentTabGroups(tabs)
  const [menu, setMenu] = useState<{ agentId: string; file: string | null; x: number; y: number } | null>(null)
  const menuRef = useDismiss(menu !== null, () => setMenu(null))
  if (groups.length === 0) return null
  const menuGroup = menu === null ? null : groups.find((g) => g.agent.id === menu.agentId) ?? null
  const menuTab = menu === null || menu.file === null || menuGroup === null ? null : menuGroup.tabs.find((t) => samePath(t.file, menu.file!)) ?? null

  return (
    <div className="agentstrip" role="group" aria-label="AI agents" data-many={groups.length > 3 ? 'true' : 'false'}>
      {menu !== null && menuGroup !== null && (
        <div className="titlemenu tabctx" role="menu" aria-label={menuGroup.agent.name} ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          {menuTab !== null && (
            <>
              {onTakeOver !== undefined && (
                <button className="menuitem" role="menuitem" onClick={() => { setMenu(null); onTakeOver(menuTab.file) }}>
                  <span className="grow">Make this tab mine</span>
                </button>
              )}
              <button className="menuitem" role="menuitem" onClick={() => { setMenu(null); onClose(menuTab.file) }}>
                <Glyph icon={X} role="row" />
                <span className="grow">Close</span>
              </button>
            </>
          )}
          {menuTab === null && (
            <>
              <button
                className="menuitem" role="menuitem"
                onClick={() => { setMenu(null); roster.setCollapsed(menuGroup.agent.id, !menuGroup.agent.collapsed) }}
              >
                <span className="grow">{menuGroup.agent.collapsed ? 'Show its tabs' : 'Fold its tabs away'}</span>
              </button>
              {menuGroup.tabs.length > 0 && (
                <button
                  className="menuitem" role="menuitem"
                  onClick={() => { setMenu(null); for (const t of menuGroup.tabs) onClose(t.file) }}
                >
                  <Glyph icon={X} role="row" />
                  <span className="grow">{menuGroup.tabs.length === 1 ? 'Close its tab' : `Close its ${menuGroup.tabs.length} tabs`}</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
      {groups.map(({ agent, tabs: own, asks }) => {
        const open = !agent.collapsed && own.length > 0
        const showingOne = activeFile !== null && own.some((t) => samePath(t.file, activeFile))
        const status = agentStatus(agent)
        return (
          <div
            key={agent.id}
            className="agentgroup"
            data-state={agent.state}
            data-open={open ? 'true' : 'false'}
            data-showing={showingOne ? 'true' : 'false'}
            data-asking={asks.length > 0 ? 'true' : 'false'}
            style={tint(agent)}
          >
            <button
              type="button"
              className="agentchip"
              aria-expanded={own.length > 0 ? open : undefined}
              title={`${agent.name}: ${status}${own.length > 0 ? ` · ${own.length} PDF${own.length === 1 ? '' : 's'} open` : ''}`}
              onClick={() => { if (own.length > 0) roster.setCollapsed(agent.id, !agent.collapsed) }}
              onContextMenu={(e) => {
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                setMenu({ agentId: agent.id, file: null, x: Math.min(r.left, window.innerWidth - 280), y: r.bottom })
              }}
            >
              <span className="agentdot" aria-hidden="true" />
              <span className="agentname">{agent.name}</span>
              {own.length > 0 && <span className="agentcount" aria-label={`${own.length} PDFs`}>{own.length}</span>}
              <span className="agentdoing">{status}</span>
              {own.length > 0 && <Glyph icon={open ? ChevronDown : ChevronRight} role="small" />}
            </button>
            {open && own.map((t) => {
              const active = activeFile !== null && samePath(t.file, activeFile)
              return (
                <div
                  key={t.file}
                  role="tab"
                  aria-selected={active}
                  className={`tab agenttab${active ? ' active' : ''}`}
                  title={`${t.file} — ${agent.name}'s tab`}
                  onClick={() => onSelect(t.file)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    const r = e.currentTarget.getBoundingClientRect()
                    setMenu({ agentId: agent.id, file: t.file, x: Math.min(r.left, window.innerWidth - 280), y: r.bottom })
                  }}
                >
                  <Glyph icon={FileText} role="inline" />
                  <span className="tabname">{plainName(t.name)}</span>
                  <button
                    className="tabclose"
                    aria-label={`Close ${plainName(t.name)}`}
                    onClick={(e) => { e.stopPropagation(); onClose(t.file) }}
                  ><Glyph icon={X} role="small" /></button>
                </div>
              )
            })}
            {onHandOver !== undefined && asks.map((t) => (
              <div key={`ask:${t.file}`} className="agentask" role="group" aria-label={`${agent.name} asks to work in ${plainName(t.name)}`}>
                <span className="agentasktext">wants to work in <strong>{plainName(t.name)}</strong></span>
                <button type="button" className="agentaskbtn primary" onClick={() => onHandOver(t.file, agent.id, true)}>Allow</button>
                <button type="button" className="agentaskbtn" onClick={() => onHandOver(t.file, agent.id, false)}>Not now</button>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
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
            <span className="agentdot" aria-hidden="true" />
            <span className="agentname">{agent.name}</span>
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
 * Over the sheet of the PDF showing: who else is in it, and what they ask.
 *
 *  - An agent's own tab, being watched: "Claude is working in this PDF.
 *    The view follows it." with the way to take the tab back.
 *  - The person's tab, and an agent wants to move its view: the question,
 *    with its two answers.
 */
export function AgentBar({
  file, owner, onHandOver, onTakeOver,
}: {
  file: string
  /** The agent that drives this tab, if one does. */
  owner: string | undefined
  onHandOver?: (file: string, agentId: string, yes: boolean) => void
  onTakeOver?: (file: string) => void
}) {
  const agents = useAgents()
  const asks = useHandoverAsks().filter((a) => samePath(a.file, file))
  const driver = owner === undefined ? undefined : agents.find((a) => a.id === owner)
  if (driver === undefined && asks.length === 0) return null
  return (
    <div className="agentbar" role="status">
      {driver !== undefined && (
        <div className="agentbar-row" style={tint(driver)}>
          <span className="agentdot" aria-hidden="true" />
          <span className="agentbar-text">
            <strong>{driver.name}</strong>
            {driver.state === 'gone' ? ' worked in this PDF and has finished.' : ' is working in this PDF. The view follows it.'}
          </span>
          {onTakeOver !== undefined && (
            <button type="button" className="agentaskbtn" onClick={() => onTakeOver(file)}>Make this tab mine</button>
          )}
        </div>
      )}
      {onHandOver !== undefined && asks.map((a) => {
        const agent = agents.find((x) => x.id === a.agentId)
        if (agent === undefined) return null
        return (
          <div key={a.agentId} className="agentbar-row" style={tint(agent)}>
            <span className="agentdot" aria-hidden="true" />
            <span className="agentbar-text">
              <strong>{agent.name}</strong> wants to turn pages and zoom in this PDF. Your view stays as it is unless you allow it.
            </span>
            <button type="button" className="agentaskbtn primary" onClick={() => onHandOver(file, agent.id, true)}>Let it work here</button>
            <button type="button" className="agentaskbtn" onClick={() => onHandOver(file, agent.id, false)}>Not now</button>
          </div>
        )
      })}
    </div>
  )
}
