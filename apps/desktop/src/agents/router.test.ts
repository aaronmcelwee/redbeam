/**
 * Aaron, 2026-11-24: "make MULTIPLE agents be able to work ALONGSIDE a
 * human ... agent actions should NEVER steal focus, from other apps or even
 * within the app."
 *
 * The router is where that is decided: which PDF a call lands in, and what
 * it may do there. A window is faked here as a list of tabs and one host
 * per mounted PDF that refuses to move its view for anyone who does not
 * drive it, as Workspace.tsx does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type BridgeActions, type CallContext, HandoverNeeded } from '../bridge/useBridgeRequests.js'
import { agentTabs, lightFileOf, samePath, tabFor, withHanded, withOwner, type LightFile } from '../lightTabs.js'
import { HandoverStore } from './handover.js'
import { RosterStore } from './roster.js'
import { BridgeRouter, LOST_AFTER_MS } from './router.js'

const MINE = 'C:\\Jobs\\Mine.pdf'
const A = { id: 'a', client: 'claude-ai' }
const B = { id: 'b', client: 'claude-code' }
const MOVES = new Set(['go_to_page', 'zoom_to_region', 'set_tool'])

function world(opts: { isMain?: boolean; showing?: string | null; tabs?: LightFile[] } = {}) {
  let now = 0
  const w = {
    tabs: opts.tabs ?? [lightFileOf(MINE)],
    showing: opts.showing === undefined ? MINE as string | null : opts.showing,
    hosts: new Map<string, BridgeActions>(),
    /** Every call that reached a PDF: file, action, who, and whether it drove. */
    log: [] as Array<{ file: string; action: string; agent: string | null; drives: boolean }>,
    woken: [] as string[],
    openedForPerson: [] as string[],
    roster: new RosterStore(() => now),
    handovers: new HandoverStore(() => now),
    /** How long each host takes to answer. */
    delay: 0,
    running: 0,
    overlapped: false,
    mount(file: string) {
      const page = { n: 0 }
      const record = (action: string, ctx: CallContext) => w.log.push({ file, action, agent: ctx.agent?.name ?? null, drives: ctx.drives })
      w.hosts.set(file.toLowerCase(), {
        uiState: () => ({ file, pageCount: 12, page: page.n }),
        screenshot: (_p, ctx) => { record('screenshot', ctx); return 'data:image/png;base64,AAAA' },
        invoke: async (name, params, ctx) => {
          w.running++
          if (w.running > 1) w.overlapped = true
          try {
            if (w.delay > 0) await new Promise((r) => setTimeout(r, w.delay))
            if (MOVES.has(name) && !ctx.drives) throw new HandoverNeeded(`${name} would move a view its caller does not drive`)
            record(name, ctx)
            if (name === 'go_to_page') page.n = Number(params['page'])
            return { ok: true, page: page.n }
          } finally { w.running-- }
        },
      })
    },
  }
  for (const t of w.tabs) w.mount(t.file)
  const router = new BridgeRouter({
    tabs: () => w.tabs,
    showing: () => w.showing,
    isMain: opts.isMain ?? true,
    host: (file) => w.hosts.get(file.toLowerCase()),
    wake: (file) => { w.woken.push(file) },
    openForAgent: async (path, agentId) => {
      if (/missing/i.test(path)) return `${path} could not be opened`
      const f = { ...lightFileOf(path), owner: agentId }
      w.tabs = [...w.tabs, f]
      w.mount(f.file)
      return f
    },
    openForPerson: (path) => { w.openedForPerson.push(path) },
    closeTab: async (file) => {
      if (/locked/i.test(file)) return false
      w.tabs = w.tabs.filter((t) => !samePath(t.file, file))
      w.hosts.delete(file.toLowerCase())
      return true
    },
    setOwner: (file, owner) => { w.tabs = withOwner(w.tabs, file, owner) },
    handBack: (file, agent) => { w.tabs = withHanded(withOwner(w.tabs, file, null), file, { by: agent.name, color: agent.color.bright }) },
    roster: w.roster,
    handovers: w.handovers,
    appVersion: '0.0.0-test',
    now: () => now,
    sleep: async (ms) => { now += ms },
  })
  const call = (agent: unknown, action: string, params: Record<string, unknown> = {}) =>
    router.answer({ id: 1, action, params, agent } as Parameters<typeof router.answer>[0]) as Promise<Record<string, unknown>>
  const act = (agent: unknown, name: string, params: Record<string, unknown> = {}) => call(agent, 'invoke_ui_action', { action: name, ...params })
  return { w, router, call, act, tick: (ms: number) => { now += ms } }
}

