/**
 * The project gate.
 *
 * A window IS a project (docs/DECISIONS.md, and the window model in
 * docs/PLAN.md). Nothing below this point runs until one is open, because the
 * database, the undo stack and every id in the workspace belong to a project —
 * there is no meaningful "no project" state to render a takeoff in.
 *
 * A context window is handed its project through the URL rather than the start
 * screen: it is a second view onto a project that is already open, so showing
 * it a picker would be wrong.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ProjectStartScreen, useProject, type RecentProject } from './project/index.js'
import { NestingChoice } from './project/NestingChoice.js'
import { closeThisWindow, getWindowRole, guardWindowClose, isTauri, openProjectWindow } from './tauri/window.js'
import { useWindowControls } from './tauri/useWindowControls.js'
import Workspace from './Workspace.js'
import { WindowControls } from './shell/Shell.js'
import { ShellHarness } from './shell/ShellHarness.js'
import { ErrorBoundary } from './ErrorBoundary.js'
import { SettingsStore, browserStorage } from './settings/store.js'
import { visibleRecents } from './project/recents.js'
import { UpdateOffer } from './update/UpdateOffer.js'
import { setBeforeQuit } from './update/session.js'
import { PRO_AVAILABLE, readMode, writeMode, type AppMode } from './light.js'
import { forgetFile, recentFiles, rememberFile } from './project/recentFiles.js'
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
  const [openPath, setOpenPath] = useState<string | null>(null)

  /*
   * Light or Pro (Settings › General, and the switch on the start screen).
   * Read again whenever the window is back on the start screen, because the
   * settings page that changes it lives inside the workspace.
   */
  const [mode, setMode] = useState<AppMode>(() => readMode())
  const light = mode === 'light'
  const [files, setFiles] = useState(() => recentFiles())
  const changeMode = useCallback((next: AppMode) => {
    writeMode(next)
    setMode(next)
  }, [])

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

  const project = useProject({
    onOpened: (info) => {
      // useProject does not touch the database — it hands us the location and
      // lets the workspace open it. If that throws, useProject leaves the
      // project closed with an error rather than claiming it is open.
      setOpenPath(info.path)
    },
  })

  /**
   * The automation bridge asks to open a project by emitting an event, and it
   * is handled HERE — the same state change the picker makes.
   *
   * The bridge deliberately does not open the store itself: that would give
   * the window one project and the database another, which is the split-brain
   * the store moved into Rust to prevent. Routing through the UI keeps one
   * path, so a bridge-opened project behaves identically to a clicked one.
   */
  useEffect(() => {
    if (!isTauri()) return
    let stop: (() => void) | undefined
    let cancelled = false
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event')
      const un = await listen<{ path?: string }>('redbeam://bridge/open-project', (e) => {
        const path = e.payload?.path
        // Through `project.open`, the same road the picker takes. A folder
        // inside an existing project asks whether to open the parent or the
        // folder itself before anything opens a database.
        if (typeof path === 'string' && path.length > 0) void project.open(path)
      })
      if (cancelled) un()
      else stop = un
    })()
    return () => { cancelled = true; stop?.() }
  }, [project.open])

  /**
   * Reopen the last project on launch — when asked to.
   *
   * This reopened the last project unconditionally, on the reasoning that the
   * start screen "is not a toll gate on every start". Kenneth's first bug of
   * the 2026-09-10 review was exactly that toll gate's absence: the app opens
   * on whatever job was open last, and an estimator with six bids on the go
   * wants to be asked. So the start screen is the default and the old
   * behaviour is a setting, `general.restoreProjectWindows`, off unless
   * turned on. The last project is the first row of the start screen either
   * way.
   *
   * Only a live entry qualifies — a `missing: true` recent means the folder
   * moved or a drive is offline, and silently failing to open it would look
   * like a broken launch. Runs once: `attempted` guards against re-opening
   * after a deliberate Close Project, which would make closing impossible.
   */
  const attempted = useRef(false)
  useEffect(() => {
    if (attempted.current || identity.role === 'context') return
    /*
     * A window told which project to open never falls back to the last one.
     *
     * Without this, asking for a second project opened a window that ignored
     * the project in its own URL and reopened the most recent one instead — so
     * "open another project" produced a second window showing the project you
     * already had open, which looks exactly like the command doing nothing.
     */
    if (identity.projectId !== null) return
    if (project.loading || openPath !== null) return
    attempted.current = true
    if (readMode() === 'light') return
    if (!SettingsStore.open(browserStorage()).bool('general.restoreProjectWindows')) return
    const last = project.recents.find((p) => !p.missing)
    if (last !== undefined) void project.openRecent(last)
  }, [project, identity.role, openPath])
  /*
   * The lists show the newest N, less the expired, from Settings › General.
   * Re-read whenever the list or the open project changes: the panel that
   * changes these lives inside the project, and leaving it is the moment the
   * start screen is next seen.
   */
  const shownRecents = useMemo(() => {
    const store = SettingsStore.open(browserStorage())
    return visibleRecents(project.recents, store.int('general.recentProjectLimit'), store.str('general.recentExpiry'))
  }, [project.recents, openPath])

  /*
   * A window opened FOR a project opens that project, whatever its role.
   *
   * This was gated on `role === 'context'`, so a context window inherited its
   * project and a second PROJECT window silently did not: the id sat unread in
   * its own URL while the reopen-on-launch path opened the most recent project
   * over the top of it. Both kinds of window are handed a project the same
   * way; only the picker differs, and neither of them should see one here.
   */
  const openedFromUrl = useRef(false)
  useEffect(() => {
    if (openedFromUrl.current) return
    if (identity.projectId === null || openPath !== null) return
    openedFromUrl.current = true
    // A context window is a second view of a project already chosen. A project
    // window handed a folder still asks when that folder sits inside another.
    if (identity.role === 'context') void project.open(identity.projectId, { own: true })
    else void project.open(identity.projectId)
  }, [identity.projectId, identity.role, openPath, project.open])

  /**
   * QUICK VIEW: a drawing open with no project behind it.
   *
   * Aaron, 2026-09-18: opening a drawing set "should not create a project
   * instantly. It should just open the file for quick viewing. If any markup
   * actions need to be taken it should prompt the user to select the file's
   * project folder first." So a picked or dropped PDF that no job already
   * holds opens here, in memory; one that a job holds opens that job.
   */
  const [quick, setQuick] = useState<{ folder: string; file: string; relativePath: string } | null>(null)
  /** The document to open first once a project comes up — the drawing that was just viewed or picked. */
  const [firstDocument, setFirstDocument] = useState<string | null>(null)

  const closeProject = useCallback(() => {
    setOpenPath(null)
    setQuick(null)
    setFirstDocument(null)
    setMode(readMode())
    setFiles(recentFiles())
    project.close()
  }, [project])

  /** A drawing, picked or dropped: the job that holds it, or quick view. */
  const showDrawing = useCallback((pick: { path: string | null; project: { path: string; hasDatabase: boolean } | null; relativePath: string | null }) => {
    if (pick.path === null) return
    /*
     * Light: the PDF is the record, so it opens on its own even when it sits
     * in a job folder with a project. A takeoff saved there in Pro is already
     * inside the PDF, because Pro embeds it on every leave.
     */
    if (readMode() === 'light') {
      rememberFile(pick.path)
      setFiles(recentFiles())
      const cut = Math.max(pick.path.lastIndexOf('\\'), pick.path.lastIndexOf('/'))
      setQuickNote(null)
      setQuick({ folder: pick.path.slice(0, cut), file: pick.path, relativePath: pick.path.slice(cut + 1) })
      return
    }
    if (pick.project !== null && pick.project.hasDatabase && pick.relativePath !== null) {
      setFirstDocument(pick.relativePath)
      void project.open(pick.project.path)
      return
    }
    const cut = Math.max(pick.path.lastIndexOf('\\'), pick.path.lastIndexOf('/'))
    const folder = pick.path.slice(0, cut)
    const name = pick.path.slice(cut + 1)
    setQuick({ folder, file: pick.path, relativePath: name })
  }, [project])

  const viewDrawing = useCallback(() => {
    void project.viewDrawing().then((pick) => { if (pick !== null) showDrawing(pick) })
  }, [project, showDrawing])

  /** A dropped path: a PDF is viewed, a folder is opened as a job. */
  const dropPath = useCallback((path: string) => {
    if (/\.pdf$/i.test(path)) { void project.locateFile(path).then((pick) => { if (pick !== null) showDrawing(pick) }); return }
    if (readMode() === 'light') {
      setQuickNote(PRO_AVAILABLE
        ? 'Light mode opens PDFs. To open a project folder, switch to Pro at the bottom of this screen.'
        : 'REDBEAM opens PDFs. Open a drawing from that folder instead; if the folder was a REDBEAM project, its takeoff moves into the PDFs as they are opened.')
      return
    }
    void project.open(path, { create: false })
  }, [project, showDrawing])

  /**
   * Quick view's way out: the drawing's project folder. It has to contain the
   * drawing — a project cannot hold a file outside itself — and then the job
   * opens on that drawing, created if the folder had no database yet.
   */
  const adoptProject = useCallback(() => {
    if (quick === null) return
    void (async () => {
      const outcome = await project.browse()
      if (outcome.path === null) return
      const folder = outcome.path.replace(/[\\/]+$/, '')
      const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
      if (!norm(quick.file).startsWith(`${norm(folder)}\\`)) {
        setQuickNote(`${folder} does not contain this drawing. Choose the folder the drawing is in, or one above it.`)
        return
      }
      const rel = quick.file.slice(folder.length + 1).replace(/\\/g, '/')
      setFirstDocument(rel)
      await project.open(folder, { create: true })
      setQuick(null)
    })()
  }, [project, quick])
  const [quickNote, setQuickNote] = useState<string | null>(null)

  /**
   * A window asked to view a file from outside — `?view=<path>` in its URL,
   * the road a "redbeam://open" link or a shell association will take. The
   * same road a drop takes, so it lands in a job or in quick view alike.
   */
  const viewedFromUrl = useRef(false)
  useEffect(() => {
    if (viewedFromUrl.current || !project.desktop) return
    viewedFromUrl.current = true
    const wanted = new URLSearchParams(location.search).get('view')
    if (wanted !== null && wanted !== '') { dropPath(wanted); return }
    // Started by double-clicking a PDF, or by Open with: the first window
    // opens it (open_with.rs keeps the path until asked).
    if (identity.role === 'main' && identity.projectId === null) {
      void takeLaunchFile().then((path) => { if (path !== null) dropPath(path) })
    }
  }, [project.desktop, dropPath, identity])

  /*
   * A PDF opened from Explorer while REDBEAM is running. The app sends it
   * here only while this window says it is on the start screen; if a file
   * opened in the meantime, it goes back to be opened in another window.
   */
  const idle = openPath === null && quick === null && identity.projectId === null
  const showingRef = useRef({ idle, file: quick?.file ?? null })
  showingRef.current = { idle, file: quick?.file ?? null }
  useEffect(() => {
    if (identity.role === 'context') return
    void reportShowing(idle, quick?.file ?? null)
  }, [idle, quick, identity.role])
  useEffect(() => {
    if (identity.role === 'context') return
    let stop: (() => void) | undefined
    let cancelled = false
    void onOpenFile((path) => {
      const now = showingRef.current
      if (now.idle) { dropPath(path); return }
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

  /** A recent job that moved: pick where it went, open it there, and forget the stale entry. */
  const locateRecent = useCallback((recent: RecentProject) => {
    void (async () => {
      const outcome = await project.browse()
      if (outcome.path === null) return
      await project.open(outcome.path)
      void project.forget(recent)
    })()
  }, [project])

  /**
   * Open another project in a SECOND window, leaving this one alone.
   *
   * A window is a project — its database, its undo stack and every id in the
   * workspace belong to it — so there is no in-place switch to make; "switch"
   * would mean tearing all of that down. It is also what an estimator comparing
   * two bid packages actually wants, which is both of them on screen.
   *
   * The label is the project path, so asking for a project that is already open
   * focuses that window instead of duplicating it.
   */
  const openProjectElsewhere = useCallback((path: string) => {
    void openProjectWindow(path, `project-${path}`)
  }, [])

  /** Pick a folder, then open it in a second window. */
  const browseForProject = useCallback(() => {
    void (async () => {
      const outcome = await project.browse()
      if (outcome.path !== null) openProjectElsewhere(outcome.path)
    })()
  }, [project, openProjectElsewhere])

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

  const nestingDialog = project.nesting === null ? null : (
    <NestingChoice
      parentName={project.nesting.parentName}
      onParent={() => project.chooseNesting('parent')}
      onOwn={() => project.chooseNesting('own')}
      onCancel={project.dismissNesting}
    />
  )

  if (openPath || quick !== null) {
    const path = openPath ?? quick!.folder
    // Keyed on the path so switching projects tears the workspace down rather
    // than leaving one project's markups in another's state.
    return (
      <>
        {controls}
        {nestingDialog}
        {/*
          Keyed on the path as well, so closing a broken project and opening
          another gets a fresh boundary rather than the old error.
        */}
        <ErrorBoundary key={`boundary-${openPath ?? `view:${quick?.file}`}`} onCloseProject={closeProject}>
          <Workspace
            key={openPath ?? `view:${quick?.file}`}
            projectPath={path}
            onCloseProject={closeProject}
            {...(quick !== null && openPath === null && light
              ? {}
              : { recentProjects: shownRecents, onOpenProject: openProjectElsewhere })}
            {...(project.desktop && openPath ? { onBrowseProject: browseForProject, onRevealProject: () => void project.reveal(openPath) } : {})}
            onRenameProject={(name) => {
              const mine = project.recents.find((r) => r.path === openPath)
              if (mine !== undefined) void project.rename(mine, name)
            }}
            onRecentsChanged={project.refreshRecents}
            onBeforeClose={registerBeforeClose}
            initialDocumentPath={openPath ? (firstDocument ?? identity.documentPath) : quick!.relativePath}
            {...(openPath === null && quick !== null
              ? {
                  quickView: {
                    file: quick.file, relativePath: quick.relativePath, onAdopt: adoptProject,
                    ...(light ? { light: true, ...(project.desktop ? { onOpenAnother: viewDrawing } : {}) } : {}),
                  },
                }
              : {})}
          />
        </ErrorBoundary>
        <UpdateOffer desktop={isTauri()} />
      </>
    )
  }

  return (
    <>
    {controls}
    {nestingDialog}
    <ProjectStartScreen
      mode={mode}
      {...(PRO_AVAILABLE ? { onModeChange: changeMode } : {})}
      {...(defaultViewerOffer !== undefined ? { defaultViewerOffer } : {})}
      recents={light ? files : shownRecents}
      onOpenPath={(path, options) => project.open(path, options)}
      onOpenRecent={light
        ? (p) => void project.locateFile(p.path).then((pick) => {
            if (pick !== null) showDrawing(pick)
            else setQuickNote(`${p.path} could not be opened. It may have moved; right-click it to take it off the list.`)
          })
        : (p) => void project.openRecent(p)}
      onForgetRecent={light
        ? (p) => { forgetFile(p.path); setFiles(recentFiles()) }
        : (p) => void project.forget(p)}
      {...(light ? {} : {
        onOpenRecentElsewhere: (p: RecentProject) => openProjectElsewhere(p.path),
        onRenameRecent: (p: RecentProject, name: string) => void project.rename(p, name),
      })}
      {...(project.desktop
        ? {
            ...(light ? {} : {
              onRemoveData: (p: RecentProject) => void project.removeData(p),
              onRevealRecent: (p: RecentProject) => void project.reveal(p.path),
              onLocateRecent: locateRecent,
            }),
            onViewDrawing: viewDrawing,
            onDropPath: dropPath,
          }
        : {})}
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
    </>
  )
}
