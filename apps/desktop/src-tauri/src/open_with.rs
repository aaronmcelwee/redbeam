//! Opening a PDF from Windows: "Open with", the default PDF viewer, and a
//! second launch while REDBEAM is already running.
//!
//! The installer (windows/hooks.nsh) registers REDBEAM as a handler for .pdf:
//! a `REDBEAM.pdf` ProgID, an entry in `.pdf\OpenWithProgids`, and the
//! Capabilities / RegisteredApplications pair that puts REDBEAM in Settings ›
//! Apps › Default apps. Windows does not let an app make itself the default,
//! so the most the app can do is say whether it is, and open the page where
//! the person chooses.
//!
//! Explorer launches `REDBEAM.exe "C:\…\set.pdf"`. The first launch keeps the
//! path until the main window asks for it. A launch while REDBEAM is already
//! running is caught by the single-instance plugin, which hands the path to
//! [`route`]: the window already showing that file comes forward, a window on
//! the start screen opens it, a Light window takes it as another tab, and
//! otherwise it opens in a new window.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// The ProgID the installer registers. The Settings row compares the user's
/// choice for .pdf against it.
pub const PROG_ID: &str = "REDBEAM.pdf";
/// The name under `Software\RegisteredApplications`, which is also what the
/// Default apps page is opened to.
pub const REGISTERED_NAME: &str = "REDBEAM";
/// How an AI app's server starts REDBEAM (mcp.rs): never a reason to come forward.
pub const FROM_AI_APP: &str = "--from-ai-app";
/// The event a start-screen window receives to open a file.
pub const OPEN_EVENT: &str = "redbeam://open-file";

/// What a window is showing, as the window last reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Showing {
    /// The start screen: free to open whatever arrives.
    Idle,
    /// A file (or project) is open. The path is kept folded for comparison;
    /// None when the window has something open that is not a single file.
    Busy(Option<String>),
    /// Light: PDFs open as tabs, folded. The window takes another file as a
    /// new tab, and comes forward on one it already has.
    Tabs(Vec<String>),
}

impl Showing {
    fn has(&self, wanted: &str) -> bool {
        match self {
            Showing::Busy(Some(f)) => f == wanted,
            Showing::Tabs(files) => files.iter().any(|f| f == wanted),
            _ => false,
        }
    }
}

/// Which window a file goes to, and whether it must be told to open it: the
/// window already showing it, else one on the start screen, else a Light
/// window with tabs. The main window first each time, so a fresh start fills
/// the window on screen. None: a new window.
fn choose(map: &HashMap<String, Showing>, wanted: &str) -> Option<(String, bool)> {
    let mut windows: Vec<(&String, &Showing)> = map.iter().collect();
    windows.sort_by_key(|(l, _)| (l.as_str() != "main", l.as_str().to_string()));
    let pick = |f: &dyn Fn(&Showing) -> bool| windows.iter().find(|(_, s)| f(s)).map(|(l, s)| ((*l).clone(), *s));
    if let Some((label, s)) = pick(&|s| s.has(wanted)) {
        // A tab that is not the one showing still has to be switched to.
        return Some((label, matches!(s, Showing::Tabs(_))));
    }
    pick(&|s| *s == Showing::Idle)
        .or_else(|| pick(&|s| matches!(s, Showing::Tabs(_))))
        .map(|(label, _)| (label, true))
}

#[derive(Default)]
pub struct LaunchState {
    /// The PDF this process was started with, until a window takes it.
    pending: Mutex<Option<String>>,
    showing: Mutex<HashMap<String, Showing>>,
    windows: AtomicU32,
}

impl LaunchState {
    pub fn new(pending: Option<PathBuf>) -> Self {
        Self {
            pending: Mutex::new(pending.map(|p| p.display().to_string())),
            ..Self::default()
        }
    }
}

