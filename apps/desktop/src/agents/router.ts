/**
 * Which PDF a bridge call lands in.
 *
 * One window, several PDFs live at once, several agents calling at the same
 * moment, and a person working in tabs of their own. Every call arrives here
 * with who sent it, and this decides:
 *
 *  - WHERE it goes. The file the call names; else the agent's own current
 *    PDF (the one it opened or addressed last); else, for an agent with no
 *    PDF yet, the one the person is looking at.
 *  - WHAT it may do there. Read and write, in its own tab or the person's,
 *    through a view of its own (Workspace.tsx `agentViewsRef`). Nothing is
 *    asked of the person and nothing on screen moves.
 *  - That NOTHING the person is doing moves. An agent's open_file adds a tab
 *    to its own group behind the tab showing; its close_tab closes only its
 *    own tabs.
 *
 * Calls for one PDF run one at a time, so two agents sharing a PDF cannot
 * interleave a page turn with a write.
 *
 * No React here: App.tsx supplies the tabs and the ways to change them, and
 * the tests supply fakes.
 */
import { reportForAgent, whatsNewForAgent } from './appWide.js'
import { RELEASES } from '../whatsnew/changelogSource.js'
import { type BridgeActions, type BridgeRequest, type CallContext, runOnHost, UNNAMED_CALL } from '../bridge/useBridgeRequests.js'
import { agentTabs, samePath, tabFor, tabNamed, type LightFile } from '../lightTabs.js'
import { signal } from '../signals/install.js'
import { pause } from './wait.js'
import { type Agent, type AgentIdentity, callPage, callPoint, callWrites, describeCall, type EndedBy, identityOf, type RosterStore } from './roster.js'

export interface RouterDeps {
  /** Every open tab, the person's and the agents'. */
  tabs: () => readonly LightFile[]
  /** The PDF the person is looking at, or null on the start page. */
  showing: () => string | null
  /** Whether this is the window that takes PDFs opened from outside. */
  isMain: boolean
  /** What the workspace for `file` can do, or undefined while it is not mounted. */
  host: (file: string) => BridgeActions | undefined
  /** Mount `file`'s workspace behind the one showing, if it is not mounted. */
  wake: (file: string) => void
  /**
   * Open `path` as a tab of `agentId`, behind whatever is showing. Resolves
   * to the tab, or to a sentence saying why it could not open.
   */
  openForAgent: (path: string, agentId: string) => Promise<LightFile | string>
  /** Open `path` the way a person does: as the tab showing. For callers with no name. */
  openForPerson: (path: string) => void
  /** Close one tab, saving it first. Resolves false when it stayed open. */
  closeTab: (file: string) => Promise<boolean>
  /** Hand a tab to an agent, or back to the person (null). */
  setOwner: (file: string, owner: string | null) => void
  /** Move a finished session's tab to the person's strip, marked as come from `agent` until they open it. */
  handBack: (file: string, agent: Agent) => void
  /** Give a tab handed back from `agentId` (and not yet opened by the person) back to it. */
  reclaim?: (file: string, agentId: string) => void
  roster: RosterStore
  appVersion: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Under the bridge's own twenty seconds (bridge/ui.rs), with room to answer. */
export const CALL_BUDGET_MS = 17_500
/** How long open_file with `wait` waits for the PDF, under the bridge's 22 s for it. */
export const OPEN_WAIT_MS = 20_000
/**
 * An AI app's server says it is alive every few seconds (mcp.rs `ALIVE_EVERY`).
 * One that has said so before and then says nothing for this long was killed
 * or has hung: its sessions are finished, so no cursor or status of theirs
 * stays on screen saying something that is no longer happening.
 */
export const LOST_AFTER_MS = 20_000

/**
 * Calls that only read, and never move a view: answered at once rather than
 * queued behind the PDF's other calls. NOIC spec, 2026-11-26: a close-up of
 * page 1968 that never came back held the PDF's queue, so the get_state and
 * get_words after it waited too, and the AI app gave up on the whole
 * connector after 140 s. A read may see a write half done; it never blocks one.
 */
const READ_ACTIONS = new Set([
  'get_ui_state', 'query', 'get_state', 'screenshot',
])
const READ_UI_ACTIONS = new Set([
  'find_text', 'get_words', 'list_sheets', 'list_markups', 'list_scopes', 'get_bom', 'get_history',
  'get_settings', 'list_bookmarks', 'list_links', 'list_annotations', 'get_piece_list', 'get_pattern',
  'list_patterns', 'get_scale_presets', 'describe_product', 'get_lines', 'read_scale', 'measure', 'detect_grid', 'detect_directions', 'match_hatch',
])

/** Whether a call only reads: see READ_ACTIONS. A screenshot of the canvas as it is, or of a named sheet, reads. */
export function readsOnly(action: string, params: Record<string, unknown>): boolean {
  if (READ_ACTIONS.has(action)) return true
  if (action !== 'invoke_ui_action') return false
  const what = typeof params['action'] === 'string' ? params['action'] : ''
  if (!READ_UI_ACTIONS.has(what)) return false
  // Some reads turn the window to the sheet they name first; those wait their turn.
  return params['page'] === undefined || READS_ANY_SHEET.has(what)
}
/** Reads that answer for any sheet without showing it. */
const READS_ANY_SHEET = new Set(['find_text', 'get_words', 'list_sheets', 'list_markups', 'get_bom', 'get_piece_list', 'get_history'])

/**
 * A window that did not run its tick for this long was itself stalled (a
 * long render on the main thread, a laptop asleep): no AI app's server could
 * reach it meanwhile, so silence over that stretch says nothing about them.
 */
export const STALL_MS = 10_000
/**
 * How long the PDFs of a session whose app stopped answering wait for it to
 * come back before the ones it only read are closed. Its app may only be
 * restarting its connector: SLS, 2026-11-26, read-only tabs closed 25 s
 * after the connector went, and the session came back to find them gone.
 */
export const LOST_GRACE_MS = 10 * 60_000

export class BridgeRouter {
  private readonly queues = new Map<string, Promise<unknown>>()
  private lastSweep: number | null = null
  /** The PDFs each session has called into, to say which one an unnamed call went to. */
  private readonly filesSeen = new Map<string, Set<string>>()
  /** Read-only tabs of lost sessions, waiting out LOST_GRACE_MS before they close. */
  private readonly lingering = new Map<string, { agentId: string; at: number }>()
  /** When each AI app's server last said it was alive, by the part of an agent's id before the last "/". */
  private readonly aliveAt = new Map<string, number>()
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: RouterDeps) {
    this.now = deps.now ?? (() => Date.now())
    // A clock a covered window does not slow (agents/wait.ts).
    this.sleep = deps.sleep ?? pause
  }

