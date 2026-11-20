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
//! the start screen opens it, and otherwise it opens in a new window (Light
//! is one file per window).

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
) {
    let showing = if idle { Showing::Idle } else { Showing::Busy(file.as_deref().map(fold)) };
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
    let state = app.state::<LaunchState>();
    let wanted = fold(&path);
    // Decide under the lock, act after it: a window being built must not
    // wait on a lock its own report is queued behind.
    let target = {
        let mut map = state.showing.lock().map_err(|e| e.to_string())?;
        map.retain(|label, _| app.get_webview_window(label).is_some());
        let already = map
            .iter()
            .find(|(_, s)| **s == Showing::Busy(Some(wanted.clone())))
            .map(|(label, _)| (label.clone(), false));
        let free = || {
            // The main window first, so a fresh start fills the window on screen.
            let mut idle: Vec<&String> =
                map.iter().filter(|(_, s)| **s == Showing::Idle).map(|(l, _)| l).collect();
            idle.sort_by_key(|l| (l.as_str() != "main", l.as_str().to_string()));
            idle.first().map(|l| ((*l).clone(), true))
        };
        let target = already.or_else(free);
        if let Some((label, true)) = &target {
            // Spoken for: a second file arriving before this one has opened
            // must not land in the same window.
            map.insert(label.clone(), Showing::Busy(Some(wanted.clone())));
        }
        target
    };
    match target {
        Some((label, open)) => {
            let Some(window) = app.get_webview_window(&label) else {
                return Err(format!("window {label} closed"));
            };
            if open {
                // To that window only: `emit` would reach every window.
                app.emit_to(label.as_str(), OPEN_EVENT, &path).map_err(|e| e.to_string())?;
            }
            bring_forward(&window);
            Ok(())
        }
        None => {
            let n = state.windows.fetch_add(1, Ordering::Relaxed) + 1;
            let label = format!("view-{n}");
            crate::window::open_view_window(app, &label, &path)
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    }
}

/// A second `REDBEAM.exe` was started. Its window never appears; this one
/// does what it was asked.
pub fn on_second_launch(app: &AppHandle, argv: Vec<String>, cwd: String) {
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn folds_windows_paths() {
        assert_eq!(fold("C:/Jobs/Set.PDF"), fold(r"c:\jobs\set.pdf"));
    }
}
