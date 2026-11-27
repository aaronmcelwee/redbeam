//! A copy of the settings on disk, beside the AI-control flag.
//!
//! The settings live in the webview's localStorage, which is fast and
//! synchronous but is the webview's to keep: a write that has not been
//! committed when the process is ended (the updater closes REDBEAM to run
//! the installer) is lost, and a reset WebView2 profile loses everything.
//! Aaron, 2026-11-27: "settings such as beta custom patterns keep being
//! resetted after updates". The page writes every change here as well, and
//! on launch restores from this file when it is newer than what the webview
//! kept. See src/settings/store.ts.

use std::path::PathBuf;

const IDENTIFIER: &str = "com.redbeam.app";
const FILE: &str = "settings.json";

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// %APPDATA%\com.redbeam.app\settings.json; ~/.config elsewhere. Not tied to
/// the version or the install folder, so every update and the portable copy
/// find the same file.
fn path() -> Option<PathBuf> {
    env_path("APPDATA")
        .or_else(|| env_path("XDG_CONFIG_HOME"))
        .or_else(|| {
            env_path("USERPROFILE")
                .or_else(|| env_path("HOME"))
                .map(|h| h.join(".config"))
        })
        .map(|r| r.join(IDENTIFIER).join(FILE))
}

#[tauri::command]
pub fn settings_file_read() -> Option<String> {
    std::fs::read_to_string(path()?).ok()
}

#[tauri::command]
pub fn settings_file_write(text: String) -> Result<(), String> {
    let path = path().ok_or("no settings folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Written beside and renamed over, so a crash mid-write leaves the old
    // file rather than half of a new one.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}