/// Windows paths compare without case, and either slash.
fn fold(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

/// The PDF named on a command line, if there is one.
///
/// `args` is the whole argv, program first. Switches are skipped; a relative
/// path resolves against `cwd` (a second launch reports its own). The file
/// must exist: a stale shortcut should start the app normally, not open on an
/// error.
pub fn pdf_from_args<I, S>(args: I, cwd: &Path) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().skip(1).find_map(|arg| {
        let arg = arg.as_ref().trim().trim_matches('"');
        if arg.is_empty() || arg.starts_with('-') {
            return None;
        }
        if !arg.to_ascii_lowercase().ends_with(".pdf") {
            return None;
        }
        let path = PathBuf::from(arg);
        let path = if path.is_absolute() { path } else { cwd.join(path) };
        path.is_file().then_some(path)
    })
}

/// The main window asks for the file the app was launched with, once.
#[tauri::command]
pub fn launch_take_file(window: WebviewWindow, state: State<'_, LaunchState>) -> Option<String> {
    // Only the first window: a window opened later was handed its own file.
    if window.label() != "main" {
        return None;
    }
    state.pending.lock().ok()?.take()
}

/// A window says what it is showing, so a later launch can find it.
#[tauri::command]
pub fn launch_showing(
    window: WebviewWindow,
    state: State<'_, LaunchState>,
    idle: bool,
    file: Option<String>,
    tabs: Option<Vec<String>>,
) {
    let showing = match tabs {
        _ if idle => Showing::Idle,
        Some(files) if !files.is_empty() => Showing::Tabs(files.iter().map(|f| fold(f)).collect()),
        _ => Showing::Busy(file.as_deref().map(fold)),
    };
    if let Ok(mut map) = state.showing.lock() {
        map.insert(window.label().to_string(), showing);
    }
}

/// Open a PDF that arrived from outside: from a second launch, or handed back
/// by a window that was no longer free when it arrived.
#[tauri::command]
pub async fn launch_open(app: AppHandle, path: String) -> Result<(), String> {
    route(&app, path).await
}