  /** Answer one request, or null when it is for another window. */
  async answer(req: BridgeRequest): Promise<Record<string, unknown> | null> {
    const params = req.params ?? {}
    const who = identityOf(req.agent)
    const before = who === null ? undefined : this.deps.roster.agent(who.id)
    const agent = who === null ? null : this.deps.roster.see(who)
    /*
     * A session coming back after its app's server was lost or restarted
     * (mcp.rs keeps sessions across a restart): the tabs it was handed back
     * and that the person has not opened since are its own again. NOIC
     * intake, 2026-11-26: after a restart the spec answered yours:false.
     */
    if (agent !== null && before?.state === 'gone' && (before.ended?.by === 'lost' || before.ended?.by === 'app')) {
      this.reclaimTabs(agent)
    }
    /*
     * A server is on the clock from its first call, not from its first "still
     * here". One that was killed in its first five seconds never said so, and
     * its sessions stayed listed as Quiet until the app closed (SLS, 2026-11-25).
     */
    if (agent !== null) {
      const server = agent.id.slice(0, Math.max(0, agent.id.lastIndexOf('/')))
      if (server !== '' && !this.aliveAt.has(server)) this.aliveAt.set(server, this.now())
    }
    switch (req.action) {
      case 'agent_bye': return this.bye(who)
      case 'agent_alive': return this.alive(params)
      default: {
        const t0 = this.now()
        const out = req.action === 'open_file' ? await this.openFile(agent, params) : await this.call(agent, req.action, params)
        // Every tool call is counted by how it ended and how long it took
        // (src/signals): the failing and slow tools are what agents trip on.
        if (out !== null) {
          const ms = this.now() - t0
          const error = typeof out['error'] === 'string' ? out['error'] : null
          const ended = error !== null ? 'failed' : ms >= CALL_BUDGET_MS ? 'over-budget' : 'ok'
          signal('agent', `${req.action}:${ended}`, [agent?.app ?? '', error ?? ''].filter((x) => x !== '').join(' · '), ms)
        }
        return out
      }
    }
  }

