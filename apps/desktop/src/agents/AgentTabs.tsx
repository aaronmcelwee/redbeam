/**
 * What the agent surfaces share: the roster as hooks, each session with its
 * tabs (`agentGroups`), the lines that say how a session stands, and the
 * dots on the person's own tabs.
 *
 * Aaron, 2026-11-24: "say 10 tabs open, human working in 2-3 tabs, then
 * collapsed 'tab groups' showing different agents with their own
 * 'environments' ... It should also name what session is operating that
 * group of files ... collapsed out of the way of the user until they want to
 * drill into it."
 *
 * The sessions were first pills in the tab strip. On a real title bar they
 * truncated to nothing ("It's all very truncated and unusable"), so they are
 * listed in the bottom of the right sidebar instead (AgentsPane.tsx). What
 * stays here besides the shared pieces: the card on the start page, and the
 * InfoBar over the sheet of an agent's PDF.
 *
 * A session that needs a PDF the person already has open does not get a
 * second tab of it: it works in theirs as a guest, and their tab carries a
 * dot in the session's colour (`tabMarks`).
 */
import { useMemo, useSyncExternalStore, type CSSProperties } from 'react'
import { FileText, Glyph, X } from '../shell/icons.js'
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
 * guest in and nothing happening is left out: a card is for something the
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
 * over his work, so a question lives on the session's card in the Agents
 * list and is answered there when he chooses to look.
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
