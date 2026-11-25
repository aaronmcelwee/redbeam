//! The portable copy: REDBEAM.exe run from an unzipped folder, never installed.
//!
//! Some PCs will not run the installer (a policy that blocks setup programs,
//! an installer opened from inside a zip, no rights to install). The release
//! also ships `REDBEAM_<version>_<arch>_portable.zip`: the same REDBEAM.exe
//! beside a `REDBEAM.portable` marker file. The marker is what tells this copy
//! it was not installed, so it does not offer to run the installer as its
//! update (that would install a second copy and leave this one on the old
//! version). It points at the new portable zip instead.
//!
//! WebView2 is the one thing the exe cannot carry. Windows 11 has it, and so
//! does any Windows 10 PC with a current Edge. Two ways in for a PC without
//! it: a fixed-version runtime unzipped into a `WebView2` folder beside the
//! exe is used automatically, and otherwise REDBEAM says what is missing and
//! offers Microsoft's download page, instead of failing with no window.

use std::path::PathBuf;

/// The marker file the portable zip carries beside REDBEAM.exe.
pub const MARKER: &str = "REDBEAM.portable";

/// Where the newest portable copy is, for the update row. The update Worker
/// serves it from R2, so it downloads without a GitHub sign-in.
pub const LATEST_X64: &str =
    "https://redbeam-updates.trackchairking.workers.dev/files/REDBEAM_latest_x64_portable.zip";
pub const LATEST_ARM64: &str =
    "https://redbeam-updates.trackchairking.workers.dev/files/REDBEAM_latest_arm64_portable.zip";

const WEBVIEW2_DOWNLOAD: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(PathBuf::from)
}

/// Is this the copy from the portable zip?
pub fn is_portable() -> bool {
    exe_dir().map(|dir| dir.join(MARKER).is_file()).unwrap_or(false)
}

/// The download for this build's architecture.
pub fn latest_download() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        LATEST_ARM64
    } else {
        LATEST_X64
    }
}

/// Run before any window is made. Returns false when there is no WebView2 to
/// draw a window with; the person has been told, and the app should exit.
pub fn prepare_webview() -> bool {
    // A fixed-version runtime unzipped beside the exe. The WebView2 loader
    // reads this variable itself; an explicit setting from outside wins.
    if std::env::var_os("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER").is_none() {
        if let Some(folder) = exe_dir().map(|d| d.join("WebView2")) {
            if folder.join("msedgewebview2.exe").is_file() {
                std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &folder);
            }
        }
    }
    if tauri::webview_version().is_ok() {
        return true;
    }
    tell_webview2_missing();
    false
}

#[cfg(windows)]
fn tell_webview2_missing() {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, kind: u32) -> i32;
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    const MB_OKCANCEL: u32 = 0x1;
    const MB_ICONWARNING: u32 = 0x30;
    const IDOK: i32 = 1;
    let text = wide(
        "REDBEAM needs the Microsoft Edge WebView2 Runtime, and this PC does not have it.\n\n\
         Press OK to open Microsoft's download page. The \"Evergreen Bootstrapper\" installs \
         it without admin rights. Then start REDBEAM again.\n\n\
         If installing is blocked on this PC, download the \"Fixed Version\" runtime instead \
         and unzip it into a folder named WebView2 beside REDBEAM.exe.",
    );
    let caption = wide("REDBEAM");
    let answer = unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), MB_OKCANCEL | MB_ICONWARNING) };
    if answer == IDOK {
        let _ = std::process::Command::new("explorer.exe").arg(WEBVIEW2_DOWNLOAD).spawn();
    }
}

#[cfg(not(windows))]
fn tell_webview2_missing() {
    eprintln!("REDBEAM needs a system webview. See {WEBVIEW2_DOWNLOAD}");
}

/// What the update row needs to know about this copy.
#[derive(serde::Serialize)]
pub struct PortableInfo {
    portable: bool,
    download: &'static str,
}

#[tauri::command]
pub fn app_portable() -> PortableInfo {
    PortableInfo { portable: is_portable(), download: latest_download() }
}

/// Open the newest portable zip in the default browser. Only the fixed
/// Worker URLs above, never one the page passes in.
#[tauri::command]
pub fn portable_open_download() -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg(latest_download())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
