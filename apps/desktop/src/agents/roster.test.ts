/**
 * Who is in the window, what they are called, and what the label by their
 * cursor says.
 */
import { describe, expect, it } from 'vitest'
import { AGENT_COLORS, agentName, callPage, callPoint, clientName, describeCall, identityOf, nextColor, RosterStore, WORKING_MS } from './roster.js'

/** WCAG relative luminance contrast of white text on `hex`. */
function whiteOn(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  const l = 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!
  return 1.05 / (l + 0.05)
}

describe('agent names and colours', () => {
  it('names an agent after the app it runs in', () => {
    expect(clientName('claude-ai')).toBe('Claude')
    expect(clientName('claude-code')).toBe('Claude Code')
    expect(clientName('codex-mcp-client')).toBe('Codex')
    expect(clientName('ChatGPT')).toBe('ChatGPT')
    expect(clientName(undefined)).toBe('AI agent')
    expect(clientName('my_tool-mcp')).toBe('my tool')
  })
  it('gives two agents of one app different names', () => {
    expect(agentName({ id: 'a', client: 'claude-ai' }, [])).toBe('Claude')
    expect(agentName({ id: 'b', client: 'claude-ai' }, ['Claude'])).toBe('Claude 2')
    expect(agentName({ id: 'c', client: 'claude-ai' }, ['Claude', 'Claude 2'])).toBe('Claude 3')
    expect(agentName({ id: 'd', client: 'claude-ai', label: 'ceilings' }, ['Claude'])).toBe('Claude · ceilings')
  })
  it('reads white text on every agent colour', () => {
    for (const c of AGENT_COLORS) expect(whiteOn(c.fill), c.name).toBeGreaterThanOrEqual(4.5)
    expect(new Set(AGENT_COLORS.map((c) => c.fill)).size).toBe(AGENT_COLORS.length)
  })
  it('hands out a colour nobody holds, and the least used once all are out', () => {
    expect(nextColor([])).toBe(AGENT_COLORS[0])
    expect(nextColor([AGENT_COLORS[0]!, AGENT_COLORS[2]!])).toBe(AGENT_COLORS[1])
    expect(nextColor([...AGENT_COLORS, AGENT_COLORS[0]!])).toBe(AGENT_COLORS[1])
  })
  it('takes an identity only when it has an id', () => {
    expect(identityOf(null)).toBeNull()
    expect(identityOf({ client: 'claude-ai' })).toBeNull()
    expect(identityOf({ id: ' 12-99 ', client: 'claude-ai', label: '' })).toEqual({ id: '12-99', client: 'claude-ai' })
  })
})

describe('what a call is, in words', () => {
  it('says what the agent is doing', () => {
    expect(describeCall('invoke_ui_action', { action: 'create_markup', kind: 'area' })).toBe('Drawing an area')
    expect(describeCall('invoke_ui_action', { action: 'find_text', query: 'ACT-1' })).toBe('Searching for “ACT-1”')
    expect(describeCall('invoke_ui_action', { action: 'go_to_page', sheet: 'A6.01' })).toBe('Opening sheet A6.01')
    expect(describeCall('screenshot', { rect: { x0: 0, y0: 0, x1: 1, y1: 1 } })).toBe('Looking closely at the sheet')
    expect(describeCall('query', {})).toBe('Reading the takeoff')
  })
  it('names a call it has never heard of rather than saying nothing', () => {
    expect(describeCall('invoke_ui_action', { action: 'weld_the_frame' })).toBe('Weld the frame')
    expect(describeCall('redbeam_new_thing', {})).toBe('New thing')
  })
  it('finds where on the sheet a call acts', () => {
    expect(callPoint({ rings: [[{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }, { x: 0.4, y: 0.3 }]] })).toEqual({ x: 0.4, y: 0.3 })
    expect(callPoint({ points: [[0.2, 0.2], [0.6, 0.7]] })).toEqual({ x: 0.6, y: 0.7 })
    expect(callPoint({ rect: { x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.4 } })).toEqual({ x: 0.4, y: expect.closeTo(0.3) })
    expect(callPoint({ point: '{"x":0.5,"y":0.25}' })).toEqual({ x: 0.5, y: 0.25 })
    expect(callPoint({ markups: [{ points: [{ x: 0.1, y: 0.1 }] }, { points: [{ x: 0.9, y: 0.8 }] }] })).toEqual({ x: 0.9, y: 0.8 })
    // Screen pixels, or nothing about a place: no cursor move.
    expect(callPoint({ point: { x: 640, y: 480 } })).toBeNull()
    expect(callPoint({ label: 'ACT-1' })).toBeNull()
  })
  it('reads the page a call names', () => {
    expect(callPage({ page: 3 })).toBe(3)
    expect(callPage({ page: '4' })).toBe(4)
    expect(callPage({ page: 'A6.01' })).toBeNull()
    expect(callPage({})).toBeNull()
  })
})