  // ------------------------------------------------------------ a call --

  private async call(agent: Agent | null, action: string, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const started = this.now()
    const left = () => CALL_BUDGET_MS - (this.now() - started)
    const named = typeof params['file'] === 'string' ? params['file'].trim() : ''
    // About the session itself, not about a PDF: answered with or without one open.
    if (action === 'invoke_ui_action' && agent !== null) {
      if (params['action'] === 'wait_for_person') return this.waitForPerson(agent, params)
      if (params['action'] === 'end_session') {
        const keep = Array.isArray(params['keep']) ? params['keep'].filter((k): k is string => typeof k === 'string') : []
        return this.endSession(agent.id, 'agent', line(params['summary']), keep)
      }
    }
    const tab = this.target(agent, named)
    /*
     * A session with no PDF of its own yet, asking what is open, is answered
     * from the PDF the person is showing. That is a look, not a visit: it
     * does not make the person's PDF the session's current one, puts no
     * cursor on it and marks no guest dot (SLS, 2026-11-24: "Checking what
     * is open" sat over Aaron's sheet while the agent worked elsewhere).
     */
    const glance = agent !== null && tab !== null && named === '' && tab.owner !== agent.id
      && (action === 'get_ui_state' || action === 'get_state')
      && (agent.current === null || !samePath(agent.current, tab.file))

    if (tab === null) {
      // No PDF anywhere in this window. Another window may have one: let it
      // answer first, and only the main window says "nothing is open".
      if (!this.deps.isMain) return null
      await this.sleep(400)
      if (action === 'get_ui_state') return this.nothingOpen(agent)
      // About the app, not a PDF: a bug report and the release notes work from the start screen too.
      const what = action === 'invoke_ui_action' && typeof params['action'] === 'string' ? params['action'] : ''
      if (what === 'whats_new') return whatsNewForAgent(params, RELEASES, this.deps.appVersion)
      if (what === 'report_problem') return reportForAgent({ params, app: agent?.app ?? null, agentId: agent?.id ?? null, where: '' })
      return { error: 'No PDF is open in REDBEAM. Open one with redbeam_open_file (wait:true), then call again.' }
    }

    // close_tab is about the tabs, which the window keeps, not about one PDF.
    if (action === 'invoke_ui_action' && params['action'] === 'close_tab' && agent !== null) {
      return this.closeTab(agent, params)
    }

    // What this agent's calls mean when they name no file, from here on: the
    // PDF it just addressed. "Open A, open B, then work" stays in B, and the
    // person switching tabs does not carry a half-drawn takeoff to another PDF.
    //
    // A READ that names another PDF is a look at it, not a move (Coinbase
    // blind test, 2026-11-27: list_annotations on the original, then get_bom
    // with no file read the original's empty BOM). Only a write, or a call
    // with no PDF of the session's own yet, moves where unnamed calls go.
    const look = named !== '' && readsOnly(action, params) && agent !== null && agent.current !== null
      && tabFor(this.deps.tabs(), agent.current) !== undefined
    if (agent !== null && !glance && !look) this.deps.roster.setCurrent(agent.id, tab.file)
    if (agent !== null && !glance) {
      const seen = this.filesSeen.get(agent.id) ?? new Set<string>()
      seen.add(tab.file.replace(/\\/g, '/').toLowerCase())
      this.filesSeen.set(agent.id, seen)
    }
    // Mounts it if it was let go, and counts as use either way (agents/live.ts).
    this.deps.wake(tab.file)
    const text = describeCall(action, params)
    if (agent !== null) {
      this.deps.roster.begin(agent.id, glance
        ? { text, file: null, page: null, point: null }
        : { text, file: tab.file, page: callPage(params), point: callPoint(params) })
    }
    let result: Record<string, unknown>
    const turn = <T,>(run: () => Promise<T>): Promise<T> => (readsOnly(action, params) ? run() : this.inTurn(tab.file, run))
    try {
      result = await turn(async () => {
        const host = await this.ready(tab.file, Math.min(12_000, left() - 1500))
        if (host === undefined) {
          return { error: `${nameOf(tab.file)} is still opening in the background. Try again in a few seconds.`, opening: true }
        }
        return await runOnHost(host, action, params, this.context(agent, tab.file))
      })
    } catch (e) {
      result = { error: e instanceof Error ? e.message : String(e) }
    }
    if (agent !== null) {
      const failed = typeof result['error'] === 'string'
      this.deps.roster.end(agent.id, glance ? { failed } : {
        failed,
        page: typeof result['page'] === 'number' ? result['page'] : null,
        file: tab.file,
      })
      const now = tabFor(this.deps.tabs(), tab.file)
      if (now !== undefined && !glance) {
        this.deps.roster.touch(agent.id, tab.file, { wrote: !failed && callWrites(action, params), guest: now.owner !== agent.id })
      }
    }
    // Unnamed calls by a session that has worked in more than one PDF say
    // where they went, so a call that went to the other one is noticed.
    if (agent !== null && named === '' && (this.filesSeen.get(agent.id)?.size ?? 0) > 1) {
      const others = [...new Set(this.deps.tabs().map((t) => t.file))].filter((f) => !samePath(f, tab.file)).map(nameOf)
      if (others.length > 0) {
        result = { ...result, fileNote: `no \`file\` given, so this went to ${nameOf(tab.file)}; also open: ${others.join(', ')}. Pass \`file\` to choose.` }
      }
    }
    return action === 'get_ui_state' ? { ...result, ...this.about(agent, tab.file) } : result
  }

