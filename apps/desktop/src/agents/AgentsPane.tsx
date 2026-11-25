/**
 * AI sessions in the left pane, and one summary button in the title bar.
 *
 * Aaron, 2026-11-24, of sessions as pills in the tab strip: "It's all very
 * truncated and unusable." The title bar has room for his own tabs and
 * little else, so three sessions there read "Chat…", "Cl…" and a PDF named
 * "T.". The pane is 300 px wide and as tall as the window: a session's whole
 * name wraps onto a second line, its PDFs are listed by their whole names,
 * and ten sessions scroll instead of crowding one another out.
 *
 * So the title bar says only how many sessions there are and whether one
 * needs him (`AgentSummary`), and this pane says the rest: who, on what job,
 * doing what, in which PDFs, and what each is asking. Nothing here opens over
 * the sheet.
 *
 * WinUI primitives: an Expander per session, ListView rows for its PDFs,
 * InfoBadge for the count and the attention mark, standard buttons.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { ChevronRight, FileText, Glyph, X } from '../shell/icons.js'
import { samePath } from '../lightTabs.js'
import {
  agentStatus, endedLine, finishedSessions, tint, useAgentTabGroups, useAgents,
  type AgentGroup, type AgentTabItem,
} from './AgentTabs.js'
import type { Agent } from './roster.js'
import './agents.css'

const plainName = (name: string): string => name.replace(/\.pdf$/i, '')
const baseName = (file: string): string => plainName(file.replace(/\\/g, '/').replace(/^.*\//, ''))

/** For a window with no tabs of its own. */
export const NO_AGENT_TABS: readonly AgentTabItem[] = []

/** The dot on an agent's PDF while the person looks in on it from his own strip. */
export function peekMarks(owner: string, agents: readonly Agent[]): { color: string; title: string }[] {
  const a = agents.find((x) => x.id === owner)
  return a === undefined ? [] : [{ color: a.color.bright, title: `${a.name} is operating this PDF · ${agentStatus(a)}` }]
}

/** With more sessions than this, the quiet ones start folded so every name is on screen. */
export const OPEN_UP_TO = 4

/**
 * Which sessions the person folded or opened by hand. One for the window:
 * every PDF has its own pane, and a session folded in one stays folded when
 * he clicks into another.
 */
const chosen = new Map<string, boolean>()
const watchers = new Set<() => void>()
let version = 0
const subscribe = (fn: () => void) => { watchers.add(fn); return () => { watchers.delete(fn) } }
function choose(id: string, open: boolean): void {
  chosen.set(id, open)
  version += 1
  for (const fn of watchers) fn()
}

/**
 * Whether a session's PDFs are listed. What he chose, if he chose; otherwise
 * open when it needs him, when he is looking at one of its PDFs, or when
 * there are few enough sessions that all of them fit.
 */
export function sessionOpen(group: AgentGroup, count: number, showing: boolean, choice: boolean | undefined): boolean {
  if (group.asks.length > 0 || showing) return true
  if (choice !== undefined) return choice
  return group.agent.state === 'waiting' || count <= OPEN_UP_TO
}

/** What a session is doing with one of its PDFs, in a word or two. */
export function fileNote(agent: Agent, file: string, showing: boolean): string {
  const here = agent.activity !== null && agent.activity.file !== null && samePath(agent.activity.file, file)
  if (here && agent.state === 'working') return 'working here'
  if (showing) return 'on screen'
  return agent.wrote.some((f) => samePath(f, file)) ? 'changed' : 'read'
}

/** "3 AI sessions", and "· 1 waiting for you" when any is. */
export function summaryLine(live: number, needing: number, finished: number): string {
  const head = live > 0 ? `${live} AI session${live === 1 ? '' : 's'}` : `${finished} finished AI session${finished === 1 ? '' : 's'}`
  return needing > 0 ? `${head} · ${needing} waiting for you` : head
}

/** How many sessions want something from the person: a question, or an answer in their chat. */
export const needingYou = (groups: readonly AgentGroup[]): number =>
  groups.filter((g) => g.asks.length > 0 || g.agent.state === 'waiting').length