afterEach(() => { vi.useRealTimers() })

describe('where an agent\'s PDF opens', () => {
  it('opens it as the agent\'s own tab, behind what the person is looking at', async () => {
    const { w, call } = world()
    const out = await call(A, 'open_file', { path: 'C:\\Jobs\\Tower A.pdf', wait: true })
    expect(out).toMatchObject({ accepted: true, opened: true, yours: true, pageCount: 12 })
    expect(w.showing).toBe(MINE)
    expect(w.openedForPerson).toEqual([])
    expect(tabFor(w.tabs, 'C:\\Jobs\\Tower A.pdf')!.owner).toBe('a')
  })
  it('opens it the old way, showing, for a caller with no name', async () => {
    const { w, call } = world()
    await call(undefined, 'open_file', { path: 'C:\\Jobs\\Other.pdf' })
    expect(w.openedForPerson).toEqual(['C:\\Jobs\\Other.pdf'])
  })
  it('tells an agent a PDF the person already has open is theirs', async () => {
    const { w, call } = world()
    const out = await call(A, 'open_file', { path: MINE, wait: true })
    expect(out).toMatchObject({ opened: true, yours: false })
    expect(String(out['tab'])).toMatch(/person's own tab/)
    expect(tabFor(w.tabs, MINE)!.owner).toBeUndefined()
  })
  it('says why a PDF could not open', async () => {
    const { w, call } = world()
    expect(await call(A, 'open_file', { path: 'C:\\Jobs\\Missing.pdf', wait: true })).toEqual({ error: 'C:\\Jobs\\Missing.pdf could not be opened' })
    expect(w.roster.agent('a')!.activity!.failed).toBe(true)
  })
  it('leaves a PDF nobody has open to the main window, until asked twice', async () => {
    const { call } = world({ isMain: false })
    expect(await call(A, 'open_file', { path: 'C:\\Jobs\\Tower A.pdf' })).toBeNull()
    expect(await call(A, 'open_file', { path: 'C:\\Jobs\\Tower A.pdf', any: true })).toMatchObject({ accepted: true })
  })
})

describe('where a call lands', () => {
  it('sends each agent\'s calls to its own PDF, and the person\'s view stays put', async () => {
    const { w, call, act } = world()
    await call(A, 'open_file', { path: 'C:\\Jobs\\Tower A.pdf', wait: true })
    await call(B, 'open_file', { path: 'C:\\Jobs\\Tower B.pdf', wait: true })
    await Promise.all([act(A, 'go_to_page', { page: 3 }), act(B, 'go_to_page', { page: 7 }), act(A, 'create_markup', {})])
    expect(w.log.map((l) => `${l.agent} ${l.action} ${l.file.replace(/^.*\\/, '')} ${l.drives}`).sort()).toEqual([
      'Claude Code go_to_page Tower B.pdf true',
      'Claude create_markup Tower A.pdf true',
      'Claude go_to_page Tower A.pdf true',
    ])
    expect(w.showing).toBe(MINE)
    expect(w.log.some((l) => samePath(l.file, MINE))).toBe(false)
  })
  it('goes to the file a call names, by path or by name', async () => {
    const { w, call, act } = world()
    await call(A, 'open_file', { path: 'C:\\Jobs\\Tower A.pdf', wait: true })
    await act(A, 'list_scopes', { file: 'mine.pdf' })
    expect(w.log.at(-1)).toMatchObject({ file: MINE, drives: false })
    // And stays there for the calls after it that name none.
    await act(A, 'list_markups')
    expect(w.log.at(-1)!.file).toBe(MINE)
  })
  it('sends an agent with no PDF of its own to the one the person is looking at, to read and draw', async () => {
    const { w, act } = world()
    expect(await act(A, 'create_markup', {})).toMatchObject({ ok: true })
    expect(w.log.at(-1)).toMatchObject({ file: MINE, agent: 'Claude', drives: false })
  })
  it('treats a session asking what is open as a look: no cursor, no dot, no claim on the person\'s PDF', async () => {
    const { w, call } = world()
    expect(await call(A, 'get_ui_state')).toMatchObject({ file: MINE })
    const a = w.roster.get().agents[0]!
    expect(a.current).toBeNull()
    expect(a.activity).toMatchObject({ text: 'Checking what is open', file: null, busy: false })
    expect(a.guestIn).toEqual([])
  })
  it('stays in the PDF it was working in when the person switches tabs', async () => {
    const other = 'C:\\Jobs\\Other.pdf'
    const { w, act } = world({ tabs: [lightFileOf(MINE), lightFileOf(other)] })
    await act(A, 'create_markup', {})
    w.showing = other
    await act(A, 'create_markup', {})
    expect(w.log.map((l) => l.file)).toEqual([MINE, MINE])
  })
  it('falls back to its last own tab when the one it was in closes', async () => {
    const { w, call, act } = world()
    await call(A, 'open_file', { path: 'C:\\Jobs\\One.pdf', wait: true })
    await call(A, 'open_file', { path: 'C:\\Jobs\\Two.pdf', wait: true })
    w.tabs = w.tabs.filter((t) => !/Two/.test(t.file))
    await act(A, 'list_scopes')
    expect(w.log.at(-1)!.file).toBe('C:\\Jobs\\One.pdf')
  })
  it('lets a caller with no name act on the PDF showing, as every call once did', async () => {
    const { w, act } = world()
    expect(await act(undefined, 'go_to_page', { page: 2 })).toMatchObject({ ok: true, page: 2 })
    expect(w.log.at(-1)).toMatchObject({ file: MINE, agent: null, drives: true })
    expect(w.roster.get().agents).toHaveLength(0)
  })
  it('runs the calls for one PDF one at a time, and different PDFs side by side', async () => {
    const { w, call, act } = world()
    await call(A, 'open_file', { path: 'C:\\Jobs\\Shared.pdf', wait: true })
    w.delay = 5
    await Promise.all([act(A, 'create_markup'), act(B, 'list_scopes', { file: 'Shared.pdf' }), act(A, 'create_markup')])
    expect(w.overlapped).toBe(false)
    await call(B, 'open_file', { path: 'C:\\Jobs\\Second.pdf', wait: true })
    await Promise.all([act(A, 'create_markup', { file: 'Shared.pdf' }), act(B, 'create_markup', { file: 'Second.pdf' })])
    expect(w.overlapped).toBe(true)
  })
  it('counts every call as use, so the PDF is kept live', async () => {
    const { w, act } = world()
    await act(A, 'list_scopes')
    expect(w.woken).toEqual([MINE])
  })
  it('asks the agent to try again while a PDF is still opening in the background', async () => {
    const { w, act } = world()
    w.hosts.clear()
    const out = await act(A, 'list_scopes')
    expect(out).toMatchObject({ opening: true })
    expect(w.woken).toContain(MINE)
  })
  it('says nothing is open, from the main window only', async () => {
    const empty = world({ tabs: [], showing: null })
    expect(await empty.act(A, 'list_scopes')).toMatchObject({ error: expect.stringMatching(/No PDF is open/) })
    expect(await empty.call(A, 'get_ui_state')).toMatchObject({ file: null, pageCount: 0, tabs: [], agent: { name: 'Claude' } })
    const second = world({ tabs: [], showing: null, isMain: false })
    expect(await second.act(A, 'list_scopes')).toBeNull()
  })
})

describe('the person\'s own tab', () => {
  it('does not move its view for an agent: the person is asked, and a yes hands the tab over', async () => {
    const { w, act } = world()
    const going = act(A, 'go_to_page', { page: 4 })
    await vi.waitFor(() => expect(w.handovers.get()).toHaveLength(1))
    expect(w.log).toEqual([])
    // What App.tsx does on "Let it work here".
    w.tabs = withOwner(w.tabs, MINE, 'a')
    w.handovers.answer(MINE, 'a', true)
    expect(await going).toMatchObject({ ok: true, page: 4 })
    expect(w.log).toEqual([{ file: MINE, action: 'go_to_page', agent: 'Claude', drives: true }])
  })
  it('tells the agent the person said not now, and does not ask again', async () => {
    const { w, act } = world()
    const going = act(A, 'go_to_page', { page: 4 })
    await vi.waitFor(() => expect(w.handovers.get()).toHaveLength(1))
    w.handovers.answer(MINE, 'a', false)
    const out = await going
    expect(out).toMatchObject({ handover: 'refused', file: MINE })
    expect(String(out['error'])).toMatch(/save_copy/)
    expect(await act(A, 'zoom_to_region', {})).toMatchObject({ handover: 'refused' })
    expect(w.handovers.get()).toHaveLength(0)
    expect(w.log).toEqual([])
    // Reading and drawing there still work.
    expect(await act(A, 'create_markup')).toMatchObject({ ok: true })
  })
  it('answers "asked" when the person has not answered in time, with the question left up', async () => {
    vi.useFakeTimers()
    const { w, act } = world()
    const going = act(A, 'set_tool', { tool: 'select' })
    await vi.advanceTimersByTimeAsync(13_000)
    const out = await going
    expect(out).toMatchObject({ handover: 'asked' })
    expect(String(out['error'])).toMatch(/has been asked/)
    expect(w.handovers.get()).toHaveLength(1)
  })
  it('keeps one agent out of another agent\'s view, without asking the person', async () => {
    const { w, call, act } = world()
    await call(A, 'open_file', { path: 'C:\\Jobs\\Tower A.pdf', wait: true })
    const told = await act(B, 'go_to_page', { page: 2, file: 'Tower A.pdf' })
    expect(String(told['error'])).toMatch(/Claude's tab/)
    expect(told['handover']).toBe('refused')
    // And the person is not asked to referee between them.
    expect(w.handovers.get()).toHaveLength(0)
  })
  it('marks a refused call as not done on the agent\'s cursor', async () => {
    const { w, act } = world()
    const going = act(A, 'go_to_page', { page: 4 })
    await vi.waitFor(() => expect(w.handovers.get()).toHaveLength(1))
    w.handovers.answer(MINE, 'a', false)
    await going
    expect(w.roster.agent('a')!.activity).toMatchObject({ failed: true, busy: false, text: 'Turning to another sheet' })
  })
})

describe('closing tabs', () => {
  it('closes an agent\'s own tab, and never the person\'s or another agent\'s', async () => {
    const { w, call, act } = world()
    await call(A, 'open_file', { path: 'C:\\Jobs\\Tower A.pdf', wait: true })
    await call(B, 'open_file', { path: 'C:\\Jobs\\Tower B.pdf', wait: true })
    expect(String((await act(A, 'close_tab', { path: MINE }))['error'])).toMatch(/person's own tab/)
    expect(String((await act(A, 'close_tab', { path: 'Tower B.pdf' }))['error'])).toMatch(/another agent's tab/)
    expect(w.tabs).toHaveLength(3)
    expect(await act(A, 'close_tab')).toEqual({ closed: 'C:\\Jobs\\Tower A.pdf', yourTabs: [] })
    expect(w.tabs.map((t) => t.relativePath)).toEqual(['Mine.pdf', 'Tower B.pdf'])
    expect(w.roster.agent('a')!.current).toBeNull()
  })
  it('leaves a tab open when its PDF could not take the save', async () => {
    const { w, call, act } = world()
    await call(A, 'open_file', { path: 'C:\\Jobs\\Locked.pdf', wait: true })
    expect(String((await act(A, 'close_tab'))['error'])).toMatch(/left open/)
    expect(w.tabs).toHaveLength(2)
  })
})

describe('what an agent is told about the window', () => {
  it('lists the tabs and whose each is', async () => {
    const { call } = world()
    await call(A, 'open_file', { path: 'C:\\Jobs\\Tower A.pdf', wait: true })
    await call(B, 'open_file', { path: 'C:\\Jobs\\Tower B.pdf', wait: true })
    const state = await call(A, 'get_ui_state')
    expect(state).toMatchObject({
      file: 'C:\\Jobs\\Tower A.pdf',
      personShowing: MINE,
      tabOwners: [
        { file: MINE, owner: 'person' },
        { file: 'C:\\Jobs\\Tower A.pdf', owner: 'you' },
        { file: 'C:\\Jobs\\Tower B.pdf', owner: 'Claude Code' },
      ],
      agent: { name: 'Claude', colour: 'violet', tabs: ['C:\\Jobs\\Tower A.pdf'], drives: true },
    })
  })
  it('shows what each agent is doing, and that one has gone', async () => {
    const { w, call, act } = world()
    await act(A, 'create_markup', { kind: 'area', rings: [[{ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.4 }]] })
    expect(w.roster.agent('a')).toMatchObject({
      state: 'working',
      activity: { text: 'Drawing an area', file: MINE, page: 0, point: { x: 0.6, y: 0.4 }, busy: false },
    })
    const ask = w.handovers.ask(MINE, 'a', 10)
    expect(await call(A, 'agent_bye')).toEqual({ ok: true })
    expect(w.roster.agent('a')!.state).toBe('gone')
    expect(await ask).toBe('no')
  })
})

describe('how a session ends', () => {
  const TAKEOFF = 'C:\\Jobs\\Nokia - BLIND TAKEOFF.pdf'
  const SPEC = 'C:\\Jobs\\Nokia - Manual.pdf'
  const ADDENDUM = 'C:\\Jobs\\Nokia - Addendum 2.pdf'
  const area = { kind: 'area', rings: [[{ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.4 }]] }

  it('waits for the person at an approval gate with its tabs as they were, and goes back to work on its next call', async () => {
    const { w, call, act } = world()
    await call(A, 'open_file', { path: TAKEOFF, wait: true })
    expect(await act(A, 'wait_for_person', { for: 'approve the scope definition' })).toMatchObject({ waiting: true, for: 'approve the scope definition' })
    expect(w.roster.agent('a')).toMatchObject({ state: 'waiting', waitingFor: 'approve the scope definition' })
    expect(agentTabs(w.tabs, 'a').map((t) => t.file)).toEqual([TAKEOFF])
    await act(A, 'list_scopes', { file: TAKEOFF })
    expect(w.roster.agent('a')).toMatchObject({ state: 'working', waitingFor: null })
  })

  it('hands what it wrote to the person, closes what it only read, and says which was which', async () => {
    const { w, call, act } = world()
    for (const path of [SPEC, ADDENDUM, TAKEOFF]) await call(A, 'open_file', { path, wait: true })
    await act(A, 'find_text', { query: 'CL-105', file: SPEC })
    await act(A, 'create_markup', { ...area, file: TAKEOFF })
    const out = await act(A, 'end_session', { summary: 'Takeoff saved: 3 scopes, 1,240 sf.' })
    expect(out).toMatchObject({ ended: true, handedBack: [TAKEOFF], closed: [SPEC, ADDENDUM] })
    // The person's view did not move, and the takeoff is theirs now, marked as new.
    expect(w.showing).toBe(MINE)
    expect(w.tabs.map((t) => t.file)).toEqual([MINE, TAKEOFF])
    expect(tabFor(w.tabs, TAKEOFF)).toMatchObject({ handed: { by: 'Claude' } })
    expect(tabFor(w.tabs, TAKEOFF)!.owner).toBeUndefined()
    expect(w.roster.agent('a')).toMatchObject({
      state: 'gone',
      ended: { by: 'agent', summary: 'Takeoff saved: 3 scopes, 1,240 sf.', handedBack: [TAKEOFF], closed: [SPEC, ADDENDUM] },
    })
  })

  it('keeps a PDF the session names, one the person is looking at, and one that would not save', async () => {
    const { w, call, act } = world()
    const LOCKED = 'C:\\Jobs\\Locked set.pdf'
    for (const path of [SPEC, ADDENDUM, TAKEOFF, LOCKED]) await call(A, 'open_file', { path, wait: true })
    w.showing = ADDENDUM
    const out = await act(A, 'end_session', { keep: ['Nokia - Manual.pdf'] })
    expect(out['handedBack']).toEqual([SPEC, ADDENDUM, LOCKED])
    expect(out['closed']).toEqual([TAKEOFF])
    expect(w.showing).toBe(ADDENDUM)
  })

  it('leaves the person\'s own PDF alone when a guest session ends, and drops what it was asking', async () => {
    const { w, act } = world()
    await act(A, 'create_markup', area)
    expect(w.roster.agent('a')!.guestIn).toEqual([MINE])
    const ask = w.handovers.ask(MINE, 'a', 10)
    await act(A, 'end_session')
    expect(await ask).toBe('no')
    expect(w.tabs).toEqual([lightFileOf(MINE)])
    expect(w.roster.agent('a')).toMatchObject({ state: 'gone', guestIn: [], ended: { handedBack: [], closed: [] } })
  })

  it('finishes the sessions of an AI app that stops saying it is alive, mid-call or not', async () => {
    const { w, router, call, act, tick } = world()
    await call({ id: 'srv1/AAA', client: 'chatgpt', label: 'Nokia takeoff' }, 'open_file', { path: SPEC, wait: true })
    await call(null, 'agent_alive', { server: 'srv1' })
    // A call that never comes back: the server was killed while it ran.
    w.roster.begin('srv1/AAA', { text: 'Searching for “CL-105”', file: SPEC, page: 0, point: { x: 0.5, y: 0.5 } })
    tick(LOST_AFTER_MS - 1)
    router.sweep()
    expect(w.roster.agent('srv1/AAA')).toMatchObject({ state: 'working', activity: { busy: true } })
    tick(2)
    router.sweep()
    await new Promise((r) => setTimeout(r, 0))
    expect(w.roster.agent('srv1/AAA')).toMatchObject({ state: 'gone', activity: { busy: false }, ended: { by: 'lost', closed: [SPEC] } })
    expect(w.tabs.map((t) => t.file)).toEqual([MINE])
    // An app that never said it was alive (an older server) is never judged lost.
    await act(B, 'list_scopes')
    tick(10 * LOST_AFTER_MS)
    router.sweep()
    expect(w.roster.agent('b')!.state).not.toBe('gone')
  })

  it('keeps what a session said when it finished, if it only looks around before its app closes', async () => {
    const { w, call, act } = world()
    await call(A, 'open_file', { path: 'C:\\Jobs\\Tower A.pdf', wait: true })
    await act(A, 'end_session', { summary: 'Checked the ceilings, nothing to change.' })
    await call(A, 'get_ui_state')
    await call(A, 'agent_bye')
    const a = w.roster.get().agents[0]!
    expect(a.state).toBe('gone')
    expect(a.ended).toMatchObject({ by: 'agent', summary: 'Checked the ceilings, nothing to change.', closed: ['C:\\Jobs\\Tower A.pdf'] })
  })
  it('lets the person end a session, and a call after that starts it again', async () => {
    const { w, router, call, act } = world()
    await call(A, 'open_file', { path: SPEC, wait: true })
    await router.endSession('a', 'person', null, [])
    expect(w.roster.agent('a')).toMatchObject({ state: 'gone', ended: { by: 'person', closed: [SPEC] } })
    await act(A, 'list_scopes')
    expect(w.roster.agent('a')).toMatchObject({ state: 'working', ended: null })
  })
})