  /** The tab a call is for, or null when the window has none for it. */
  private target(agent: Agent | null, named: string): LightFile | null {
    const tabs = this.deps.tabs()
    if (named !== '') {
      const hit = tabNamed(tabs, named)
      if (hit !== undefined) return hit
      // A document id, or a file that is not open: the workspace it lands in
      // says so, naming what it is showing (Workspace.tsx `file`).
    }
    if (agent !== null) {
      const mine = agent.current === null ? undefined : tabFor(tabs, agent.current)
      if (mine !== undefined) return mine
      // Its current PDF closed: the last of its own tabs, if it has any.
      const own = agentTabs(tabs, agent.id)
      if (own.length > 0) return own[own.length - 1]!
    }
    const showing = this.deps.showing()
    return showing === null ? null : (tabFor(tabs, showing) ?? null)
  }

  private context(agent: Agent | null, file: string): CallContext {
    if (agent === null) return UNNAMED_CALL
    const tab = tabFor(this.deps.tabs(), file)
    const fresh = this.deps.roster.agent(agent.id) ?? agent
    return { agent: fresh, drives: tab?.owner === agent.id }
  }

  /** The workspace for `file`, mounted and with its PDF read, or undefined if that takes longer than `waitMs`. */
  private async ready(file: string, waitMs: number): Promise<BridgeActions | undefined> {
    const until = this.now() + Math.max(0, waitMs)
    for (;;) {
      const host = this.deps.host(file)
      if (host !== undefined) return host
      if (this.now() >= until) return undefined
      await this.sleep(15)
    }
  }

