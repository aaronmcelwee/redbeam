import { describe, expect, it } from 'vitest'
import { fileNote, needingYou, OPEN_UP_TO, sessionOpen, summaryLine } from './AgentsPane.js'
import type { AgentGroup } from './AgentTabs.js'
import { AGENT_COLORS, type Agent } from './roster.js'

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a', name: 'Claude · Nokia takeoff', app: 'Claude', task: 'Nokia takeoff', color: AGENT_COLORS[0]!,
  state: 'idle', waitingFor: null, ended: null, wrote: [], guestIn: [], activity: null, current: null,
  since: 0, seenAt: 0, collapsed: true, ...over,
})
const group = (a: Agent, asks = 0): AgentGroup => ({
  agent: a, tabs: [{ file: 'C:\\a.pdf', name: 'a.pdf', owner: a.id }],
  asks: Array.from({ length: asks }, () => ({ file: 'C:\\mine.pdf', name: 'mine.pdf' })),
})

describe('the Agents list', () => {
  it('says how many sessions there are and how many need the person', () => {
    expect(summaryLine(1, 0, 0)).toBe('1 AI session')
    expect(summaryLine(3, 1, 2)).toBe('3 AI sessions · 1 waiting for you')
    expect(summaryLine(0, 0, 2)).toBe('2 finished AI sessions')
  })

  it('counts a session that asked and a session waiting in its chat as needing the person', () => {
    expect(needingYou([group(agent()), group(agent({ state: 'waiting' })), group(agent(), 1)])).toBe(2)
  })

  it('lists every session\'s PDFs while they all fit, and folds the quiet ones once there are many', () => {
    expect(sessionOpen(group(agent()), OPEN_UP_TO, false, undefined)).toBe(true)
    expect(sessionOpen(group(agent()), OPEN_UP_TO + 1, false, undefined)).toBe(false)
    expect(sessionOpen(group(agent({ state: 'waiting' })), 10, false, undefined)).toBe(true)
  })

  it('keeps what the person chose, but never folds a question or the PDF on screen out of sight', () => {
    expect(sessionOpen(group(agent()), 2, false, false)).toBe(false)
    expect(sessionOpen(group(agent()), 10, false, true)).toBe(true)
    expect(sessionOpen(group(agent(), 1), 10, false, false)).toBe(true)
    expect(sessionOpen(group(agent()), 10, true, false)).toBe(true)
  })

  it('says what a session is doing with each PDF', () => {
    const busy = agent({ state: 'working', wrote: ['C:\\b.pdf'], activity: { text: 'Searching', at: 0, busy: true, file: 'c:/a.pdf', page: null, point: null } })
    expect(fileNote(busy, 'C:\\a.pdf', false)).toBe('working here')
    expect(fileNote(busy, 'C:\\b.pdf', false)).toBe('changed')
    expect(fileNote(busy, 'C:\\c.pdf', false)).toBe('read')
    expect(fileNote(busy, 'C:\\c.pdf', true)).toBe('on screen')
    // An action that is over is not still "here".
    expect(fileNote({ ...busy, state: 'idle' }, 'C:\\a.pdf', false)).toBe('read')
  })
})
