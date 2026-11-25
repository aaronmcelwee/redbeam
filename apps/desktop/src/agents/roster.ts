/**
 * The AI agents at work in this window, and what each is doing.
 *
 * Aaron, 2026-11-24: "done is when agents can work in parallel with humans
 * ... i want visibility into agent actions. different agents different
 * colors, with colored cursors with a tooltip by the cursor describing
 * actions."
 *
 * An agent is one AI app's connection (one `REDBEAM.exe --mcp` process), or
 * one named worker inside it when several share a connection and pass
 * `agent`. Each gets a name ("Claude", "Claude 2", "ChatGPT"), a colour that
 * stays its own for the session, the PDFs it opened (its tabs, lightTabs.ts)
 * and a cursor on the sheet it is working on.
 *
 * Pure arithmetic and one small store. App.tsx feeds it from the bridge; the
 * tab strip and the cursor layer read it.
 */

/** Who a bridge call came from, as the MCP server reports it. */
export interface AgentIdentity {
  /** Stable for the life of the agent: the server's session, plus its `agent` name when it gave one. */
  id: string
  /** The MCP client's own name: "claude-ai", "claude-code", "codex-mcp-client". */
  client?: string
  /** What the agent calls itself, when several share one connection. */
  label?: string
}

export interface AgentColor {
  /** A plain word, for a tooltip or a screen reader. */
  name: string
  /** The deep tone: the group's underline and washes, and text-sized marks on the window's own ground. */
  fill: string
  /**
   * The bright tone: the cursor on the sheet, its label, the dot and the
   * count on the chip. Aaron, 2026-11-24: "brightly colored cursors". A
   * drawing is black line on white paper, and a cursor has to be found on it
   * at a glance from across the sheet.
   */
  bright: string
  /** The ink that reads on `bright` at 4.5:1 or better: near black on the light ones, white on the rest. */
  on: string
}

/**
 * Eight colours an estimator will not confuse with one another or with the
 * grey of a tab at rest. The bright tones are Windows' own accent swatches,
 * so they sit with the rest of a Windows 11 desktop; none is the brand red,
 * which marks the person's own active tab.
 */
export const AGENT_COLORS: readonly AgentColor[] = [
  { name: 'violet', fill: '#7A52C7', bright: '#7C4DFF', on: '#FFFFFF' },
  { name: 'teal', fill: '#037B80', bright: '#00B7C3', on: '#10151A' },
  { name: 'orange', fill: '#B7470B', bright: '#FF8C00', on: '#10151A' },
  { name: 'blue', fill: '#0F6CBD', bright: '#1890FF', on: '#10151A' },
  { name: 'magenta', fill: '#B5309F', bright: '#E3008C', on: '#FFFFFF' },
  { name: 'green', fill: '#3F7305', bright: '#6BB700', on: '#10151A' },
  { name: 'gold', fill: '#8A6100', bright: '#FFB900', on: '#10151A' },
  { name: 'pink', fill: '#B0306A', bright: '#FF5C9E', on: '#10151A' },
]

/** Where on a sheet an agent last acted. Normalized [0,1], y down, as the bridge takes them. */
export interface AgentPoint { x: number; y: number }

export interface AgentActivity {
  /** What it is doing, as a person would say it: "Drawing an area". */
  text: string
  /** Epoch ms the call arrived. */
  at: number
  /** True while the call is still running. */
  busy: boolean
  /** The PDF the call was about. */
  file: string | null
  /** The sheet, zero-based, when the call named one. */
  page: number | null
  /** Where on that sheet. */
  point: AgentPoint | null
  /** Set when the call failed: the cursor says so rather than going quiet. */
  failed?: boolean
}

/**
 * working: a call within the last few seconds. idle: connected, quiet.
 * waiting: it stopped for the person's answer and said so. gone: finished.
 */
export type AgentState = 'working' | 'idle' | 'waiting' | 'gone'

/** How a session came to be finished. */
export type EndedBy = 'agent' | 'person' | 'app' | 'lost'