fn bring_forward(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Where a PDF from outside goes. See the module note.
pub async fn route(app: &AppHandle, path: String) -> Result<(), String> {
    route_with(app, path, true).await
}

/// The same, for an AI app: the PDF opens where it would have, but REDBEAM
/// does not come to the front or take focus from what the person is doing
/// (Aaron, 2026-11-24: "make sure when the agent is working in Red Beam that
/// it doesn't steal focus").
pub async fn route_quietly(app: &AppHandle, path: String) -> Result<(), String> {
    route_with(app, path, false).await
}

async fn route_with(app: &AppHandle, path: String, focus: bool) -> Result<(), String> {
    let state = app.state::<LaunchState>();
    let wanted = fold(&path);
    // Decide under the lock, act after it: a window being built must not
    // wait on a lock its own report is queued behind.
    /*
     * An AI app's file never gets a window of its own while a window is open.
     * A window that has just started, or was just handed another file, has
     * not said what it shows yet; that used to read as "no window is free",
     * and each file an AI app opened in that moment got a new window. Wait
     * for the window to say, and failing that use the main one.
     */
    let mut fallback: Option<String> = None;
    if !focus {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let (free, any) = {
                let mut map = state.showing.lock().map_err(|e| e.to_string())?;
                map.retain(|label, _| app.get_webview_window(label).is_some());
                let windows = app.webview_windows();
                let mut labels: Vec<&String> = windows.keys().filter(|l| l.as_str() == "main" || l.starts_with("view-")).collect();
                labels.sort_by_key(|l| (l.as_str() != "main", l.to_string()));
                (choose(&map, &wanted).is_some(), labels.first().map(|l| (*l).clone()))
            };
            if free || any.is_none() { break }
            if std::time::Instant::now() >= deadline { fallback = any; break }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    }
    let target = {
        let mut map = state.showing.lock().map_err(|e| e.to_string())?;
        map.retain(|label, _| app.get_webview_window(label).is_some());
        let target = choose(&map, &wanted).or_else(|| fallback.map(|l| (l, true)));
        if let Some((label, true)) = &target {
            match map.get_mut(label) {
                // Taken as a tab: a second launch of the same file finds it here.
                Some(Showing::Tabs(files)) => {
                    if !files.contains(&wanted) { files.push(wanted.clone()) }
                }
                // Spoken for: a second file arriving before this one has opened
                // must not land in the same window.
                _ => { map.insert(label.clone(), Showing::Busy(Some(wanted.clone()))); }
            }
        }
        target
    };
    match target {
        Some((label, open)) => {
            let Some(window) = app.get_webview_window(&label) else {
                return Err(format!("window {label} closed"));
            };
            // An AI app's file is always sent: a window still starting can have missed the first.
            if open || !focus {
                // To that window only: `emit` would reach every window.
                app.emit_to(label.as_str(), OPEN_EVENT, &path).map_err(|e| e.to_string())?;
            }
            if focus {
                bring_forward(&window);
            }
            Ok(())
        }
        None => {
            let n = state.windows.fetch_add(1, Ordering::Relaxed) + 1;
            let label = format!("view-{n}");
            crate::window::open_view_window(app, &label, &path, focus)
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    }
}

/// A second `REDBEAM.exe` was started. Its window never appears; this one
/// does what it was asked.
pub fn on_second_launch(app: &AppHandle, argv: Vec<String>, cwd: String) {
    // An AI app's server looking for the app: it is here, and stays put.
    if argv.iter().any(|a| a == FROM_AI_APP) {
        return;
    }
    match pdf_from_args(&argv, Path::new(&cwd)) {
        Some(pdf) => {
            let app = app.clone();
            let path = pdf.display().to_string();
            // Off the main thread: building a window there deadlocks on Windows.
            tauri::async_runtime::spawn(async move {
                if let Err(e) = route(&app, path).await {
                    eprintln!("could not open the file from a second launch: {e}");
                }
            });
        }
        None => {
            // Started from the Start menu again: show what is already open.
            let windows = app.webview_windows();
            let first = windows.get("main").or_else(|| windows.values().next());
            if let Some(window) = first {
                bring_forward(window);
            }
        }
    }
}

// ------------------------------------------------- default PDF viewer --

/// Whether REDBEAM is offered for PDFs, and whether it is the default.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandlerStatus {
    /// False off Windows, where none of this applies.
    pub supported: bool,
    /// The installer registered REDBEAM for .pdf (so it is in Open with and
    /// Default apps).
    pub registered: bool,
    /// The person chose REDBEAM for .pdf.
    pub is_default: bool,
}

#[cfg(windows)]
fn user_choice() -> Option<String> {
    // Windows 11 24H2 moved the choice to UserChoiceLatest; older builds
    // keep UserChoice. Whichever exists is the one Explorer honours.
    const BASE: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf";
    ["UserChoiceLatest", "UserChoice"].iter().find_map(|leaf| {
        windows_registry::CURRENT_USER
            .open(format!(r"{BASE}\{leaf}"))
            .ok()?
            .get_string("ProgId")
            .ok()
    })
}

#[cfg(windows)]
fn registered() -> bool {
    [windows_registry::CURRENT_USER, windows_registry::LOCAL_MACHINE]
        .iter()
        .any(|root| {
            root.open(r"Software\RegisteredApplications")
                .and_then(|k| k.get_string(REGISTERED_NAME))
                .is_ok()
        })
}

#[tauri::command]
pub fn pdf_handler_status() -> HandlerStatus {
    #[cfg(windows)]
    {
        let choice = user_choice();
        HandlerStatus {
            supported: true,
            registered: registered(),
            is_default: choice.is_some_and(|c| c.eq_ignore_ascii_case(PROG_ID)),
        }
    }
    #[cfg(not(windows))]
    {
        HandlerStatus { supported: false, registered: false, is_default: false }
    }
}

/// Open Settings › Apps › Default apps on REDBEAM's own page. Windows 10 and
/// early 11 ignore the query and open the Default apps page itself.
#[tauri::command]
pub fn pdf_handler_choose() -> Result<(), String> {
    #[cfg(windows)]
    {
        let uri = format!("ms-settings:defaultapps?registeredAppUser={REGISTERED_NAME}");
        std::process::Command::new("explorer.exe")
            .arg(uri)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("could not open Windows Settings: {e}"))
    }
    #[cfg(not(windows))]
    {
        Err("default apps are a Windows setting".to_string())
    }
}

