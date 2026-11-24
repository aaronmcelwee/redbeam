/**
 * The window: a start screen, or PDFs open as tabs.
 *
 * REDBEAM is a PDF viewer that does takeoffs, and the takeoff is saved inside
 * each PDF. Aaron, 2026-11-24: "lets retire pro mode altogether" — projects,
 * their database and bidding rounds no longer have a way in from here, from
 * Settings or from an AI agent (bridge/methods.rs).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ProjectStartScreen, useProject } from './project/index.js'
import { closeThisWindow, getWindowRole, guardWindowClose, isTauri } from './tauri/window.js'
import { useWindowControls } from './tauri/useWindowControls.js'
import Workspace from './Workspace.js'
import { WindowControls } from './shell/Shell.js'
import { ShellHarness } from './shell/ShellHarness.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { UpdateOffer } from './update/UpdateOffer.js'
import { WhatsNewHost } from './whatsnew/WhatsNew.js'
import { setBeforeQuit } from './update/session.js'
import { forgetFile, recentFiles, rememberFile } from './project/recentFiles.js'
import { projectBridge } from './project/bridge.js'
import { SESSION_LIMIT, lightFileOf, readSession, samePath, stepTab, withoutTab, withTab, writeSession, type LightFile } from './lightTabs.js'
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
  /** What the open workspace must finish before this window closes (Light: save into the PDF). */
  const beforeCloseRef = useRef<((leave: () => void) => Promise<boolean>) | null>(null)
  /** The listener that holds the window open while a file needs saving first. */
  const closeGuardRef = useRef<Promise<() => Promise<void>> | null>(null)
  const closeAskingRef = useRef(false)
  /** Close for real: stop holding the window, then close it. */
  const closeNow = useCallback(() => {
    const guard = closeGuardRef.current
    closeGuardRef.current = null
    void (guard === null ? Promise.resolve() : guard.then((stop) => stop()))
      .catch(() => undefined)
      .then(() => closeThisWindow())
  }, [])
  /**
   * Every close goes through here: the X button, Alt+F4, the taskbar,
   * Windows shutting down. Light saves into the PDF first, and stays open
   * (asking) when that save is refused.
   */
  const requestClose = useCallback(() => {
    const before = beforeCloseRef.current
    if (before === null) { closeNow(); return }
    if (closeAskingRef.current) return
    closeAskingRef.current = true
    void before(closeNow)
      .then((ok) => { if (ok) closeNow() }, closeNow)
      .finally(() => { closeAskingRef.current = false })
  }, [closeNow])
  const registerBeforeClose = useCallback((fn: ((leave: () => void) => Promise<boolean>) | null) => {
    beforeCloseRef.current = fn
    // An update that installs or restarts ends the app without closing the window.
    setBeforeQuit(fn)
    if (fn !== null && closeGuardRef.current === null) {
      closeGuardRef.current = guardWindowClose(requestClose)
    } else if (fn === null && closeGuardRef.current !== null) {
      const guard = closeGuardRef.current
      closeGuardRef.current = null
      void guard.then((stop) => stop())
    }
  }, [requestClose])
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
  const [quick, setQuick] = useState<LightFile | null>(null)
  const quickRef = useRef(quick)
  quickRef.current = quick
  /**
   * LIGHT: the PDFs open in this window, as tabs (lightTabs.ts). `quick` is
   * the one showing; the rest hold nothing that is not already in their files.
   */
  const [tabs, setTabs] = useState<LightFile[]>([])
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  /** Tabs closed this session, newest last: what Ctrl+Shift+T brings back. */
  const closedTabsRef = useRef<string[]>([])
  /** Save the showing file into its PDF, then `go`. Stays put when the save is refused and the person keeps the file. */
  const leaveThen = useCallback((go: () => void) => {
    const before = beforeCloseRef.current
    if (before === null) { go(); return }
    void before(go).then((ok) => { if (ok) go() }, go)
  }, [])

  const closeProject = useCallback(() => {
    setQuick(null)
    setTabs([])
    setFiles(recentFiles())
    project.close()
  }, [project])

  /** A drawing, picked or dropped: it opens as a tab, or comes forward if it is one. */
  const showDrawing = useCallback((pick: { path: string | null }) => {
    if (pick.path === null) return
    /*
     * The PDF is the record, so it opens on its own even when it sits in an
     * old project folder: an old project's takeoff moves into its PDFs as
     * they open (export/oldProject.ts).
     */
    rememberFile(pick.path)
    setFiles(recentFiles())
    setQuickNote(null)
    const path = pick.path
    const f = tabsRef.current.find((t) => samePath(t.file, path)) ?? lightFileOf(path)
    const now = quickRef.current
    if (now === null) { setTabs((t) => withTab(t, f)); setQuick(f); return }
    if (samePath(now.file, f.file)) return
    // Another PDF opens beside this one: save this one first, as leaving does.
    leaveThen(() => { setTabs((t) => withTab(withTab(t, now), f)); setQuick(f) })
  }, [leaveThen])

  const viewDrawing = useCallback(() => {
    void project.viewDrawing().then((pick) => { if (pick !== null) showDrawing(pick) })
  }, [project, showDrawing])

  /** A dropped path: a PDF opens; anything else is told what REDBEAM opens. */
  const dropPath = useCallback((path: string) => {
    if (/\.pdf$/i.test(path)) { void project.locateFile(path).then((pick) => { if (pick !== null) showDrawing(pick) }); return }
    setQuickNote('REDBEAM opens PDFs. Open a drawing from that folder instead; if the folder was a REDBEAM project, its takeoff moves into the PDFs as they are opened.')
  }, [project, showDrawing])

  /** Light: show another open tab, saving the one left first. */
  const selectTab = useCallback((file: string) => {
    const f = tabsRef.current.find((t) => samePath(t.file, file))
    const now = quickRef.current
    if (f === undefined || (now !== null && samePath(now.file, file))) return
    leaveThen(() => setQuick(f))
  }, [leaveThen])
  /** Light: close a tab. The one showing is saved first, and its neighbour shows; the last goes to the start page. */
  const closeTab = useCallback((file: string) => {
    const remember = () => {
      closedTabsRef.current = [...closedTabsRef.current.filter((f) => !samePath(f, file)), file].slice(-SESSION_LIMIT)
    }
    const now = quickRef.current
    if (now === null || !samePath(now.file, file)) {
      remember()
      setTabs((t) => withoutTab(t, file, null).tabs)
      return
    }
    leaveThen(() => {
      remember()
      const { tabs: rest, next } = withoutTab(tabsRef.current, file, file)
      if (next === null) { closeProject(); return }
      setTabs(rest)
      setQuick(next)
    })
  }, [leaveThen, closeProject])
  /** Light: Ctrl+Tab and Ctrl+Shift+Tab. */
  const stepTabBy = useCallback((step: 1 | -1) => {
    const now = quickRef.current
    if (now === null) return
    const next = stepTab(tabsRef.current, now.file, step)
    if (next !== null) selectTab(next.file)
  }, [selectTab])
  /** Light: Ctrl+Shift+T brings back the tab closed last. */
  const reopenTab = useCallback(() => {
    const file = closedTabsRef.current.pop()
    if (file !== undefined) dropPath(file)
  }, [dropPath])

  const [quickNote, setQuickNote] = useState<string | null>(null)

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
    setTabs(found)
    setQuick(found.find((f) => active !== null && samePath(f.file, active)) ?? found[0]!)
  }, [])
  useEffect(() => {
    if (!sessionReadyRef.current || identity.role !== 'main') return
    writeSession({ files: tabs.map((t) => t.file), active: quick?.file ?? null })
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
  useEffect(() => {
    if (identity.role === 'context') return
    let stop: (() => void) | undefined
    let cancelled = false
    void onOpenFile((path) => {
      const now = showingRef.current
      if (now.idle || now.takesTabs) { dropPath(path); return }
      // Say what is really here first: the app marked this window as taken
      // by the new file when it sent it.
      void reportShowing(now.idle, now.file).then(() => openElsewhere(path))
    }).then((un) => { if (cancelled) un(); else stop = un })
    return () => { cancelled = true; stop?.() }
  }, [dropPath, identity.role])

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

  if (quick !== null) {
    return (
      <>
        {controls}
        {/* Keyed on the file, so a broken one closed and another opened gets a fresh boundary. */}
        <ErrorBoundary key={`boundary-view:${quick.file}`} onCloseProject={closeProject}>
          <Workspace
            key={`view:${quick.file}`}
            projectPath={quick.folder}
            onCloseProject={closeProject}
            onRecentsChanged={project.refreshRecents}
            onBeforeClose={registerBeforeClose}
            initialDocumentPath={quick.relativePath}
            quickView={{
              file: quick.file, relativePath: quick.relativePath,
              // Light never asks for a project folder: the PDF is the record.
              onAdopt: () => undefined,
              light: true,
              ...(project.desktop ? { onOpenAnother: viewDrawing } : {}),
              tabs: {
                list: tabs.map((t) => ({ file: t.file, name: t.relativePath })),
                onSelect: selectTab, onClose: closeTab, onStep: stepTabBy,
                onReopen: reopenTab,
              },
            }}
          />
        </ErrorBoundary>
        <UpdateOffer desktop={isTauri()} />
        <WhatsNewHost auto={identity.role !== 'context'} />
      </>
    )
  }

  return (
    <>
    {controls}
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
      {...(project.desktop ? { onViewDrawing: viewDrawing, onDropPath: dropPath } : {})}
      // exactOptionalPropertyTypes: an optional prop must be absent, not
      // explicitly undefined — so this is spread in rather than passed as null.
      {...(project.desktop ? { onBrowse: project.browse } : {})}
      busy={project.busy}
      busyPath={project.busyPath}
      error={quickNote ?? project.error}
      notice={
        project.desktop
          ? null
          : 'Running in a browser, so there are no file dialogs — type a folder ' +
            'path. Full-text search and multi-window are desktop-only.'
      }
    />
    <UpdateOffer desktop={isTauri()} />
    <WhatsNewHost auto={identity.role !== 'context'} />
    </>
  )
}