/** What a finished session leaves behind for the person to read. */
export interface SessionEnd {
  by: EndedBy
  at: number
  /** The session's own closing line, when it gave one. */
  summary: string | null
  /** PDFs handed to the person's tab strip: the ones it wrote in. */
  handedBack: readonly string[]
  /** PDFs it only read, closed with the group. One click reopens any. */
  closed: readonly string[]
}

export interface Agent {
  id: string
  /** The whole name, unique in the window: "ChatGPT · Nokia Canada North Campus takeoff". */
  name: string
  /** The AI app: "Claude", "ChatGPT". */
  app: string
  /** What this chat said it is doing, in its own words; null when it did not say. */
  task: string | null
  color: AgentColor
  state: AgentState
  /** What it stopped for, in its own words, while `state` is 'waiting'. */
  waitingFor: string | null
  /** Set once it is finished. */
  ended: SessionEnd | null
  /**
   * How it ended last time, kept when a later call brings it back. A session
   * that said "done, here is what I did" and then only looked around before
   * its app closed keeps that account, not "its app closed" (SLS, 2026-11-24).
   */
  lastEnd?: SessionEnd | null
  /** PDFs it changed: what goes back to the person when it finishes. */
  wrote: readonly string[]
  /** The person's PDFs it is working in as a guest. */
  guestIn: readonly string[]
  activity: AgentActivity | null
  /** The PDF its calls go to when they name none: the one it opened or addressed last. */
  current: string | null
  /** Epoch ms of its first and latest call. */
  since: number
  seenAt: number
  /** Whether its tabs are folded into one chip in the tab strip. */
  collapsed: boolean
}

/** A call this long ago still counts as "working": agents think between calls. */
export const WORKING_MS = 12_000

// ---------------------------------------------------------------- names --

/** What to call an MCP client. Unknown clients keep their own name, tidied. */
export function clientName(client: string | undefined): string {
  const c = (client ?? '').trim().toLowerCase()
  if (c === '') return 'AI agent'
  if (c.includes('claude-code') || c.includes('claude code')) return 'Claude Code'
  if (c.includes('claude')) return 'Claude'
  if (c.includes('codex')) return 'Codex'
  if (c.includes('chatgpt') || c.includes('openai')) return 'ChatGPT'
  if (c.includes('cursor')) return 'Cursor'
  if (c.includes('gemini')) return 'Gemini'
  if (c.includes('copilot') || c.includes('vscode') || c.includes('visual studio code')) return 'Copilot'
  const tidy = (client ?? '').trim().replace(/[-_]+/g, ' ').replace(/\s*(mcp|client)\b/gi, '').trim()
  return tidy === '' ? 'AI agent' : tidy.slice(0, 24)
}

/** What a session said it is doing, tidied to one line a chip can carry. */
export function sessionTask(who: AgentIdentity): string | null {
  const t = (who.label ?? '').trim().replace(/\s+/g, ' ').replace(/\s+session$/i, '')
  return t === '' ? null : t.length > 60 ? `${t.slice(0, 59)}…` : t
}

/**
 * A name nobody else in the window has: "Claude", then "Claude 2".
 * An agent that named itself is "Claude · framing" so two workers of one app
 * can be told apart by what they said they are.
 */
export function agentName(who: AgentIdentity, taken: readonly string[]): string {
  const base = clientName(who.client)
  const label = sessionTask(who) ?? ''
  const wanted = label === '' ? base : `${base} · ${label}`
  if (!taken.includes(wanted)) return wanted
  for (let n = 2; n < 1000; n++) {
    const next = `${wanted} ${n}`
    if (!taken.includes(next)) return next
  }
  return wanted
}

/** The first colour no live agent holds; when all eight are out, the one used least. */
export function nextColor(held: readonly AgentColor[]): AgentColor {
  const free = AGENT_COLORS.find((c) => !held.some((h) => h.fill === c.fill))
  if (free !== undefined) return free
  const counts = AGENT_COLORS.map((c) => held.filter((h) => h.fill === c.fill).length)
  return AGENT_COLORS[counts.indexOf(Math.min(...counts))]!
}

// ------------------------------------------------------------ describing --