/** The sessions and what they need, for the pane's switch and the title bar. */
export function useAgentCounts(tabs: readonly AgentTabItem[]): { live: number; needing: number; finished: number } {
  const agents = useAgents()
  const groups = useAgentTabGroups(tabs)
  return useMemo(
    () => ({ live: groups.length, needing: needingYou(groups), finished: finishedSessions(agents).length }),
    [agents, groups],
  )
}

/**
 * The title bar's one word on agents. Renders nothing while no session is
 * about and none has finished, so a window nobody is driving looks exactly as
 * it always has. Clicking it shows the pane.
 */
export function AgentSummary({ tabs, onShow }: { tabs: readonly AgentTabItem[]; onShow: () => void }) {
  const groups = useAgentTabGroups(tabs)
  const { live, needing, finished } = useAgentCounts(tabs)
  if (live === 0 && finished === 0) return null
  return (
    <button
      type="button" className="agentsummary" data-needing={needing > 0 ? 'true' : 'false'}
      title="Show the AI sessions in this window" onClick={onShow}
    >
      <span className="agentsummary-dots" aria-hidden="true">
        {groups.slice(0, 5).map((g) => <span key={g.agent.id} className="agentdot" data-state={g.agent.state} style={tint(g.agent)} />)}
      </span>
      <span className="agentsummary-text">{summaryLine(live, needing, finished)}</span>
      {needing > 0 && <span className="agentcount attention" aria-hidden="true">!</span>}
    </button>
  )
}

