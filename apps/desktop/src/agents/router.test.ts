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
import { type BridgeActions, type CallContext } from '../bridge/useBridgeRequests.js'
import { agentTabs, lightFileOf, samePath, tabFor, withHanded, withOwner, type LightFile } from '../lightTabs.js'
import { RosterStore } from './roster.js'
import { BridgeRouter, LOST_AFTER_MS, LOST_GRACE_MS } from './router.js'

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
    handBack: (file, agent) => { w.tabs = withHanded(withOwner(w.tabs, file, null), file, { by: agent.name, color: agent.color.bright, agentId: agent.id }) },
    reclaim: (file, agentId) => { w.tabs = withHanded(withOwner(w.tabs, file, agentId), file, null) },
    roster: w.roster,
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
  it('names only the PDFs the session has worked in when it says where an unnamed call went', async () => {
    // A window can hold ninety tabs; the person's and other sessions' are not this session's to choose from.
    const { w, call, act } = world({ tabs: [lightFileOf(MINE), lightFileOf('C:\\Jobs\\Someone else.pdf')] })
    await call(A, 'open_file', { path: 'C:\\Jobs\\Tower A.pdf', wait: true })
    await act(A, 'list_scopes', { file: 'mine.pdf' })
    const out = await act(A, 'list_markups')
    expect(w.log.at(-1)!.file).toBe('C:\\Jobs\\Tower A.pdf')
    expect(String(out?.['fileNote'])).toContain('Mine.pdf')
    expect(String(out?.['fileNote'])).not.toContain('Someone else.pdf')
  })
  it('goes to the file a call names, by path or by name', async () => {
    const { w, call, act } = world()
    await call(A, 'open_file', { path: 'C:\\Jobs\\Tower A.pdf', wait: true })
    await act(A, 'list_scopes', { file: 'mine.pdf' })
    expect(w.log.at(-1)).toMatchObject({ file: MINE, drives: false })
    // A read that names another PDF is a look: the calls after it that name
    // none still go to the agent's own PDF, and say so (Coinbase blind test).
    const out = await act(A, 'list_markups')
    expect(w.log.at(-1)!.file).toBe('C:\\Jobs\\Tower A.pdf')
    expect(String(out?.['fileNote'])).toContain('Tower A.pdf')
    // A write that names it moves there, and the unnamed calls follow.
    await act(A, 'create_markup', { file: 'mine.pdf' })
    await act(A, 'list_markups')
    expect(w.log.at(-1)!.file).toBe(MINE)
  })
  it('asks for `file` on writes and BOM reads once a session has two PDFs open (#135)', async () => {
    const { w, call, act } = world()
    await call(A, 'open_file', { path: 'C:\\Jobs\\Tower A.pdf', wait: true })
    await act(A, 'list_scopes', { file: 'mine.pdf' })
    const before = w.log.length
    const bom = await act(A, 'get_bom')
    expect(String(bom?.['error'])).toContain('pass `file`')
    expect(bom?.['files']).toEqual(expect.arrayContaining(['Tower A.pdf', 'Mine.pdf']))
    expect(String((await act(A, 'create_markup', {}))?.['error'])).toContain('pass `file`')
    expect(w.log.length).toBe(before)
    // Reads that are not quantities still go, with a note; naming the file works.
    expect(await act(A, 'list_markups')).not.toHaveProperty('error')
    expect(await act(A, 'get_bom', { file: 'Tower A.pdf' })).not.toHaveProperty('error')
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
    await Promise.all([act(A, 'create_markup'), act(B, 'create_scope', { file: 'Shared.pdf' }), act(A, 'create_markup')])
    expect(w.overlapped).toBe(false)
    await call(B, 'open_file', { path: 'C:\\Jobs\\Second.pdf', wait: true })
    await Promise.all([act(A, 'create_markup', { file: 'Shared.pdf' }), act(B, 'create_markup', { file: 'Second.pdf' })])
    expect(w.overlapped).toBe(true)
  })
  it('answers a read at once, even while a call on the same PDF never comes back', async () => {
    // NOIC spec, 2026-11-26: a close-up that never came back held up the get_state and get_words after it.
    const { w, call, act } = world()
    await call(A, 'open_file', { path: 'C:\\Jobs\\Spec.pdf', wait: true })
    const host = w.hosts.get('c:\\jobs\\spec.pdf')!
    const invoke = host.invoke
    host.invoke = async (name, params, ctx) => (name === 'trace_area' ? new Promise(() => {}) : invoke(name, params, ctx))
    void act(A, 'trace_area')
    await new Promise((r) => setTimeout(r, 0))
    expect(await act(A, 'get_words', { page: 1968 })).toMatchObject({ ok: true })
    expect(await act(A, 'find_text', { query: 'FS2' })).toMatchObject({ ok: true })
    expect(await call(A, 'screenshot', { page: 1968 })).toBeDefined()
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
  /*
   * Aaron, 2026-11-26: "the agent should also not need to request approval
   * to work within a sheet. It should be able to just jump in and make
   * changes." A session works through a view of its own (Workspace.tsx
   * `agentViewsRef`), so every call goes straight to the PDF and nothing is
   * asked of the person.
   */
  it('takes an agent\'s page turn, zoom and tool straight to the PDF, asking nobody', async () => {
    const { w, act } = world()
    expect(await act(A, 'go_to_page', { page: 4 })).toMatchObject({ ok: true })
    expect(await act(A, 'zoom_to_region', {})).toMatchObject({ ok: true })
    expect(await act(A, 'set_tool', { tool: 'select' })).toMatchObject({ ok: true })
    expect(w.log.map((l) => `${l.action} ${l.agent} ${l.drives}`)).toEqual([
      'go_to_page Claude false', 'zoom_to_region Claude false', 'set_tool Claude false',
    ])
    // The tab stays the person's.
    expect(w.tabs).toEqual([lightFileOf(MINE)])
  })
  it('lets one agent work in a PDF another agent opened, with no refusal', async () => {
    const { w, call, act } = world()
    await call(A, 'open_file', { path: 'C:\\Jobs\\Tower A.pdf', wait: true })
    const out = await act(B, 'go_to_page', { page: 2, file: 'Tower A.pdf' })
    expect(out['error']).toBeUndefined()
    expect(w.log.at(-1)).toMatchObject({ action: 'go_to_page', agent: 'Claude Code', drives: false })
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
    expect(await call(A, 'agent_bye')).toEqual({ ok: true })
    expect(w.roster.agent('a')!.state).toBe('gone')
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

  it('leaves the person\'s own PDF alone when a guest session ends', async () => {
    const { w, act } = world()
    await act(A, 'create_markup', area)
    expect(w.roster.agent('a')!.guestIn).toEqual([MINE])
    await act(A, 'end_session')
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
    expect(w.roster.agent('srv1/AAA')).toMatchObject({ state: 'gone', activity: { busy: false }, ended: { by: 'lost', handedBack: [SPEC] } })
    // Its app may only be restarting its connector: the PDF it read waits for it a while, marked as its.
    expect(tabFor(w.tabs, SPEC)).toMatchObject({ handed: { agentId: 'srv1/AAA' } })
    for (let t = 0; t <= LOST_GRACE_MS; t += 5000) { tick(5000); router.sweep() }
    await new Promise((r) => setTimeout(r, 0))
    expect(w.tabs.map((t) => t.file)).toEqual([MINE])
    expect(w.roster.agent('srv1/AAA')!.ended).toMatchObject({ closed: [SPEC] })
    // An app that never said it was alive (an older server) is never judged lost.
    await act(B, 'list_scopes')
    tick(10 * LOST_AFTER_MS)
    router.sweep()
    expect(w.roster.agent('b')!.state).not.toBe('gone')
  })

  it('finishes the sessions of an AI app killed before it ever said it was alive', async () => {
    const { w, router, call, tick } = world()
    await call({ id: 'srv2/AAA', client: 'claude', label: 'Quick look' }, 'open_file', { path: SPEC, wait: true })
    tick(LOST_AFTER_MS + 1)
    router.sweep()
    await new Promise((r) => setTimeout(r, 0))
    expect(w.roster.agent('srv2/AAA')).toMatchObject({ state: 'gone', ended: { by: 'lost' } })
  })

  it('does not count a stall of the window itself against an AI app', async () => {
    const { w, router, call, tick } = world()
    await call({ id: 'srv3/AAA', client: 'claude', label: 'Spec read' }, 'open_file', { path: SPEC, wait: true })
    await call(null, 'agent_alive', { server: 'srv3' })
    router.sweep()
    // The window did nothing for two minutes: no "still here" could reach it.
    tick(120_000)
    router.sweep()
    expect(w.roster.agent('srv3/AAA')!.state).not.toBe('gone')
  })

  it('gives a session its tabs back when its app comes back after a restart', async () => {
    const { w, router, call, act, tick } = world()
    const who = { id: 'srv4/AAA', client: 'claude', label: 'Spec read' }
    await call(who, 'open_file', { path: SPEC, wait: true })
    await act(who, 'create_markup')
    await call(null, 'agent_alive', { server: 'srv4' })
    // The window's tick runs every five seconds; the server has stopped saying it is alive.
    for (let t = 0; t <= LOST_AFTER_MS; t += 5000) { router.sweep(); tick(5000) }
    router.sweep()
    await new Promise((r) => setTimeout(r, 0))
    // It wrote, so its PDF went to the person's strip, marked as from it.
    expect(tabFor(w.tabs, SPEC)).toMatchObject({ handed: { agentId: 'srv4/AAA' } })
    expect(tabFor(w.tabs, SPEC)!.owner).toBeUndefined()
    // The restarted server carries on as the same session (mcp.rs): the tab is its own again.
    const out = await call(who, 'open_file', { path: SPEC, wait: true })
    expect(out).toMatchObject({ yours: true })
    expect(tabFor(w.tabs, SPEC)).toMatchObject({ owner: 'srv4/AAA' })
    expect(tabFor(w.tabs, SPEC)!.handed).toBeUndefined()
  })

  it('keeps a PDF the session only read for it, when its app comes back a minute later', async () => {
    // SLS, 2026-11-26: read-only tabs closed 25 s after the connector went.
    const { w, router, call, tick } = world()
    const who = { id: 'srv5/AAA', client: 'claude', label: 'Spec read' }
    await call(who, 'open_file', { path: SPEC, wait: true })
    await call(null, 'agent_alive', { server: 'srv5' })
    for (let t = 0; t <= LOST_AFTER_MS + 60_000; t += 5000) { router.sweep(); tick(5000) }
    await new Promise((r) => setTimeout(r, 0))
    expect(w.roster.agent('srv5/AAA')!.state).toBe('gone')
    expect(await call(who, 'get_ui_state', { file: SPEC })).toMatchObject({ agent: { drives: true } })
    expect(tabFor(w.tabs, SPEC)).toMatchObject({ owner: 'srv5/AAA' })
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