describe('the roster', () => {
  const make = () => {
    let now = 1_000
    const r = new RosterStore(() => now)
    return { r, at: (t: number) => { now = t } }
  }
  it('adds an agent the first time it calls, folded, in its own colour', () => {
    const { r } = make()
    const a = r.see({ id: 'a', client: 'claude-ai' })
    const b = r.see({ id: 'b', client: 'claude-ai' })
    expect([a.name, b.name]).toEqual(['Claude', 'Claude 2'])
    expect(a.color).not.toBe(b.color)
    expect(a.collapsed).toBe(true)
    expect(r.see({ id: 'a', client: 'claude-ai' }).name).toBe('Claude')
    expect(r.get().agents).toHaveLength(2)
  })
  it('follows a call from start to answer', () => {
    const { r } = make()
    r.see({ id: 'a' })
    r.begin('a', { text: 'Drawing an area', file: 'C:\\A.pdf', page: 2, point: { x: 0.5, y: 0.5 } })
    expect(r.agent('a')).toMatchObject({ state: 'working', activity: { busy: true, text: 'Drawing an area', page: 2 } })
    r.end('a', { failed: false })
    expect(r.agent('a')!.activity).toMatchObject({ busy: false, point: { x: 0.5, y: 0.5 } })
    expect(r.agent('a')!.activity!.failed).toBeUndefined()
  })
  it('leaves the cursor where it was for a call about no place', () => {
    const { r } = make()
    r.see({ id: 'a' })
    r.begin('a', { text: 'Drawing an area', file: 'C:\\A.pdf', page: 2, point: { x: 0.5, y: 0.5 } })
    r.end('a', { failed: false })
    r.begin('a', { text: 'Saving into the PDF', file: 'C:\\A.pdf', page: null, point: null })
    expect(r.agent('a')!.activity).toMatchObject({ text: 'Saving into the PDF', page: 2, point: { x: 0.5, y: 0.5 } })
    // Another PDF, or another sheet: the old point means nothing there.
    r.begin('a', { text: 'Reading the scopes', file: 'C:\\B.pdf', page: null, point: null })
    expect(r.agent('a')!.activity!.point).toBeNull()
  })
  it('marks a failed call, and takes the page the answer names', () => {
    const { r } = make()
    r.see({ id: 'a' })
    r.begin('a', { text: 'Opening sheet A6.01', file: 'C:\\A.pdf', page: null, point: null })
    r.end('a', { failed: true, page: 4 })
    expect(r.agent('a')!.activity).toMatchObject({ failed: true, page: 4, busy: false })
  })
  it('goes idle after a quiet while, but not mid-call', () => {
    const { r, at } = make()
    r.see({ id: 'a' })
    r.begin('a', { text: 'Tracing an outline', file: null, page: null, point: null })
    at(1_000 + WORKING_MS + 5)
    r.tick()
    expect(r.agent('a')!.state).toBe('working')
    r.end('a', { failed: false })
    at(1_000 + 2 * WORKING_MS + 10)
    r.tick()
    expect(r.agent('a')!.state).toBe('idle')
  })
  it('keeps a gone agent listed, frees its colour, and takes it back when it returns', () => {
    const { r } = make()
    const a = r.see({ id: 'a' })
    r.leave('a')
    expect(r.agent('a')!.state).toBe('gone')
    expect(r.see({ id: 'b' }).color).toBe(a.color)
    expect(r.see({ id: 'a' }).state).toBe('idle')
    r.forget('a')
    expect(r.agent('a')).toBeUndefined()
  })
  it('tells its readers only when something changed', () => {
    const { r } = make()
    let n = 0
    r.subscribe(() => { n++ })
    r.see({ id: 'a' })
    r.setCollapsed('a', true)
    r.setCurrent('a', null)
    expect(n).toBe(1)
    r.setCurrent('a', 'C:\\A.pdf')
    expect(n).toBe(2)
  })
})
