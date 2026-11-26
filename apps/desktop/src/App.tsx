/**
 * The window: a start screen, or PDFs open as tabs.
 *
 * REDBEAM is a PDF viewer that does takeoffs, and the takeoff is saved inside
 * each PDF. Aaron, 2026-11-24: "lets retire pro mode altogether" — projects,
 * their database and bidding rounds no longer have a way in from here, from
 * Settings or from an AI agent (bridge/methods.rs).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ProjectStartScreen, useProject } from './project/index.js'
import { destroyThisWindow, getWindowRole, guardWindowClose, isTauri } from './tauri/window.js'
import { useWindowControls } from './tauri/useWindowControls.js'
import Workspace from './Workspace.js'
import { WindowControls } from './shell/Shell.js'
import { ShellHarness } from './shell/ShellHarness.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { UpdateChip } from './update/UpdateChip.js'
import { WhatsNewHost } from './whatsnew/WhatsNew.js'
import { setBeforeQuit } from './update/session.js'
import { forgetFile, recentFiles, rememberFile } from './project/recentFiles.js'
import { projectBridge } from './project/bridge.js'
import {
  lightFileOf, nextOwnTab, ownTabs, readSession, samePath, stepOwnTab, tabFor, withHanded, withOwner,
  withoutTab, withTab, writeSession, type LightFile,
} from './lightTabs.js'
import { bridgeHosts, UNNAMED_CALL, useBridgeListener } from './bridge/useBridgeRequests.js'
import { BridgeRouter } from './agents/router.js'
import { roster } from './agents/roster.js'
import { AgentsOnStart, type AgentTabItem } from './agents/AgentTabs.js'
import { sleepers, type LiveUse } from './agents/live.js'
import { APP_VERSION } from './update/updates.js'
import {
  choosePdfHandler, defaultOfferDismissed, dismissDefaultOffer, onOpenFile, openElsewhere,
  reportShowing, takeLaunchFile, usePdfHandlerStatus,
} from './tauri/openWith.js'

export default function App() {
  const identity = useMemo(() => getWindowRole(), [])

  /*
   * `?harness=shell` renders the chrome against fixture data with no project,
   * no database and no PDF. It exists because the shell only assembles after a
   * project is open and a page has rendered, which makes "is this spacing
   * right" a five-minute round trip through a real 110-sheet set.
   */
  if (new URLSearchParams(location.search).get('harness') === 'shell') {
    return <ShellHarness />
  }
  const [files, setFiles] = useState(() => recentFiles())

  /*
   * The window draws its own frame, so it also draws its own controls. They
   * mount here rather than inside the title bar because the start screen has no
   * title bar and a frameless window still has to be closable from it.
   */
  const win = useWindowControls()
  /**
   * What each mounted PDF must finish before it goes (Light: save into the
   * PDF), by file. Several are mounted at once now: the one showing, and the
   * ones agents are working in behind it.
   */
  const beforeRef = useRef(new Map<string, (leave: () => void, opts?: { closing?: boolean }) => Promise<boolean>>())
  /**
   * The listener that hears every close of this window. One, for the
   * window's whole life: it used to come and go with the open file, and a
   * close that arrived while it was coming back was held by nobody.
   */
  const closeGuardRef = useRef<Promise<() => Promise<void>> | null>(null)
  const closeAskingRef = useRef(false)
  const closingRef = useRef(false)
  /** Close for real: the window goes without being asked again. */
  const closeNow = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    const guard = closeGuardRef.current
    const stop = () => (guard === null ? Promise.resolve() : guard.then((s) => s()))
    void destroyThisWindow(stop).then((gone) => { if (!gone) closingRef.current = false })
  }, [])
  /** Set below, once the tabs exist: save every mounted PDF, then say whether the window may go. */
  const saveAllRef = useRef<(leave: () => void, opts?: { closing?: boolean }) => Promise<boolean>>(() => Promise.resolve(true))
  /**
   * Every close goes through here: the X button, Alt+F4, the taskbar,
   * Windows shutting down. Light saves into the PDF first, and stays open
   * (asking) when that save is refused or is slow to answer.
   */
  const requestClose = useCallback(() => {
    // Already saving to close: that save asks within seconds if it cannot finish.
    if (closeAskingRef.current) return
    closeAskingRef.current = true
    // `closing`: only a closing window asks while a slow save runs (Workspace saveBeforeLeaving).
    void saveAllRef.current(closeNow, { closing: true })
      .then((ok) => { if (ok) closeNow() }, (err: unknown) => {
        console.error('[window] saving before close failed; closing.', err)
        closeNow()
      })
      .finally(() => { closeAskingRef.current = false })
  }, [closeNow])
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose
  useEffect(() => {
    const guard = guardWindowClose(() => requestCloseRef.current())
    closeGuardRef.current = guard
    return () => {
      if (closeGuardRef.current === guard) closeGuardRef.current = null
      void guard.then((stop) => stop())
    }
  }, [])
  useEffect(() => {
    // An update that installs or restarts ends the app without closing the window.
    setBeforeQuit((leave) => saveAllRef.current(leave))
    return () => setBeforeQuit(null)
  }, [])
  useEffect(() => {
    document.documentElement.toggleAttribute('data-frameless', win.frameless)
  }, [win.frameless])

  // For its file dialogs and lookups: nothing here opens a project.
  const project = useProject({})


  /**
   * QUICK VIEW: a drawing open with no project behind it.
   *
   * Aaron, 2026-09-18: opening a drawing set "should not create a project
   * instantly. It should just open the file for quick viewing. If any markup
   * actions need to be taken it should prompt the user to select the file's
   * project folder first." So a picked or dropped PDF that no job already
   * holds opens here, in memory; one that a job holds opens that job.
   */
  const [quick, setQuickState] = useState<LightFile | null>(null)
  const quickRef = useRef(quick)
  /**
   * LIGHT: the PDFs open in this window, as tabs (lightTabs.ts). `quick` is
   * the one showing. The person's other tabs hold nothing that is not
   * already in their files; an agent's tabs stay live behind it (`live`).
   */
  const [tabs, setTabsState] = useState<LightFile[]>([])
  const tabsRef = useRef(tabs)
  /**
   * The PDFs mounted behind the one showing, each with an agent at work in
   * it (agents/live.ts). Aaron, 2026-11-24: "MULTIPLE agents ... ALONGSIDE a
   * human ... human working in 2-3 tabs, then collapsed tab groups showing
   * different agents with their own environments".
   */
  const [live, setLiveState] = useState<string[]>([])
  const liveRef = useRef(live)
  /** When each background PDF was last called for. A ref: a call must not re-render the window. */
  const usedRef = useRef(new Map<string, number>())
  /*
   * The refs are written with the state, not on the next render: a bridge
   * call that opens a tab and one that asks for it a millisecond later must
   * see the same list.
   */
  const setQuick = useCallback((next: LightFile | null) => { quickRef.current = next; setQuickState(next) }, [])
  const setTabs = useCallback((next: LightFile[] | ((t: LightFile[]) => LightFile[])) => {
    const value = typeof next === 'function' ? next(tabsRef.current) : next
    tabsRef.current = value
    setTabsState(value)
  }, [])
  const setLive = useCallback((next: (l: string[]) => string[]) => {
    const value = next(liveRef.current)
    if (value.length === liveRef.current.length && value.every((f, i) => f === liveRef.current[i])) return
    liveRef.current = value
    setLiveState(value)
  }, [])
  const isLive = useCallback((file: string) => liveRef.current.some((f) => samePath(f, file)), [])
  /** Tabs closed this session, newest last: what Ctrl+Shift+T brings back. */
  const closedTabsRef = useRef<string[]>([])

  /** Save `file` into its PDF the way leaving it does, then `go`. Stays put when the save is refused and the person keeps the file. */
  const saveThen = useCallback((file: string, go: () => void) => {
    const before = beforeRef.current.get(foldPath(file))
    if (before === undefined) { go(); return }
    void before(go).then((ok) => { if (ok) go() }, go)
  }, [])
  /**
   * Save a PDF mounted behind the one showing, with nothing put on screen.
   * False when the PDF does not hold everything afterwards (open in another
   * app, or slow): its tab then stays as it is.
   */
  const quietSave = useCallback(async (file: string, withinMs: number): Promise<boolean> => {
    const host = bridgeHosts.get(file)
    if (host === undefined) return true
    const out = await Promise.race([
      Promise.resolve(host.invoke('save', {}, UNNAMED_CALL)).catch((): Record<string, unknown> => ({ saved: false })),
      new Promise<Record<string, unknown>>((resolve) => setTimeout(() => resolve({ saved: false }), withinMs)),
    ])
    // Still opening, or it never opened: there is no takeoff in it to lose.
    if (typeof out['error'] === 'string' && /no document is open/i.test(out['error'])) return true
    return out['saved'] === true
  }, [])

  /** Every tab gone: back to the start page. */
  const closeProject = useCallback(() => {
    setQuick(null)
    setTabs([])
    setLive(() => [])
    setFiles(recentFiles())
    project.close()
  }, [project, setQuick, setTabs, setLive])

  /**
   * Whether an agent is at work in `file`: it is an agent's tab, or one was
   * called for in it in the last couple of minutes. Such a PDF stays live
   * when the person leaves it, so the agent's next call finds it as it was.
   */
  const agentsUse = useCallback((file: string) => {
    const tab = tabFor(tabsRef.current, file)
    if (tab === undefined) return false
    if (tab.owner !== undefined && roster.agent(tab.owner)?.state !== 'gone') return true
    return Date.now() - (usedRef.current.get(foldPath(file)) ?? 0) < 120_000
  }, [])

  /** Show a tab. The one left is saved first, unless it stays live behind the new one. */
  const showTab = useCallback((f: LightFile) => {
    const now = quickRef.current
    if (now !== null && samePath(now.file, f.file)) return
    // Opened: it is no longer news that a session handed it back.
    if (f.handed !== undefined) setTabs((t) => withHanded(t, f.file, null))
    if (now !== null && !isLive(now.file) && agentsUse(now.file)) setLive((l) => [...l, now.file])
    if (now === null || isLive(now.file)) { setQuick(f); return }
    saveThen(now.file, () => setQuick(f))
  }, [isLive, saveThen, setQuick, agentsUse, setLive, setTabs])

  /**
   * Drawings, picked or dropped: each opens as a tab, or comes forward if it
   * is one. The first is the one shown; the rest wait as tabs, holding
   * nothing until they are shown (Kenneth, 2026-11-26: several picked at once).
   */
  const showDrawings = useCallback((paths: readonly string[]) => {
    if (paths.length === 0) return
    /*
     * The PDF is the record, so it opens on its own even when it sits in an
     * old project folder: an old project's takeoff moves into its PDFs as
     * they open (export/oldProject.ts).
     */
    for (const p of [...paths].reverse()) rememberFile(p)
    setFiles(recentFiles())
    setQuickNote(null)
    const [path, ...rest] = paths as [string, ...string[]]
    const behind = rest.filter((p) => tabFor(tabsRef.current, p) === undefined).map(lightFileOf)
    const addBehind = (t: LightFile[]) => behind.reduce((acc, f) => withTab(acc, f), t)
    const open = tabFor(tabsRef.current, path)
    // Already a tab, the person's or an agent's: it comes forward as it is.
    if (open !== undefined) {
      if (behind.length > 0) setTabs(addBehind)
      showTab(open)
      return
    }
    const f = lightFileOf(path)
    const now = quickRef.current
    const add = () => { setTabs((t) => addBehind(withTab(t, f))); setQuick(f) }
    if (now !== null && !isLive(now.file) && agentsUse(now.file)) setLive((l) => [...l, now.file])
    if (now === null || isLive(now.file)) { add(); return }
    // Another PDF opens beside this one: save this one first, as leaving does.
    saveThen(now.file, add)
  }, [showTab, isLive, saveThen, setTabs, setQuick, agentsUse, setLive])
  const showDrawing = useCallback((pick: { path: string | null }) => {
    if (pick.path !== null) showDrawings([pick.path])
  }, [showDrawings])

  const viewDrawing = useCallback(() => {
    void project.viewDrawing().then(showDrawings)
  }, [project, showDrawings])

  /** A dropped path: a PDF opens; anything else is told what REDBEAM opens. */
  const dropPath = useCallback((path: string) => {
    if (/\.pdf$/i.test(path)) { void project.locateFile(path).then((pick) => { if (pick !== null) showDrawing(pick) }); return }
    setQuickNote('REDBEAM opens PDFs. Open a drawing from that folder instead; if the folder was a REDBEAM project, its takeoff moves into the PDFs as they are opened.')
  }, [project, showDrawing])
  /** Several dropped at once: every PDF among them opens as a tab, the first one shown. */
  const dropPaths = useCallback((paths: readonly string[]) => {
    const pdfs = paths.filter((p) => /\.pdf$/i.test(p))
    if (pdfs.length === 0) { if (paths[0] !== undefined) dropPath(paths[0]); return }
    void Promise.all(pdfs.map((p) => project.locateFile(p))).then((picks) => {
      showDrawings(picks.flatMap((pick) => (pick?.path ?? null) === null ? [] : [pick!.path!]))
    })
  }, [project, dropPath, showDrawings])

  /** Light: show another open tab, saving the one left first. */
  const selectTab = useCallback((file: string) => {
    const f = tabFor(tabsRef.current, file)
    if (f !== undefined) showTab(f)
  }, [showTab])

  /** Take a tab away, with nothing left to save. The person's own neighbour shows when it was the one showing. */
  const dropTab = useCallback((file: string) => {
    const tab = tabFor(tabsRef.current, file)
    if (tab === undefined) return
    // An agent's tab is not what Ctrl+Shift+T is for: the person did not open it.
    if (tab.owner === undefined) {
      closedTabsRef.current = [...closedTabsRef.current.filter((f) => !samePath(f, file)), file]
    }
    usedRef.current.delete(foldPath(file))
    setLive((l) => l.filter((f) => !samePath(f, file)))
    const showing = quickRef.current !== null && samePath(quickRef.current.file, file)
    const next = showing ? nextOwnTab(tabsRef.current, file) : null
    const rest = withoutTab(tabsRef.current, file, null).tabs
    if (rest.length === 0) { closeProject(); return }
    setTabs(rest)
    if (showing) {
      setQuick(next)
      // The person's last tab closed and only agents' are left: the start page, with them listed.
      if (next === null) setFiles(recentFiles())
    }
  }, [closeProject, setLive, setTabs, setQuick])

  /**
   * Light: close a tab. It is saved first: the one showing as leaving it
   * does, one behind it quietly. Resolves false when it stayed open because
   * its PDF could not take the save.
   */
  const closeTab = useCallback((file: string, by: 'person' | 'agent' = 'person'): Promise<boolean> => {
    const tab = tabFor(tabsRef.current, file)
    if (tab === undefined) return Promise.resolve(true)
    const showing = quickRef.current !== null && samePath(quickRef.current.file, file)
    if (showing) {
      return new Promise((resolve) => {
        const before = beforeRef.current.get(foldPath(file))
        if (before === undefined) { dropTab(file); resolve(true); return }
        const go = () => { dropTab(file); resolve(true) }
        void before(go).then((ok) => { if (ok) go(); else resolve(false) }, go)
      })
    }
    if (!isLive(file)) { dropTab(file); return Promise.resolve(true) }
    return quietSave(file, 15_000).then((saved) => {
      if (saved) { dropTab(file); return true }
      // The person closing it is shown why it will not close; an agent is told.
      if (by === 'person') { showTab(tab); setTimeout(() => saveThen(file, () => dropTab(file)), 300) }
      return false
    })
  }, [dropTab, isLive, quietSave, showTab, saveThen])
  const closeTabByPerson = useCallback((file: string) => { void closeTab(file, 'person') }, [closeTab])

  /** Light: Ctrl+Tab and Ctrl+Shift+Tab, through the person's own tabs. */
  const stepTabBy = useCallback((step: 1 | -1) => {
    const now = quickRef.current
    if (now === null) return
    const next = stepOwnTab(tabsRef.current, now.file, step)
    if (next !== null) selectTab(next.file)
  }, [selectTab])
  /** Light: Ctrl+Shift+T brings back the tab closed last. */
  const reopenTab = useCallback(() => {
    const file = closedTabsRef.current.pop()
    if (file !== undefined) dropPath(file)
  }, [dropPath])

  const [quickNote, setQuickNote] = useState<string | null>(null)

  // ------------------------------------------------------------ agents --

  /** Keep `file` mounted behind the one showing, and note that it was just called for. */
  const wake = useCallback((file: string) => {
    usedRef.current.set(foldPath(file), Date.now())
    if (quickRef.current !== null && samePath(quickRef.current.file, file)) return
    if (tabFor(tabsRef.current, file) === undefined) return
    setLive((l) => (l.some((f) => samePath(f, file)) ? l : [...l, file]))
  }, [setLive])

  /** Hand a tab to an agent, or back to the person. A tab an agent drives stays live. */
  const setOwner = useCallback((file: string, owner: string | null) => {
    setTabs((t) => withOwner(t, file, owner))
    if (owner !== null) wake(file)
  }, [setTabs, wake])

  const router = useMemo(() => new BridgeRouter({
    tabs: () => tabsRef.current,
    showing: () => quickRef.current?.file ?? null,
    isMain: identity.role === 'main',
    host: (file) => bridgeHosts.get(file),
    wake,
    openForAgent: async (path, agentId) => {
      const found = await projectBridge.locateFile(path).then((o) => o.path, () => null)
      if (found === null) return `${path} could not be opened`
      const open = tabFor(tabsRef.current, found)
      if (open !== undefined) { wake(open.file); return open }
      const f: LightFile = { ...lightFileOf(found), owner: agentId }
      rememberFile(found)
      setTabs((t) => withTab(t, f))
      wake(f.file)
      return f
    },
    openForPerson: (path) => dropPathRef.current(path),
    closeTab: (file) => closeTab(file, 'agent'),
    setOwner,
    handBack: (file, agent) => {
      const showing = quickRef.current !== null && samePath(quickRef.current.file, file)
      setTabs((t) => {
        const mine = withOwner(t, file, null)
        // To the end of the person's strip; one they are looking at needs no mark.
        const tab = tabFor(mine, file)
        const rest = mine.filter((x) => !samePath(x.file, file))
        const moved = tab === undefined ? mine : [...rest, tab]
        return showing ? moved : withHanded(moved, file, { by: agent.name, color: agent.color.bright, agentId: agent.id })
      })
    },
    reclaim: (file, agentId) => {
      setTabs((t) => withHanded(withOwner(t, file, agentId), file, null))
      wake(file)
    },
    roster,
    appVersion: APP_VERSION,
  // The router lives as long as the window; what it calls reads refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [])
  useBridgeListener(useCallback((req) => router.answer(req), [router]))

  /** Let go of background PDFs nobody is calling for: saved first, tabs kept (agents/live.ts). */
  useEffect(() => {
    const timer = setInterval(() => {
      roster.tick()
      router.sweep()
      const uses: LiveUse[] = liveRef.current.map((file) => ({ file, usedAt: usedRef.current.get(foldPath(file)) ?? 0 }))
      const busy = (file: string) => roster.get().agents.some((a) => a.activity?.busy === true && a.activity.file !== null && samePath(a.activity.file, file))
      // A PDF a live session drives, or is a guest in, stays: the session is still working in it.
      const held = (file: string) => {
        const owner = tabFor(tabsRef.current, file)?.owner
        return roster.get().agents.some((a) => a.state !== 'gone' && (a.id === owner || a.guestIn.some((f) => samePath(f, file))))
      }
      for (const file of sleepers(uses, { now: Date.now(), busy, held })) {
        void quietSave(file, 15_000).then((saved) => {
          // Called for again while it saved, or not saved: it stays live.
          if (!saved || busy(file) || held(file) || Date.now() - (usedRef.current.get(foldPath(file)) ?? 0) < 5000) return
          setLive((l) => l.filter((f) => !samePath(f, file)))
        })
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [quietSave, setLive, router])

  /*
   * Closing the window: every mounted PDF is saved, the one showing first.
   * One behind it that cannot be saved is brought up, so its question is on
   * screen rather than asked where nobody can see it.
   */
  saveAllRef.current = (leave, opts) => {
    const showing = quickRef.current?.file ?? null
    const order = [...(showing === null ? [] : [showing]), ...liveRef.current.filter((f) => showing === null || !samePath(f, showing))]
    const step = async (i: number): Promise<boolean> => {
      const file = order[i]
      if (file === undefined) return true
      const resume = () => { void step(i + 1).then((ok) => { if (ok) leave() }) }
      const ask = async (): Promise<boolean> => {
        const before = beforeRef.current.get(foldPath(file))
        if (before === undefined) return step(i + 1)
        return (await before(resume, opts)) ? step(i + 1) : false
      }
      if (showing !== null && samePath(file, showing)) return ask()
      if (await quietSave(file, 6000)) return step(i + 1)
      const tab = tabFor(tabsRef.current, file)
      if (tab === undefined) return step(i + 1)
      setQuick(tab)
      await new Promise((r) => setTimeout(r, 300))
      return ask()
    }
    return step(0)
  }

  /**
   * A window asked to view a file from outside — `?view=<path>` in its URL,
   * the road a "redbeam://open" link or a shell association will take. The
   * same road a drop takes, so it lands in a job or in quick view alike.
   */
  const viewedFromUrl = useRef(false)
  /** The main window's tabs are written for next time only once last time's are back. */
  const sessionReadyRef = useRef(false)
  const restoreTabs = useCallback(async () => {
    const saved = readSession()
    const found: LightFile[] = []
    for (const file of saved.files) {
      // Gone since (moved, renamed, a drive not mounted): left out, said nowhere.
      const there = await projectBridge.locateFile(file).then((o) => o.path !== null, () => false)
      if (there) found.push(lightFileOf(file))
    }
    if (found.length === 0 || quickRef.current !== null) return
    const active = saved.active
    // An agent may have opened tabs already: the person's come back before them.
    setTabs((t) => [...found.filter((f) => tabFor(t, f.file) === undefined), ...t])
    setQuick(found.find((f) => active !== null && samePath(f.file, active)) ?? found[0]!)
  }, [setTabs, setQuick])
  useEffect(() => {
    if (!sessionReadyRef.current || identity.role !== 'main') return
    // The person's own tabs: an agent's are its work, not where they were.
    const own = ownTabs(tabs)
    const active = quick !== null && own.some((t) => samePath(t.file, quick.file)) ? quick.file : (own[0]?.file ?? null)
    writeSession({ files: own.map((t) => t.file), active })
  }, [tabs, quick, identity.role])
  useEffect(() => {
    if (viewedFromUrl.current || !project.desktop) return
    viewedFromUrl.current = true
    const wanted = new URLSearchParams(location.search).get('view')
    if (wanted !== null && wanted !== '') { dropPath(wanted); return }
    if (identity.role === 'main' && identity.projectId === null) {
      void (async () => {
        // Light: the tabs open when this window last changed tabs come back.
        await restoreTabs()
        sessionReadyRef.current = true
        // Started by double-clicking a PDF, or by Open with: the first window
        // opens it (open_with.rs keeps the path until asked), as another tab.
        const path = await takeLaunchFile()
        if (path !== null) dropPath(path)
      })()
    }
  }, [project.desktop, dropPath, identity, restoreTabs])

  /*
   * A PDF opened from Explorer while REDBEAM is running. The app sends it
   * here only while this window says it is on the start screen; if a file
   * opened in the meantime, it goes back to be opened in another window.
   */
  const idle = quick === null && identity.projectId === null
  // Light takes another PDF as a tab, so a window with tabs is never "taken".
  const tabFiles = useMemo(() => tabs.map((t) => t.file), [tabs])
  const showingRef = useRef({ idle, file: quick?.file ?? null, takesTabs: tabFiles.length > 0 })
  showingRef.current = { idle, file: quick?.file ?? null, takesTabs: tabFiles.length > 0 }
  useEffect(() => {
    if (identity.role === 'context') return
    void reportShowing(idle, quick?.file ?? null, tabFiles)
  }, [idle, quick, tabFiles, identity.role])
  /*
   * Listened for once. `dropPath` is new on every render, and listening again
   * each time left gaps in which a file sent here was dropped: an AI app's
   * open_file straight after a tab closed never opened.
   */
  const dropPathRef = useRef(dropPath)
  dropPathRef.current = dropPath
  useEffect(() => {
    if (identity.role === 'context') return
    let stop: (() => void) | undefined
    let cancelled = false
    void onOpenFile((path) => {
      const now = showingRef.current
      if (now.idle || now.takesTabs) { dropPathRef.current(path); return }
      // Say what is really here first: the app marked this window as taken
      // by the new file when it sent it.
      void reportShowing(now.idle, now.file).then(() => openElsewhere(path))
    }).then((un) => { if (cancelled) un(); else stop = un })
    return () => { cancelled = true; stop?.() }
  }, [identity.role])

  /* Offer to become the default PDF viewer, once the installer has registered REDBEAM. */
  const handler = usePdfHandlerStatus()
  const [offerDismissed, setOfferDismissed] = useState(() => defaultOfferDismissed())
  const defaultViewerOffer = handler.registered && !handler.isDefault && !offerDismissed
    ? {
        onChoose: () => { void choosePdfHandler().catch((e: unknown) => setQuickNote(String(e))) },
        onDismiss: () => { dismissDefaultOffer(); setOfferDismissed(true) },
      }
    : undefined


  const controls = win.frameless
    ? (
      <WindowControls
        maximized={win.maximized}
        onMinimize={win.minimize}
        onToggleMaximize={win.toggleMaximize}
        // Light keeps its takeoff only in the PDF: save it before the window goes.
        onClose={requestClose}
      />
      )
    : null

  /*
   * Each mounted PDF is told the same handlers for the life of the window:
   * a workspace is eleven thousand lines, and one that re-rendered whenever
   * the window did would re-render for every agent call in every other tab.
   */
  const handlersRef = useRef({ selectTab, closeTabByPerson, stepTabBy, reopenTab, viewDrawing, dropTab, refreshRecents: project.refreshRecents })
  handlersRef.current = { selectTab, closeTabByPerson, stepTabBy, reopenTab, viewDrawing, dropTab, refreshRecents: project.refreshRecents }
  const stable = useMemo(() => ({
    onSelect: (file: string) => handlersRef.current.selectTab(file),
    onClose: (file: string) => handlersRef.current.closeTabByPerson(file),
    onStep: (step: 1 | -1) => handlersRef.current.stepTabBy(step),
    onReopen: () => handlersRef.current.reopenTab(),
    onOpenAnother: () => handlersRef.current.viewDrawing(),
    onDrop: (file: string) => handlersRef.current.dropTab(file),
    onRecentsChanged: () => { void handlersRef.current.refreshRecents() },
    onBeforeClose: (file: string, fn: ((leave: () => void) => Promise<boolean>) | null) => {
      if (fn === null) beforeRef.current.delete(foldPath(file))
      else beforeRef.current.set(foldPath(file), fn)
    },
    onTakeOver: (file: string) => setOwner(file, null),
    onEndSession: (agentId: string) => { void router.endSession(agentId, 'person', null, []) },
    onDismissSession: (agentId: string) => roster.forget(agentId),
    onReopenFile: (file: string) => dropPathRef.current(file),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [])
  const tabList = useMemo(
    () => tabs.map((t) => ({
      file: t.file, name: t.relativePath,
      ...(t.owner !== undefined ? { owner: t.owner } : {}),
      ...(t.handed !== undefined ? { handed: t.handed } : {}),
    })),
    [tabs],
  )

  /** The PDFs with a workspace: the one showing and the ones live behind it, in tab order so none moves in the page. */
  const mounted = tabs.filter((t) => (quick !== null && samePath(t.file, quick.file)) || live.some((f) => samePath(f, t.file)))

  return (
    <>
      {controls}
      {mounted.map((t) => (
        <LiveWorkspace
          key={`view:${foldPath(t.file)}`}
          tab={t}
          showing={quick !== null && samePath(t.file, quick.file)}
          tabList={tabList}
          desktop={project.desktop}
          handlers={stable}
        />
      ))}
      {quick === null && (
        <>
          <ProjectStartScreen
            mode="light"
            {...(defaultViewerOffer !== undefined ? { defaultViewerOffer } : {})}
            recents={files}
            // A typed path takes the same road as a dropped one.
            onOpenPath={(path) => dropPath(path)}
            onOpenRecent={(p) => void project.locateFile(p.path).then((pick) => {
              if (pick !== null) showDrawing(pick)
              else setQuickNote(`${p.path} could not be opened. It may have moved; right-click it to take it off the list.`)
            })}
            onForgetRecent={(p) => { forgetFile(p.path); setFiles(recentFiles()) }}
            {...(project.desktop ? { onViewDrawing: viewDrawing, onDropPath: dropPath, onDropPaths: dropPaths } : {})}
            // exactOptionalPropertyTypes: an optional prop must be absent, not
            // explicitly undefined — so this is spread in rather than passed as null.
            {...(project.desktop ? { onBrowse: project.browse } : {})}
            busy={project.busy}
            busyPath={project.busyPath}
            footerExtra={<UpdateChip desktop={isTauri()} />}
            error={quickNote ?? project.error}
            notice={
              project.desktop
                ? null
                : 'Running in a browser, so there are no file dialogs — type a folder ' +
                  'path. Full-text search and multi-window are desktop-only.'
            }
          />
          {/* Agents at work while the person has nothing open: their tabs, to look in on. */}
          <AgentsOnStart tabs={tabList} onSelect={stable.onSelect} onClose={stable.onClose} />
        </>
      )}
      <WhatsNewHost auto={identity.role !== 'context'} />
    </>
  )
}

/** Windows paths: case and slash direction do not make a different file. */
function foldPath(file: string): string {
  return file.replace(/\//g, '\\').toLowerCase()
}

interface WorkspaceHandlers {
  onSelect: (file: string) => void
  onClose: (file: string) => void
  onStep: (step: 1 | -1) => void
  onReopen: () => void
  onOpenAnother: () => void
  onDrop: (file: string) => void
  onRecentsChanged: () => void
  onBeforeClose: (file: string, fn: ((leave: () => void) => Promise<boolean>) | null) => void
  onTakeOver: (file: string) => void
  onEndSession: (agentId: string) => void
  onDismissSession: (agentId: string) => void
  onReopenFile: (file: string) => void
}

/**
 * One open PDF: showing, or live behind the one that is.
 *
 * A PDF behind the one showing is laid out at the window's size, so its
 * canvas renders and an agent's screenshot of it is a real one, but it is
 * not drawn, takes no pointer and cannot hold the keyboard (`inert`): the
 * person's keys and clicks go to the tab they are in, and nothing an agent
 * does behind it can take them.
 */
const LiveWorkspace = memo(function LiveWorkspace({
  tab, showing, tabList, desktop, handlers,
}: {
  tab: LightFile
  showing: boolean
  tabList: AgentTabItem[]
  desktop: boolean
  handlers: WorkspaceHandlers
}) {
  const { file, folder, relativePath } = tab
  const onBeforeClose = useCallback(
    (fn: ((leave: () => void) => Promise<boolean>) | null) => handlers.onBeforeClose(file, fn),
    [handlers, file],
  )
  // This PDF's boundary closes this tab; the others carry on.
  const closeThis = useCallback(() => handlers.onDrop(file), [handlers, file])
  const quickView = useMemo(() => ({
    file, relativePath,
    // Light never asks for a project folder: the PDF is the record.
    onAdopt: () => undefined,
    light: true,
    ...(desktop ? { onOpenAnother: handlers.onOpenAnother } : {}),
    tabs: {
      list: tabList,
      onSelect: handlers.onSelect, onClose: handlers.onClose, onStep: handlers.onStep,
      onReopen: handlers.onReopen,
      onTakeOver: handlers.onTakeOver,
      onEndSession: handlers.onEndSession, onDismissSession: handlers.onDismissSession, onReopenFile: handlers.onReopenFile,
    },
  }), [file, relativePath, desktop, tabList, handlers])
  return (
    <div className="wshost" data-showing={showing ? 'true' : 'false'} {...(showing ? {} : { inert: '' })} aria-hidden={!showing}>
      {/* Keyed on the file, so a broken one closed and another opened gets a fresh boundary. */}
      <ErrorBoundary key={`boundary-view:${file}`} onCloseProject={closeThis}>
        <Workspace
          projectPath={folder}
          onCloseProject={closeThis}
          onRecentsChanged={handlers.onRecentsChanged}
          onBeforeClose={onBeforeClose}
          initialDocumentPath={relativePath}
          showing={showing}
          quickView={quickView}
        />
      </ErrorBoundary>
    </div>
  )
})