  /** One call at a time per PDF. A call that throws does not hold up the next. */
  private inTurn<T>(file: string, run: () => Promise<T>): Promise<T> {
    const k = file.replace(/\//g, '\\').toLowerCase()
    const before = this.queues.get(k) ?? Promise.resolve()
    const mine = before.then(run, run)
    const tail = mine.catch(() => undefined)
    this.queues.set(k, tail)
    void tail.then(() => { if (this.queues.get(k) === tail) this.queues.delete(k) })
    return mine
  }

  // ---------------------------------------------------------- open_file --

  private async openFile(agent: Agent | null, params: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const path = typeof params['path'] === 'string' ? params['path'].trim() : ''
    if (path === '') return { error: 'open_file needs `path`' }
    const wait = params['wait'] === true
    const open = tabFor(this.deps.tabs(), path)
    // The window that has it answers; else the main one; else, once asked twice, any.
    if (open === undefined && !this.deps.isMain && params['any'] !== true) return null

    let tab: LightFile
    if (agent === null) {
      // A caller with no name: the PDF opens as the person's, showing.
      this.deps.openForPerson(path)
      tab = open ?? { folder: '', file: path, relativePath: nameOf(path) }
    } else if (open !== undefined) {
      tab = open
      this.deps.wake(open.file)
    } else {
      this.deps.roster.begin(agent.id, { text: `Opening ${nameOf(path)}`, file: path, page: null, point: null })
      const made = await this.deps.openForAgent(path, agent.id)
      if (typeof made === 'string') {
        this.deps.roster.end(agent.id, { failed: true })
        return { error: made }
      }
      tab = made
    }
    if (agent !== null) {
      this.deps.roster.setCurrent(agent.id, tab.file)
      if (open !== undefined) this.deps.roster.begin(agent.id, { text: `Opening ${nameOf(path)}`, file: tab.file, page: null, point: null })
    }

    const whose = agent === null ? {} : this.whose(agent, tabFor(this.deps.tabs(), tab.file) ?? tab)
    if (!wait) {
      if (agent !== null) this.deps.roster.end(agent.id, { failed: false, file: tab.file })
      return {
        accepted: true, path: tab.file, ...whose,
        note: 'poll redbeam_get_ui_state until pageCount > 0, or pass wait:true to be answered once it has opened',
      }
    }
    const until = this.now() + OPEN_WAIT_MS
    for (;;) {
      const host = this.deps.host(tab.file)
      const pages = host === undefined ? 0 : Number(host.uiState()['pageCount'] ?? 0)
      if (pages > 0) {
        if (agent !== null) this.deps.roster.end(agent.id, { failed: false, file: tab.file })
        return { accepted: true, opened: true, path: tab.file, pageCount: pages, ...whose }
      }
      // Gone again: it failed to open and its tab was closed.
      if (agent !== null && tabFor(this.deps.tabs(), tab.file) === undefined) {
        this.deps.roster.end(agent.id, { failed: true })
        return { error: `${nameOf(tab.file)} could not be opened` }
      }
      if (this.now() >= until) break
      await this.sleep(25)
    }
    if (agent !== null) this.deps.roster.end(agent.id, { failed: false, file: tab.file })
    return {
      accepted: true, opened: false, path: tab.file, ...whose,
      note: 'still opening after 20 seconds; poll redbeam_get_ui_state until pageCount > 0',
    }
  }

  private whose(agent: Agent, tab: LightFile): Record<string, unknown> {
    if (tab.owner === agent.id) {
      return { yours: true, tab: `${agent.name}'s own tab, open behind whatever the person is looking at. Nothing on their screen moved.` }
    }
    return {
      yours: false,
      tab: tab.owner === undefined
        ? 'This PDF was already open in the person\'s own tab, so it stays theirs. That changes nothing for you: you have your own view of it, and every read, screenshot, page turn, zoom and write works there without asking them or moving their screen.'
        : `This PDF was already open as ${this.deps.roster.agent(tab.owner)?.name ?? 'another agent'}'s tab. You have your own view of it and can read and write there; you are both changing one PDF, so do not undo or delete what you did not make.`,
    }
  }

  // ---------------------------------------------------------- close_tab --

  private async closeTab(agent: Agent, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tabs = this.deps.tabs()
    const want = typeof params['path'] === 'string' && params['path'].trim() !== ''
      ? params['path'].trim()
      : typeof params['file'] === 'string' && params['file'].trim() !== '' ? params['file'].trim() : ''
    const tab = want !== '' ? tabNamed(tabs, want) : (agent.current === null ? undefined : tabFor(tabs, agent.current))
    const mine = agentTabs(tabs, agent.id).map((t) => t.file)
    if (tab === undefined) return { error: want === '' ? 'you have no tab open to close' : `no open tab ${want}`, yourTabs: mine }
    if (tab.owner !== agent.id) {
      return {
        error: `${nameOf(tab.file)} is ${tab.owner === undefined ? 'the person\'s own tab' : 'another agent\'s tab'}; an agent closes only the tabs it opened`,
        yourTabs: mine,
      }
    }
    this.deps.roster.begin(agent.id, { text: `Closing ${nameOf(tab.file)}`, file: tab.file, page: null, point: null })
    const closed = await this.inTurn(tab.file, () => this.deps.closeTab(tab.file))
    this.deps.roster.end(agent.id, { failed: !closed })
    if (!closed) return { error: `${nameOf(tab.file)} could not be saved, so it was left open` }
    const rest = agentTabs(this.deps.tabs(), agent.id)
    this.deps.roster.setCurrent(agent.id, rest.length > 0 ? rest[rest.length - 1]!.file : null)
    return { closed: tab.file, yourTabs: rest.map((t) => t.file) }
  }

  // ---------------------------------------------------------------- bye --

  private bye(who: AgentIdentity | null): Record<string, unknown> | null {
    if (who !== null && this.deps.roster.agent(who.id) !== undefined) void this.endSession(who.id, 'app', null, [])
    return this.deps.isMain ? { ok: true } : null
  }

  // ------------------------------------------------------- the session --

  /** The agent has stopped for the person's answer. Its tabs stay as they are; its next call puts it back to work. */
  private waitForPerson(agent: Agent, params: Record<string, unknown>): Record<string, unknown> {
    const forWhat = line(params['for'])
    this.deps.roster.wait(agent.id, forWhat)
    return {
      waiting: true,
      ...(forWhat !== null ? { for: forWhat } : {}),
      note: 'REDBEAM shows the person that this session is waiting for them. Your tabs stay open. Your next call puts the session back to work; call redbeam_end_session when the job is done.',
    }
  }

  /**
   * Finish a session, and settle its tabs so the person is left nothing to
   * referee (Aaron, 2026-11-24):
   *
   *  - a PDF it wrote in, or named in `keep`, goes to the person's own tab
   *    strip, saved, without being shown;
   *  - a PDF it only read is closed, and listed in the session's summary to
   *    reopen;
   *  - a PDF the person is looking at, or one that could not be saved, is
   *    never closed: it goes to their strip;
   *  - a PDF of the person's it worked in as a guest is left as it is.
   */
  async endSession(agentId: string, by: EndedBy, summary: string | null, keep: readonly string[]): Promise<Record<string, unknown>> {
    const agent = this.deps.roster.agent(agentId)
    if (agent === undefined) return { error: 'no such session' }
    if (agent.state === 'gone') return { ended: true, note: 'This session had already finished.' }
    const own = agentTabs(this.deps.tabs(), agentId)
    const kept = (file: string) => keep.some((k) => tabNamed(own, k)?.file === file)
    const wrote = (file: string) => agent.wrote.some((f) => samePath(f, file))
    const handedBack: string[] = []
    const closed: string[] = []
    // Why each PDF that stayed open did: an agent told "handed back" about a set it only read took that for a mistake (Aaron's agent report, 2026-11-26).
    const why: Record<string, string> = {}
    // Finished first: from here it has no cursor, no call in flight, and asks nothing.
    this.deps.roster.finish(agentId, { by, summary, handedBack: [], closed: [] })
    for (const tab of own) {
      const showing = this.deps.showing()
      const watched = showing !== null && samePath(showing, tab.file)
      if (by === 'lost' && !wrote(tab.file) && !kept(tab.file) && !watched) {
        // Kept for a while, marked as its, in case its app is only restarting.
        this.deps.handBack(tab.file, agent)
        this.lingering.set(tab.file, { agentId, at: this.now() })
        handedBack.push(tab.file)
        why[tab.file] = 'only read; kept open for a while in case its app is restarting'
        continue
      }
      if (!wrote(tab.file) && !kept(tab.file) && !watched) {
        // A session whose app is gone has no calls of its own to wait for, and
        // one stuck call must not keep its tab owned by nobody for ever.
        const close = () => this.deps.closeTab(tab.file)
        const shut = await (by === 'lost' || by === 'app' ? close() : this.inTurn(tab.file, close)).catch(() => false)
        if (shut) { closed.push(tab.file); continue }
      }
      this.deps.handBack(tab.file, agent)
      handedBack.push(tab.file)
      why[tab.file] = wrote(tab.file) ? 'you changed it' : kept(tab.file) ? 'you asked to keep it' : watched ? 'only read, but the person is looking at it, so it was not closed under them' : 'only read, but it could not be closed just now'
    }
    this.deps.roster.settle(agentId, handedBack, closed)
    return {
      ended: true, handedBack, closed, why,
      note: 'The session is finished. PDFs you changed are now the person\'s own tabs; PDFs you only read were closed, except any the person had on screen (`why` says, per PDF). A new job starts with redbeam_start_session.',
    }
  }

  /**
   * An AI app's server saying it is still there. `servers` adds the earlier
   * servers whose sessions it took over after a restart (mcp.rs).
   */
  private alive(params: Record<string, unknown>): Record<string, unknown> | null {
    const server = line(params['server'])
    if (server !== null) this.aliveAt.set(server, this.now())
    if (Array.isArray(params['servers'])) {
      for (const s of params['servers']) { const one = line(s); if (one !== null) this.aliveAt.set(one, this.now()) }
    }
    return this.deps.isMain ? { ok: true } : null
  }

  /** Tabs handed back from `agent` that the person has not opened: its own again. */
  private reclaimTabs(agent: Agent): void {
    if (this.deps.reclaim === undefined) return
    for (const t of this.deps.tabs()) {
      if (t.owner === undefined && t.handed?.agentId === agent.id) this.deps.reclaim(t.file, agent.id)
    }
  }

  /**
   * Finish the sessions of any AI app whose server was saying it was alive
   * and has stopped: killed, crashed or hung. Called on the window's tick.
   */
  sweep(): void {
    const now = this.now()
    // The window itself was stalled: nobody could have reached it, so start everyone's clock again.
    if (this.lastSweep !== null && now - this.lastSweep > STALL_MS) {
      for (const server of this.aliveAt.keys()) this.aliveAt.set(server, now)
    }
    this.lastSweep = now
    for (const [file, l] of [...this.lingering]) {
      const tab = tabFor(this.deps.tabs(), file)
      const agent = this.deps.roster.agent(l.agentId)
      // Taken back by its session, or opened by the person: theirs now, not ours to close.
      if (tab === undefined || tab.owner !== undefined || tab.handed?.agentId !== l.agentId || agent?.state !== 'gone') {
        this.lingering.delete(file)
        continue
      }
      if (now - l.at < LOST_GRACE_MS) continue
      const showing = this.deps.showing()
      if (showing !== null && samePath(showing, file)) { this.lingering.delete(file); continue }
      this.lingering.delete(file)
      void this.deps.closeTab(file).then((shut) => { if (shut) this.deps.roster.settle(l.agentId, [], [file]) }, () => undefined)
    }
    for (const [server, at] of [...this.aliveAt]) {
      if (now - at < LOST_AFTER_MS) continue
      this.aliveAt.delete(server)
      for (const a of this.deps.roster.get().agents) {
        if (a.state !== 'gone' && a.id.startsWith(`${server}/`)) void this.endSession(a.id, 'lost', null, [])
      }
    }
  }

  // -------------------------------------------------------------- state --

  /** What an agent needs to know about the window beyond the PDF it asked about. */
  private about(agent: Agent | null, file: string | null): Record<string, unknown> {
    const tabs = this.deps.tabs()
    const showing = this.deps.showing()
    const name = (owner: string | undefined) => (owner === undefined ? 'person' : owner === agent?.id ? 'you' : (this.deps.roster.agent(owner)?.name ?? 'another agent'))
    return {
      tabs: tabs.map((t) => t.file),
      // Only the tabs an agent opened: the rest are the person's, and a window
      // with sixty of them said so sixty times in every answer.
      tabOwners: tabs.filter((t) => t.owner !== undefined).map((t) => ({ file: t.file, owner: name(t.owner) })),
      personShowing: showing,
      ...(agent === null ? {} : {
        agent: {
          name: agent.name,
          colour: agent.color.name,
          tabs: agentTabs(tabs, agent.id).map((t) => t.file),
          ...(file !== null ? { drives: tabFor(tabs, file)?.owner === agent.id } : {}),
        },
      }),
    }
  }

  private nothingOpen(agent: Agent | null): Record<string, unknown> {
    return {
      file: null,
      pageCount: 0,
      appVersion: this.deps.appVersion,
      note: 'No PDF is open. Open one with redbeam_open_file (wait:true).',
      ...this.about(agent, null),
    }
  }
}

/** One line of the agent's own words, or null. */
function line(v: unknown): string | null {
  const t = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''
  return t === '' ? null : t.length > 160 ? `${t.slice(0, 159)}…` : t
}

function nameOf(path: string): string {
  return path.replace(/\\/g, '/').replace(/^.*\//, '')
}
