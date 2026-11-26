/** The pure parts of the agents' chips and cursors. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cursorsFor, cursorSpot, CURSOR_LINGER_MS } from './AgentCursors.js'
import { agentGroups, agentStatus, endedLine, finishedSessions, tabMarks } from './AgentTabs.js'
import { AGENT_COLORS, type Agent } from './roster.js'

const FILE = 'C:\\Jobs\\A.pdf'
const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a', name: 'Claude', app: 'Claude', task: null, color: AGENT_COLORS[0]!, state: 'working', waitingFor: null, ended: null, wrote: [], guestIn: [], current: FILE, since: 0, seenAt: 0, collapsed: true,
  activity: { text: 'Drawing an area', at: 1000, busy: false, file: FILE, page: 2, point: { x: 0.5, y: 0.5 } },
  ...over,
})

describe('agent cursors', () => {
  it('draws an agent on the sheet it acted on, in the PDF it acted in', () => {
    const a = agent()
    expect(cursorsFor([a], 'c:/jobs/a.pdf', 2, 2000)).toEqual([a])
    expect(cursorsFor([a], FILE, 3, 2000)).toEqual([])
    expect(cursorsFor([a], 'C:\\Jobs\\B.pdf', 2, 2000)).toEqual([])
  })
  it('draws one that named no sheet on whichever sheet is showing', () => {
    const a = agent({ activity: { text: 'Reading the scopes', at: 1000, busy: false, file: FILE, page: null, point: null } })
    expect(cursorsFor([a], FILE, 7, 2000)).toEqual([a])
  })
  it('takes the cursor away once the agent has been quiet a while, or has gone', () => {
    const a = agent()
    expect(cursorsFor([a], FILE, 2, 1000 + CURSOR_LINGER_MS + 1)).toEqual([])
    const busy = agent({ activity: { ...a.activity!, busy: true } })
    expect(cursorsFor([busy], FILE, 2, 1000 + CURSOR_LINGER_MS + 1)).toEqual([busy])
    expect(cursorsFor([agent({ state: 'gone' })], FILE, 2, 2000)).toEqual([])
    expect(cursorsFor([agent({ activity: null })], FILE, 2, 2000)).toEqual([])
  })
  it('sits on its point, holds at the edge when panned away, and docks when it has no point', () => {
    const size = { width: 800, height: 600 }
    expect(cursorSpot({ x: 100, y: 200 }, size, 0)).toEqual({ x: 100, y: 200, mode: 'on' })
    expect(cursorSpot({ x: 2000, y: -50 }, size, 0)).toEqual({ x: 790, y: 10, mode: 'edge' })
    expect(cursorSpot(null, size, 0)).toMatchObject({ mode: 'docked' })
    // Several docked labels stack rather than cover one another.
    expect(cursorSpot(null, size, 2).y).toBeGreaterThan(cursorSpot(null, size, 1).y)
  })
})

describe('agent tab groups', () => {
  const tabs = [
    { file: 'C:\\Jobs\\Mine.pdf', name: 'Mine.pdf' },
    { file: FILE, name: 'A.pdf', owner: 'a' },
    { file: 'C:\\Jobs\\B.pdf', name: 'B.pdf', owner: 'b' },
    { file: 'C:\\Jobs\\A2.pdf', name: 'A2.pdf', owner: 'a' },
  ]
  it('groups each agent with its own tabs, and leaves the person\'s out', () => {
    const groups = agentGroups([agent(), agent({ id: 'b', name: 'Codex' })], tabs)
    expect(groups.map((g) => [g.agent.name, g.tabs.map((t) => t.name)])).toEqual([['Claude', ['A.pdf', 'A2.pdf']], ['Codex', ['B.pdf']]])
  })
  it('shows an agent with no tab only while it works', () => {
    const idle = agent({ id: 'c', name: 'Gemini', state: 'idle' })
    expect(agentGroups([idle], tabs)).toEqual([])
    expect(agentGroups([{ ...idle, state: 'working' }], tabs)).toHaveLength(1)
  })
  it('gives a finished session no group: it is listed under Finished, newest first', () => {
    const end = { by: 'agent' as const, summary: 'Done', handedBack: ['C:\\Jobs\\A.pdf'], closed: [] }
    const first = agent({ state: 'gone', ended: { ...end, at: 1000 } })
    const later = agent({ id: 'b', name: 'Codex', state: 'gone', ended: { ...end, by: 'lost', at: 5000 } })
    expect(agentGroups([first, later], tabs)).toEqual([])
    expect(finishedSessions([first, later, agent({ id: 'c' })]).map((a) => a.name)).toEqual(['Codex', 'Claude'])
    expect(endedLine(later)).toMatch(/^Finished .* · its app stopped answering$/)
  })
  it('says what a session is doing now, never what it did: the action, the wait, or when it went quiet', () => {
    expect(agentStatus(agent())).toBe('Drawing an area')
    expect(agentStatus(agent({ state: 'idle' }))).toMatch(/^Quiet since /)
    expect(agentStatus(agent({ state: 'waiting', waitingFor: 'approve the scope definition' }))).toBe('Waiting for you: approve the scope definition')
  })
  it('keeps a session that is a guest in the person\'s PDF on the strip, and dots that tab', () => {
    const guest = agent({ id: 'g', name: 'ChatGPT · Nokia takeoff', state: 'idle', guestIn: ['c:/jobs/mine.pdf'] })
    expect(agentGroups([guest], tabs)).toHaveLength(1)
    expect(tabMarks(tabs[0]!, [guest])).toEqual([{ color: guest.color.bright, title: expect.stringContaining('ChatGPT · Nokia takeoff is also working in this PDF') }])
    expect(tabMarks({ ...tabs[0]!, handed: { by: 'Claude', color: '#00B7C3' } }, [])).toEqual([{ color: '#00B7C3', title: 'New from Claude, which has finished' }])
    expect(tabMarks(tabs[0]!, [{ ...guest, state: 'gone' }])).toEqual([])
  })
})

/**
 * Aaron, 2026-11-24: "agent actions should NEVER steal focus ... even within
 * the app." These hold the places that promise to their code.
 */