const quote = (v: unknown, max = 32): string => {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

const KIND_WORDS: Record<string, string> = {
  area: 'an area', cutout: 'a cutout', polyline: 'a length', count: 'a count', shape: 'a shape',
  dimension: 'a dimension', text: 'a note',
}

/**
 * What a bridge call is, said the way the label by the cursor says it.
 * Present tense, no jargon, short enough to read in a glance. A call this
 * does not know is named from its action ("set_layout_preview" → "Set layout
 * preview"), so a new tool shows up as something rather than as nothing.
 */
export function describeCall(method: string, params: Record<string, unknown>): string {
  if (method === 'screenshot') return params['region'] !== undefined || params['rect'] !== undefined ? 'Looking closely at the sheet' : 'Looking at the sheet'
  if (method === 'get_ui_state' || method === 'get_state') return 'Checking what is open'
  if (method === 'query' || method === 'execute_query') return 'Reading the takeoff'
  if (method === 'open_file') return 'Opening a PDF'
  if (method !== 'invoke_ui_action') return humanize(method)
  const action = typeof params['action'] === 'string' ? params['action'] : ''
  const kind = typeof params['kind'] === 'string' ? params['kind'] : ''
  switch (action) {
    case 'go_to_page': return params['sheet'] !== undefined ? `Opening sheet ${quote(params['sheet'], 16)}` : 'Turning to another sheet'
    case 'list_sheets': return 'Reading the sheet list'
    case 'find_text': return `Searching for “${quote(params['query'], 24)}”`
    case 'get_words': return 'Reading the text on the sheet'
    case 'zoom_to_region': return 'Zooming in'
    case 'measure': return 'Measuring'
    case 'get_lines': return 'Reading the linework'
    case 'trace_area': return 'Tracing an outline'
    case 'detect_pattern': return 'Reading the drawn pattern'
    case 'read_scale': return 'Reading the scale'
    case 'set_page_scale': case 'set_calibration': case 'set_region_scale': return 'Setting the scale'
    case 'begin_scale_region': return 'Marking a scale region'
    case 'cancel_scale_region': case 'delete_scale_region': return 'Removing a scale region'
    case 'create_markup': return `Drawing ${KIND_WORDS[kind] ?? 'a markup'}`
    case 'create_markups': {
      const n = Array.isArray(params['markups']) ? params['markups'].length : 0
      return n > 1 ? `Drawing ${n} markups` : 'Drawing markups'
    }
    case 'create_dimension': return 'Drawing a dimension'
    case 'update_markup': return 'Reshaping a markup'
    case 'delete_markup': return 'Deleting a markup'
    case 'reassign_markup': return 'Moving a markup to another scope'
    case 'duplicate_markups': return 'Copying markups'
    case 'select_markups': return 'Selecting markups'
    case 'accept_imported': return 'Accepting imported markups'
    case 'create_scope': return params['label'] !== undefined ? `Adding scope “${quote(params['label'], 22)}”` : 'Adding a scope'
    case 'update_scope': return 'Editing a scope'
    case 'duplicate_scope': return 'Copying a scope'
    case 'archive_scope': return 'Archiving a scope'
    case 'commit_scope': return 'Committing a scope'
    case 'set_active_scope': return 'Choosing a scope'
    case 'set_scope_direction': case 'set_pattern_direction': return 'Setting the pattern direction'
    case 'set_pattern_origin': return 'Setting where the pattern starts'
    case 'get_pattern': return 'Reading the pattern'
    case 'describe_product': return 'Reading what a product needs'
    case 'get_bom': return 'Reading the parts list'
    case 'get_piece_list': return 'Reading the piece list'
    case 'list_markups': return 'Reading the markups'
    case 'list_scopes': return 'Reading the scopes'
    case 'list_annotations': return 'Reading the PDF’s own markups'
    case 'list_links': return 'Reading the links'
    case 'list_bookmarks': return 'Reading the bookmarks'
    case 'get_history': return 'Reading the change history'
    case 'get_settings': return 'Reading the settings'
    case 'set_setting': return 'Changing a setting'
    case 'get_scale_presets': return 'Reading the scale list'
    case 'track_addenda': return 'Checking the addenda'
    case 'import_scopes': return 'Bringing scopes in from another PDF'
    case 'rotate_pages': return 'Rotating sheets'
    case 'set_markup_visibility': return 'Showing or hiding markups'
    case 'set_layout_preview': return 'Previewing the layout'
    case 'open_panel': return 'Opening a panel'
    case 'set_tool': return 'Picking a tool'
    case 'save': return 'Saving into the PDF'
    case 'save_copy': return 'Saving a working copy'
    case 'export': return 'Exporting'
    case 'undo': return 'Undoing'
    case 'redo': return 'Redoing'
    case 'close_tab': return 'Closing a tab'
    case 'wait_for_person': return 'Waiting for you'
    case 'end_session': return 'Finishing'
    default: return humanize(action === '' ? method : action)
  }
}

function humanize(name: string): string {
  const words = name.replace(/^redbeam_/, '').replace(/[_-]+/g, ' ').trim()
  return words === '' ? 'Working' : words[0]!.toUpperCase() + words.slice(1)
}

/**
 * Where on the sheet a call acts, for the cursor: the last point drawn, the
 * middle of a box looked at, the point a trace started from. Null for a
 * call that is about no place (a save, a list).
 */
export function callPoint(params: Record<string, unknown>): AgentPoint | null {
  const parsed = (v: unknown): unknown => {
    if (typeof v !== 'string') return v
    try { return JSON.parse(v) } catch { return null }
  }
  const point = (v: unknown): AgentPoint | null => {
    const o = parsed(v)
    if (Array.isArray(o) && o.length >= 2) {
      const x = Number(o[0]), y = Number(o[1])
      return ok(x, y) ? { x, y } : null
    }
    if (typeof o !== 'object' || o === null) return null
    const x = Number((o as { x?: unknown }).x), y = Number((o as { y?: unknown }).y)
    return ok(x, y) ? { x, y } : null
  }
  const box = (v: unknown): AgentPoint | null => {
    const o = parsed(v)
    if (typeof o !== 'object' || o === null) return null
    const r = o as Record<string, unknown>
    const x0 = Number(r['x0']), y0 = Number(r['y0']), x1 = Number(r['x1']), y1 = Number(r['y1'])
    return ok(x0, y0) && ok(x1, y1) ? { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } : null
  }
  /** The last vertex of a ring, or of the first ring of several: where a hand drawing it would be. */
  const lastOf = (v: unknown): AgentPoint | null => {
    const o = parsed(v)
    if (!Array.isArray(o) || o.length === 0) return null
    const first = o[0]
    if (Array.isArray(first) && first.length > 0 && (Array.isArray(first[0]) || typeof first[0] === 'object')) return lastOf(first)
    for (let i = o.length - 1; i >= 0; i--) {
      const p = point(o[i])
      if (p !== null) return p
    }
    return null
  }
  for (const key of ['point', 'at', 'origin', 'seed', 'position', 'from']) {
    const p = point(params[key])
    if (p !== null) return p
  }
  for (const key of ['rings', 'ring', 'points', 'vertices', 'path']) {
    const p = lastOf(params[key])
    if (p !== null) return p
  }
  for (const key of ['region', 'rect', 'box']) {
    const p = box(params[key])
    if (p !== null) return p
  }
  // Many at once: the cursor goes to the last one drawn.
  const many = parsed(params['markups'])
  if (Array.isArray(many)) {
    for (let i = many.length - 1; i >= 0; i--) {
      const m = many[i]
      if (typeof m === 'object' && m !== null) {
        const p = callPoint(m as Record<string, unknown>)
        if (p !== null) return p
      }
    }
  }
  return null
}

function ok(x: number, y: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= -0.05 && x <= 1.05 && y >= -0.05 && y <= 1.05
}

const WRITES: ReadonlySet<string> = new Set([
  'create_markup', 'create_markups', 'create_dimension', 'update_markup', 'delete_markup', 'reassign_markup',
  'duplicate_markups', 'accept_imported', 'create_scope', 'update_scope', 'duplicate_scope', 'archive_scope',
  'commit_scope', 'set_scope_direction', 'set_pattern_direction', 'set_pattern_origin', 'set_page_scale',
  'set_calibration', 'set_region_scale', 'begin_scale_region', 'delete_scale_region', 'import_scopes',
  'rotate_pages', 'undo', 'redo',
])

/** Whether a call changes the takeoff in its PDF: what makes that PDF the session's work, not its reading. */
export function callWrites(method: string, params: Record<string, unknown>): boolean {
  return method === 'invoke_ui_action' && typeof params['action'] === 'string' && WRITES.has(params['action'])
}

/** The zero-based page a call names, when it names one by number. */
export function callPage(params: Record<string, unknown>): number | null {
  const v = params['page']
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN
  return Number.isInteger(n) && n >= 0 ? n : null
}

// ---------------------------------------------------------------- store --

export interface Roster {
  agents: readonly Agent[]
}

type Listener = () => void

/**
 * The roster, as a store React reads with useSyncExternalStore: a cursor
 * moves several times a second, and that must repaint a cursor, not an
 * eleven-thousand-line workspace.
 */
export class RosterStore {
  private state: Roster = { agents: [] }
  private readonly listeners = new Set<Listener>()
  private readonly now: () => number

  constructor(now: () => number = () => Date.now()) { this.now = now }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  get = (): Roster => this.state

  agent(id: string): Agent | undefined {
    return this.state.agents.find((a) => a.id === id)
  }

  /** The agent a call came from, added the first time it is seen. A returning one is no longer "gone". */
  see(who: AgentIdentity): Agent {
    const at = this.now()
    const known = this.agent(who.id)
    if (known !== undefined) {
      if (known.state !== 'gone') return known
      const back: Agent = { ...known, state: 'idle', ended: null, lastEnd: known.ended ?? known.lastEnd ?? null, seenAt: at }
      this.replace(back)
      return back
    }
    const live = this.state.agents.filter((a) => a.state !== 'gone')
    const added: Agent = {
      id: who.id,
      name: agentName(who, this.state.agents.map((a) => a.name)),
      app: clientName(who.client),
      task: sessionTask(who),
      color: nextColor(live.map((a) => a.color)),
      state: 'idle',
      waitingFor: null,
      ended: null,
      wrote: [],
      guestIn: [],
      activity: null,
      current: null,
      since: at,
      seenAt: at,
      collapsed: true,
    }
    this.set({ agents: [...this.state.agents, added] })
    return added
  }

  /** A call has started. */
  begin(id: string, activity: Omit<AgentActivity, 'at' | 'busy'>): void {
    const a = this.agent(id)
    if (a === undefined) return
    const at = this.now()
    // A call about no place leaves the cursor where the last one put it.
    const keep = a.activity !== null && activity.point === null && a.activity.file === activity.file
      && (activity.page === null || activity.page === a.activity.page)
    this.replace({
      ...a, state: 'working', waitingFor: null, seenAt: at,
      activity: {
        ...activity, at, busy: true,
        point: keep ? a.activity!.point : activity.point,
        page: keep && activity.page === null ? a.activity!.page : activity.page,
      },
    })
  }

  /** The call has answered. `where` is what the answer said about the sheet, when the call did not. */
  end(id: string, outcome: { failed: boolean; page?: number | null; point?: AgentPoint | null; file?: string | null }): void {
    const a = this.agent(id)
    if (a === undefined || a.activity === null) return
    this.replace({
      ...a, seenAt: this.now(),
      activity: {
        ...a.activity, busy: false,
        ...(outcome.failed ? { failed: true } : {}),
        ...(outcome.page !== undefined && outcome.page !== null ? { page: outcome.page } : {}),
        ...(outcome.point !== undefined && outcome.point !== null ? { point: outcome.point } : {}),
        ...(outcome.file !== undefined && outcome.file !== null ? { file: outcome.file } : {}),
      },
    })
  }

  setCurrent(id: string, file: string | null): void {
    const a = this.agent(id)
    if (a !== undefined && a.current !== file) this.replace({ ...a, current: file })
  }

  setCollapsed(id: string, collapsed: boolean): void {
    const a = this.agent(id)
    if (a !== undefined && a.collapsed !== collapsed) this.replace({ ...a, collapsed })
  }

  /** A call in `file`: remember whether it changed it, and whether the agent is a guest there. */
  touch(id: string, file: string, how: { wrote: boolean; guest: boolean }): void {
    const a = this.agent(id)
    if (a === undefined) return
    const has = (list: readonly string[]) => list.some((f) => fold(f) === fold(file))
    const wrote = how.wrote && !has(a.wrote) ? [...a.wrote, file] : a.wrote
    const guestIn = how.guest === has(a.guestIn) ? a.guestIn
      : how.guest ? [...a.guestIn, file] : a.guestIn.filter((f) => fold(f) !== fold(file))
    if (wrote !== a.wrote || guestIn !== a.guestIn) this.replace({ ...a, wrote, guestIn })
  }

  /** It has stopped for the person's answer. Its next call puts it back to work. */
  wait(id: string, forWhat: string | null): void {
    const a = this.agent(id)
    if (a === undefined || a.state === 'gone') return
    this.replace({
      ...a, state: 'waiting', waitingFor: forWhat, seenAt: this.now(),
      activity: a.activity === null ? null : { ...a.activity, busy: false },
    })
  }

  /**
   * The session is finished: it said so, the person ended it, its app closed,
   * or its app stopped answering. No cursor, no call in flight, nothing asked.
   */
  finish(id: string, end: Omit<SessionEnd, 'at'>): void {
    const a = this.agent(id)
    if (a === undefined || a.state === 'gone') return
    const prior = a.lastEnd ?? null
    this.replace({
      ...a, state: 'gone', waitingFor: null, guestIn: [], current: null,
      // Its app going away says nothing new: what it said when it finished stands.
      ended: end.summary === null && (end.by === 'app' || end.by === 'lost') && prior?.summary != null
        ? prior
        : { ...end, at: this.now() },
      activity: a.activity === null ? null : { ...a.activity, busy: false },
    })
  }

  /** Where a finished session's tabs went, once they are settled. */
  settle(id: string, handedBack: readonly string[], closed: readonly string[]): void {
    const a = this.agent(id)
    if (a === undefined || a.ended === null) return
    const both = (was: readonly string[], now: readonly string[]) => [...was, ...now.filter((f) => !was.includes(f))]
    this.replace({ ...a, ended: { ...a.ended, handedBack: both(a.ended.handedBack, handedBack), closed: both(a.ended.closed, closed) } })
  }

  /** Its app closed the connection. */
  leave(id: string): void {
    this.finish(id, { by: 'app', summary: null, handedBack: [], closed: [] })
  }

  /** Forget an agent that is gone and has no tabs left. */
  forget(id: string): void {
    if (this.agent(id) === undefined) return
    this.set({ agents: this.state.agents.filter((a) => a.id !== id) })
  }

  /** Working agents that have been quiet go idle. Returns ms until the next one would, or null. */
  tick(): number | null {
    const at = this.now()
    let next: number | null = null
    let changed = false
    const agents = this.state.agents.map((a) => {
      if (a.state !== 'working') return a
      if (a.activity?.busy === true) { next = Math.min(next ?? WORKING_MS, WORKING_MS); return a }
      const left = a.seenAt + WORKING_MS - at
      if (left <= 0) { changed = true; return { ...a, state: 'idle' as const } }
      next = Math.min(next ?? left, left)
      return a
    })
    if (changed) this.set({ agents })
    return next
  }

  private replace(next: Agent): void {
    this.set({ agents: this.state.agents.map((a) => (a.id === next.id ? next : a)) })
  }

  private set(next: Roster): void {
    this.state = next
    for (const fn of [...this.listeners]) fn()
  }
}

const fold = (file: string): string => file.replace(/\//g, '\\').toLowerCase()

/** This window's roster. */
export const roster = new RosterStore()

/** An agent's identity out of a bridge request, or null for a call with none (a test, an old server). */
export function identityOf(v: unknown): AgentIdentity | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const id = typeof o['id'] === 'string' ? o['id'].trim() : ''
  if (id === '') return null
  return {
    id: id.slice(0, 120),
    ...(typeof o['client'] === 'string' && o['client'].trim() !== '' ? { client: o['client'].trim().slice(0, 60) } : {}),
    ...(typeof o['label'] === 'string' && o['label'].trim() !== '' ? { label: o['label'].trim().slice(0, 60) } : {}),
  }
}