/// Whether a PDF's link may be handed to Windows to open: a web or mail
/// address only. Anything else (file:, javascript:, a program path) is a
/// link a drawing has no business launching.
pub fn is_openable_link(url: &str) -> bool {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:"))
        && !u.chars().any(|c| c.is_control() || c == '"')
}

/// Open a web or mail link from a PDF in the person's default browser or mail
/// app. Refuses anything that is not one (see `is_openable_link`).
#[tauri::command]
pub fn open_web_link(url: String) -> Result<(), String> {
    if !is_openable_link(&url) {
        return Err("only web and mail links can be opened".to_string());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(url.trim())
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("could not open the link: {e}"))
    }
    #[cfg(not(windows))]
    {
        Err("opening links is only wired on Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_only_web_and_mail_links() {
        assert!(is_openable_link("https://example.com/spec.pdf"));
        assert!(is_openable_link("HTTP://example.com"));
        assert!(is_openable_link("mailto:someone@example.com"));
        assert!(!is_openable_link("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_openable_link("javascript:alert(1)"));
        assert!(!is_openable_link("C:\\Windows\\notepad.exe"));
        assert!(!is_openable_link("https://example.com/\" & calc"));
    }

    fn temp_pdf(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("redbeam-open-with-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(name);
        std::fs::write(&file, b"%PDF-1.7\n").unwrap();
        (dir, file)
    }

    #[test]
    fn finds_the_pdf_on_a_command_line() {
        let (dir, file) = temp_pdf("Set A.PDF");
        let args = vec!["REDBEAM.exe".to_string(), file.display().to_string()];
        assert_eq!(pdf_from_args(&args, Path::new("/")), Some(file.clone()));
        // Relative to the second launch's own folder.
        let rel = vec!["REDBEAM.exe", "Set A.PDF"];
        assert_eq!(pdf_from_args(&rel, &dir), Some(dir.join("Set A.PDF")));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn ignores_switches_missing_files_and_other_types() {
        let (dir, file) = temp_pdf("b.pdf");
        assert_eq!(pdf_from_args(["REDBEAM.exe"], &dir), None);
        assert_eq!(pdf_from_args(["REDBEAM.exe", "--flag"], &dir), None);
        assert_eq!(pdf_from_args(["REDBEAM.exe", "gone.pdf"], &dir), None);
        assert_eq!(pdf_from_args(["REDBEAM.exe", "notes.txt"], &dir), None);
        // The program itself is never taken for the file.
        assert_eq!(pdf_from_args([file.display().to_string()], &dir), None);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn routes_to_the_window_showing_it_then_a_free_one_then_tabs() {
        let mut map = HashMap::new();
        map.insert("view-1".to_string(), Showing::Busy(Some(fold("C:/a.pdf"))));
        map.insert("main".to_string(), Showing::Tabs(vec![fold("C:/b.pdf"), fold("C:/c.pdf")]));
        // Already open: that window, told to open it only when it is a tab.
        assert_eq!(choose(&map, &fold("c:\\a.pdf")), Some(("view-1".to_string(), false)));
        assert_eq!(choose(&map, &fold("C:/c.pdf")), Some(("main".to_string(), true)));
        // New: the tabbed window takes it.
        assert_eq!(choose(&map, &fold("C:/d.pdf")), Some(("main".to_string(), true)));
        // A start-screen window comes before a tabbed one.
        map.insert("view-2".to_string(), Showing::Idle);
        assert_eq!(choose(&map, &fold("C:/d.pdf")), Some(("view-2".to_string(), true)));
        // Nothing free and no tabs: a new window.
        let mut busy = HashMap::new();
        busy.insert("main".to_string(), Showing::Busy(None));
        assert_eq!(choose(&busy, &fold("C:/d.pdf")), None);
    }

    #[test]
    fn folds_windows_paths() {
        assert_eq!(fold("C:/Jobs/Set.PDF"), fold(r"c:\jobs\set.pdf"));
    }
}