describe('agents and the keyboard', () => {
  const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')
  it('keeps the cursor layer out of the pointer\'s and the keyboard\'s way', () => {
    const css = read('./agents.css')
    expect(css).toMatch(/\.agentcursors \{[^}]*pointer-events: none/)
    const tsx = read('./AgentCursors.tsx')
    expect(tsx).not.toMatch(/<button|tabIndex|onClick/)
    expect(tsx.match(/aria-hidden="true"/g)).toHaveLength(2)
  })
  it('hides a background PDF from the eye, the pointer and the keyboard', () => {
    const css = read('./agents.css')
    expect(css).toMatch(/\.wshost\[data-showing="false"\],\s*\.wshost\[data-showing="false"\] \* \{\s*visibility: hidden !important;\s*pointer-events: none !important;/)
    const app = read('../App.tsx')
    expect(app).toMatch(/className="wshost"[^>]*data-showing=/)
    expect(app).toMatch(/\{ inert: '' \}/)
  })
  it('runs an agent\'s action in the PDF showing with the keyboard held', () => {
    const ws = read('../Workspace.tsx')
    expect(ws).toMatch(/keepingFocus\(/)
    // Nothing in the agents' own surfaces takes focus for itself.
    for (const f of ['./AgentTabs.tsx', './AgentCursors.tsx']) expect(read(f)).not.toMatch(/autoFocus|\.focus\(/)
  })
  it('never lets a hidden workspace answer a key meant for the one showing', () => {
    const ws = read('../Workspace.tsx')
    expect((ws.match(/if \(!showingRef\.current\) return/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })
})