export function AgentsPane({
  tabs, activeFile, onSelect, onHandOver, onEndSession, onDismissSession, onReopenFile,
}: {
  tabs: readonly AgentTabItem[]
  /** The PDF showing, to mark its row. */
  activeFile: string | null
  onSelect: (file: string) => void
  onHandOver?: ((file: string, agentId: string, yes: boolean) => void) | undefined
  onEndSession?: ((agentId: string) => void) | undefined
  onDismissSession?: ((agentId: string) => void) | undefined
  onReopenFile?: ((file: string) => void) | undefined
}) {
  const agents = useAgents()
  const groups = useAgentTabGroups(tabs)
  const finished = useMemo(() => finishedSessions(agents), [agents])
  useSyncExternalStore(subscribe, () => version, () => version)
  const isShowing = (file: string) => activeFile !== null && samePath(file, activeFile)

  return (
    <>
      <div className="panebody agentspane" role="list" aria-label="AI sessions">
        {groups.length === 0 && finished.length === 0 && (
          <div className="paneempty">
            <div>No AI sessions.</div>
            <div className="panehint">When Claude or ChatGPT works in REDBEAM, each chat is listed here with its PDFs and what it is doing.</div>
          </div>
        )}
        {groups.map((group) => {
          const { agent, tabs: own, asks } = group
          const guest = tabs.filter((t) => t.owner === undefined && agent.guestIn.some((f) => samePath(f, t.file)))
          const showing = own.some((t) => isShowing(t.file))
          const open = sessionOpen(group, groups.length, showing, chosen.get(agent.id))
          const files = own.length + guest.length
          return (
            <section
              key={agent.id} role="listitem" className="agentcard" style={tint(agent)}
              data-agent={agent.name} data-state={agent.state} data-open={open ? 'true' : 'false'} data-asking={asks.length > 0 ? 'true' : 'false'}
            >
              <button type="button" className="agentcard-head" aria-expanded={open} onClick={() => choose(agent.id, !open)}>
                <span className="agentcard-twisty"><Glyph icon={ChevronRight} role="small" /></span>
                <span className="agentdot" aria-hidden="true" data-state={agent.state} />
                <span className="agentcard-name"><strong>{agent.app}</strong>{agent.task !== null ? ` · ${agent.task}` : ''}</span>
                {asks.length > 0 || agent.state === 'waiting'
                  ? <span className="agentcount attention" aria-label="Needs you">!</span>
                  : files > 0 && <span className="agentcount" aria-label={`${files} PDF${files === 1 ? '' : 's'}`}>{files}</span>}
              </button>
              <div className="agentcard-status">{agentStatus(agent)}</div>
              {agent.state === 'waiting' && <div className="agentcard-hint">Answer it in its chat. Its PDFs stay open.</div>}
              {onHandOver !== undefined && asks.map((t) => (
                <div key={`ask:${t.file}`} className="agentcard-ask" role="group" aria-label={`${agent.name} asks to work in ${plainName(t.name)}`}>
                  <span>Wants to turn pages and zoom in your PDF <strong>{plainName(t.name)}</strong>.</span>
                  <span className="agentcard-askbtns">
                    <button type="button" className="primarybtn small" onClick={() => onHandOver(t.file, agent.id, true)}>Let it work there</button>
                    <button type="button" className="ghostbtn small" onClick={() => onHandOver(t.file, agent.id, false)}>Not now</button>
                  </span>
                </div>
              ))}
              {open && (
                <>
                  {own.map((t) => (
                    <button
                      key={t.file} type="button" className={`agentfile${isShowing(t.file) ? ' active' : ''}`}
                      aria-current={isShowing(t.file) ? 'true' : undefined} title={`${t.file}\nLook in on this PDF beside ${agent.name}`}
                      onClick={() => onSelect(t.file)}
                    >
                      <Glyph icon={FileText} role="inline" />
                      <span className="agentfile-name">{plainName(t.name)}</span>
                      <span className="agentfile-note">{fileNote(agent, t.file, isShowing(t.file))}</span>
                    </button>
                  ))}
                  {guest.map((t) => (
                    <button
                      key={`guest:${t.file}`} type="button" className={`agentfile${isShowing(t.file) ? ' active' : ''}`}
                      aria-current={isShowing(t.file) ? 'true' : undefined} title={`${t.file}\nYour PDF. ${agent.name} is working in it with you.`}
                      onClick={() => onSelect(t.file)}
                    >
                      <Glyph icon={FileText} role="inline" />
                      <span className="agentfile-name">{plainName(t.name)}</span>
                      <span className="agentfile-note">your PDF</span>
                    </button>
                  ))}
                  {files === 0 && <div className="agentcard-none">It has no PDFs open.</div>}
                  {onEndSession !== undefined && (
                    <div className="agentcard-foot">
                      <button type="button" className="ghostbtn small" onClick={() => onEndSession(agent.id)}>End this session</button>
                    </div>
                  )}
                </>
              )}
            </section>
          )
        })}
        {finished.length > 0 && <div className="agentspane-label">Finished</div>}
        {finished.map((a) => {
          const end = a.ended!
          return (
            <section key={a.id} role="listitem" className="agentcard finished" data-agent={a.name} data-state="gone" data-open="true" style={tint(a)}>
              <div className="agentcard-head">
                <span className="agentdot" aria-hidden="true" data-state="gone" />
                <span className="agentcard-name"><strong>{a.app}</strong>{a.task !== null ? ` · ${a.task}` : ''}</span>
                {onDismissSession !== undefined && (
                  <button type="button" className="tabclose" aria-label={`Dismiss ${a.name}`} title="Dismiss" onClick={() => onDismissSession(a.id)}>
                    <Glyph icon={X} role="small" />
                  </button>
                )}
              </div>
              <div className="agentcard-status">{endedLine(a)}</div>
              {end.summary !== null && <div className="agentcard-summary">{end.summary}</div>}
              {end.handedBack.length > 0 && <div className="agentcard-label">Now in your tabs</div>}
              {end.handedBack.map((f) => (
                <button key={`back:${f}`} type="button" className={`agentfile${isShowing(f) ? ' active' : ''}`} title={f} onClick={() => onSelect(f)}>
                  <Glyph icon={FileText} role="inline" />
                  <span className="agentfile-name">{baseName(f)}</span>
                  <span className="agentfile-note">changed</span>
                </button>
              ))}
              {end.closed.length > 0 && <div className="agentcard-label">Only read, so closed. Pick one to reopen it.</div>}
              {end.closed.map((f) => (
                <button key={`closed:${f}`} type="button" className="agentfile" title={f} disabled={onReopenFile === undefined} onClick={() => onReopenFile?.(f)}>
                  <Glyph icon={FileText} role="inline" />
                  <span className="agentfile-name">{baseName(f)}</span>
                  <span className="agentfile-note">reopen</span>
                </button>
              ))}
            </section>
          )
        })}
      </div>
      <div className="panefoot">
        {summaryLine(groups.length, needingYou(groups), finished.length)}
        {onDismissSession !== undefined && finished.length > 1 && (
          <button type="button" className="agentspane-dismiss" onClick={() => { for (const a of finished) onDismissSession(a.id) }}>Dismiss finished</button>
        )}
      </div>
    </>
  )
}
