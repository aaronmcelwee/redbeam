//! Claude and ChatGPT, in Settings (Aaron, 2026-11-20: "one click install on
//! Claude or ChatGPT, so they can drive REDBEAM").
//!
//! Two halves:
//!
//! * **The switch.** "Let AI apps use REDBEAM" turns the automation bridge
//!   (bridge/mod.rs) on and off while the app runs, and is remembered in a
//!   small file beside the app's config so the next launch starts it too.
//!   REDBEAM_BRIDGE=1 still works for driven test runs.
//! * **The installs.** REDBEAM.exe is its own MCP server (`REDBEAM.exe --mcp`,
//!   mcp.rs). Installing writes that one command into each app's config:
//!   - Claude desktop: `claude_desktop_config.json`, in %APPDATA%\Claude and,
//!     for the Store/MSIX build, in its package's redirected copy.
//!   - Claude Code, when it is set up: `~/.claude.json`.
//!   - ChatGPT desktop: `~/.codex/config.toml`, which the ChatGPT desktop app
//!     shares with Codex. ChatGPT on the web cannot reach a program on this
//!     computer at all, and the page says so.
//!
//! Every write keeps everything else in the file, goes through a temp file
//! and a rename, and refuses to touch a file it cannot parse: an install
//! button must never be how someone loses their other servers.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::AppHandle;

/// The name REDBEAM is listed under in every app.
pub const SERVER_NAME: &str = "redbeam";

/// Matches tauri.conf.json's identifier, so this is the folder Tauri's
/// app_config_dir resolves to. Computed by hand because `--mcp` runs without
/// an AppHandle and must find the same file.
const IDENTIFIER: &str = "com.redbeam.app";
const FLAG_FILE: &str = "ai-control";

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn home() -> Option<PathBuf> {
    env_path("USERPROFILE").or_else(|| env_path("HOME"))
}

/// %APPDATA% on Windows; ~/.config elsewhere (tests, the Linux dev build).
fn roaming() -> Option<PathBuf> {
    env_path("APPDATA")
        .or_else(|| env_path("XDG_CONFIG_HOME"))
        .or_else(|| home().map(|h| h.join(".config")))
}

fn flag_path() -> Option<PathBuf> {
    roaming().map(|r| r.join(IDENTIFIER).join(FLAG_FILE))
}

/// Has the person switched AI control on? Read at launch and by `--mcp`.
pub fn enabled_on_disk() -> bool {
    flag_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|t| t.trim() == "on")
        .unwrap_or(false)
}

fn set_enabled_on_disk(on: bool) -> Result<(), String> {
    let path = flag_path().ok_or("no settings folder")?;
    if on {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, "on").map_err(|e| e.to_string())
    } else {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

fn exe() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .map_err(|e| format!("could not find REDBEAM.exe: {e}"))
}

// ------------------------------------------------------------ the files --

/// The Claude desktop config files to write. The Store build reads a copy
/// redirected into its package folder; both are written when both exist.
fn claude_desktop_configs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(local) = env_path("LOCALAPPDATA") {
        if let Ok(entries) = std::fs::read_dir(local.join("Packages")) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with("Claude_") {
                    out.push(
                        e.path()
                            .join("LocalCache")
                            .join("Roaming")
                            .join("Claude")
                            .join("claude_desktop_config.json"),
                    );
                }
            }
        }
    }
    if let Some(r) = roaming() {
        let classic = r.join("Claude");
        // The classic folder whenever it exists, and as the fallback when
        // nothing is found, so an install before Claude's first run works.
        if classic.is_dir() || out.is_empty() {
            out.push(classic.join("claude_desktop_config.json"));
        }
    }
    out
}

fn claude_detected() -> bool {
    claude_desktop_configs().iter().any(|p| p.parent().map(Path::is_dir).unwrap_or(false))
}

fn claude_code_config() -> Option<PathBuf> {
    home().map(|h| h.join(".claude.json")).filter(|p| p.is_file())
}

fn codex_config() -> Option<PathBuf> {
    env_path("CODEX_HOME")
        .or_else(|| home().map(|h| h.join(".codex")))
        .map(|d| d.join("config.toml"))
}

fn chatgpt_detected() -> bool {
    let codex = codex_config().and_then(|p| p.parent().map(Path::is_dir)).unwrap_or(false);
    let store_app = env_path("LOCALAPPDATA")
        .and_then(|l| std::fs::read_dir(l.join("Packages")).ok())
        .map(|it| {
            it.flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with("OpenAI.ChatGPT"))
        })
        .unwrap_or(false);
    codex || store_app
}

/// Write via a temp file and a rename, so a crash mid-write leaves the old
/// file rather than half of a new one.
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("redbeam-tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{}: {e}", path.display())
    })
}

fn read_json(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(t) if t.trim().is_empty() => Ok(json!({})),
        Ok(t) => {
            let v: Value = serde_json::from_str(&t).map_err(|e| {
                format!("{} is not valid JSON ({e}); fix or remove it, then try again", path.display())
            })?;
            if v.is_object() { Ok(v) } else { Err(format!("{} is not a JSON object", path.display())) }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

fn server_entry(exe: &str) -> Value {
    json!({ "command": exe, "args": ["--mcp"] })
}

/// Add or replace `mcpServers.redbeam`, keeping everything else.
pub fn json_with_server(mut doc: Value, exe: &str) -> Value {
    let root = doc.as_object_mut().expect("read_json returns objects");
    let servers = root.entry("mcpServers").or_insert_with(|| Value::Object(Map::new()));
    if !servers.is_object() {
        *servers = Value::Object(Map::new());
    }
    servers
        .as_object_mut()
        .expect("just made an object")
        .insert(SERVER_NAME.into(), server_entry(exe));
    doc
}

/// Take `mcpServers.redbeam` out, keeping everything else.
pub fn json_without_server(mut doc: Value) -> Value {
    if let Some(servers) = doc.get_mut("mcpServers").and_then(Value::as_object_mut) {
        servers.remove(SERVER_NAME);
    }
    doc
}

fn json_has_server(path: &Path, exe: &str) -> bool {
    read_json(path)
        .ok()
        .and_then(|d| d.get("mcpServers")?.get(SERVER_NAME)?.get("command")?.as_str().map(str::to_owned))
        .map(|c| c.eq_ignore_ascii_case(exe))
        .unwrap_or(false)
}

fn write_json_server(path: &Path, exe: Option<&str>) -> Result<(), String> {
    if exe.is_none() && !path.is_file() {
        return Ok(());
    }
    let doc = read_json(path)?;
    let doc = match exe {
        Some(exe) => json_with_server(doc, exe),
        None => json_without_server(doc),
    };
    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    write_atomic(path, &(text + "\n"))
}

/// A TOML basic string.
fn toml_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Is this line the header of REDBEAM's table, or of one nested under it?
fn is_our_header(line: &str) -> bool {
    let t = line.trim();
    if !t.starts_with('[') {
        return false;
    }
    let inner = t.trim_start_matches('[').split(']').next().unwrap_or("").trim();
    let compact: String = inner.chars().filter(|c| !c.is_whitespace()).collect();
    ["mcp_servers.redbeam", "mcp_servers.\"redbeam\""]
        .iter()
        .any(|h| compact == *h || compact.starts_with(&format!("{h}.")))
}

/// Remove REDBEAM's `[mcp_servers.redbeam]` table (and its sub-tables),
/// leaving every other line exactly as it was.
pub fn toml_without_server(text: &str) -> String {
    let mut out = Vec::new();
    let mut skipping = false;
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with('[') {
            skipping = is_our_header(line);
        }
        if !skipping {
            out.push(line);
        }
    }
    while out.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        out.pop();
    }
    let mut s = out.join("\n");
    if !s.is_empty() {
        s.push('\n');
    }
    s
}

/// Add (or replace) REDBEAM's table at the end of the file.
pub fn toml_with_server(text: &str, exe: &str) -> String {
    let mut s = toml_without_server(text);
    if !s.is_empty() {
        s.push('\n');
    }
    s.push_str(&format!(
        "# Added by REDBEAM (Settings > Claude and ChatGPT).\n[mcp_servers.{SERVER_NAME}]\ncommand = {}\nargs = [\"--mcp\"]\n",
        toml_str(exe)
    ));
    s
}

fn toml_has_server(path: &Path, exe: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    let mut inside = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            inside = is_our_header(line);
            continue;
        }
        if inside && t.starts_with("command") {
            return t.contains(&toml_str(exe)) || t.contains(&format!("'{exe}'"));
        }
    }
    false
}

// ------------------------------------------------------------ commands --

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientStatus {
    pub id: &'static str,
    /// The app looks installed on this computer.
    pub detected: bool,
    /// REDBEAM is in its config, pointing at this copy.
    pub installed: bool,
    /// The files an install writes, for the page to name.
    pub files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub supported: bool,
    /// The switch: remembered across launches.
    pub enabled: bool,
    /// The bridge is answering right now.
    pub running: bool,
    pub clients: Vec<ClientStatus>,
}

fn status() -> AiStatus {
    let exe = exe().unwrap_or_default();
    let claude_files: Vec<PathBuf> = claude_desktop_configs()
        .into_iter()
        .chain(claude_code_config())
        .collect();
    let claude_installed = claude_files.iter().any(|p| json_has_server(p, &exe));
    let codex = codex_config();
    AiStatus {
        supported: cfg!(windows),
        enabled: enabled_on_disk(),
        running: crate::bridge::accepting(),
        clients: vec![
            ClientStatus {
                id: "claude",
                detected: claude_detected() || claude_code_config().is_some(),
                installed: claude_installed,
                files: claude_files.iter().map(|p| p.display().to_string()).collect(),
            },
            ClientStatus {
                id: "chatgpt",
                detected: chatgpt_detected(),
                installed: codex.as_deref().map(|p| toml_has_server(p, &exe)).unwrap_or(false),
                files: codex.iter().map(|p| p.display().to_string()).collect(),
            },
        ],
    }
}

#[tauri::command]
pub fn ai_apps_status() -> AiStatus {
    status()
}

/// The switch. On starts the bridge now and on every later launch.
#[tauri::command]
pub fn ai_apps_set_enabled(app: AppHandle, enabled: bool) -> Result<AiStatus, String> {
    set_enabled_on_disk(enabled)?;
    if enabled {
        crate::bridge::start(app)?;
    } else {
        crate::bridge::stop();
    }
    Ok(status())
}

/// One click: write REDBEAM into the app's config and switch AI control on,
/// since an install that then refuses every call is not what was asked for.
#[tauri::command]
pub fn ai_apps_install(app: AppHandle, client: String) -> Result<AiStatus, String> {
    let exe = exe()?;
    match client.as_str() {
        "claude" => {
            for p in claude_desktop_configs().iter().chain(claude_code_config().iter()) {
                write_json_server(p, Some(&exe))?;
            }
        }
        "chatgpt" => {
            let p = codex_config().ok_or("no home folder")?;
            let text = match std::fs::read_to_string(&p) {
                Ok(t) => t,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(e) => return Err(format!("{}: {e}", p.display())),
            };
            write_atomic(&p, &toml_with_server(&text, &exe))?;
        }
        other => return Err(format!("unknown app: {other}")),
    }
    set_enabled_on_disk(true)?;
    crate::bridge::start(app)?;
    Ok(status())
}

#[tauri::command]
pub fn ai_apps_remove(client: String) -> Result<AiStatus, String> {
    match client.as_str() {
        "claude" => {
            for p in claude_desktop_configs().iter().chain(claude_code_config().iter()) {
                write_json_server(p, None)?;
            }
        }
        "chatgpt" => {
            if let Some(p) = codex_config().filter(|p| p.is_file()) {
                let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
                write_atomic(&p, &toml_without_server(&text))?;
            }
        }
        other => return Err(format!("unknown app: {other}")),
    }
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_install_keeps_other_servers_and_settings() {
        let doc = json!({ "mcpServers": { "files": { "command": "npx" } }, "theme": "light" });
        let out = json_with_server(doc, r"C:\Program Files\REDBEAM\REDBEAM.exe");
        assert_eq!(out["theme"], "light");
        assert_eq!(out["mcpServers"]["files"]["command"], "npx");
        assert_eq!(out["mcpServers"]["redbeam"]["command"], r"C:\Program Files\REDBEAM\REDBEAM.exe");
        assert_eq!(out["mcpServers"]["redbeam"]["args"], json!(["--mcp"]));
        let back = json_without_server(out);
        assert!(back["mcpServers"].get("redbeam").is_none());
        assert_eq!(back["mcpServers"]["files"]["command"], "npx");
    }

    #[test]
    fn json_install_into_an_empty_file() {
        let out = json_with_server(json!({}), "x.exe");
        assert_eq!(out["mcpServers"]["redbeam"]["command"], "x.exe");
    }

    #[test]
    fn toml_install_replaces_only_our_table() {
        let before = "model = \"o4\"\n\n[mcp_servers.files]\ncommand = \"npx\"\n\n[mcp_servers.redbeam]\ncommand = \"old.exe\"\nargs = [\"--mcp\"]\n\n[mcp_servers.redbeam.env]\nA = \"1\"\n\n[profiles.x]\nmodel = \"y\"\n";
        let out = toml_with_server(before, r"C:\Apps\REDBEAM.exe");
        assert!(out.contains("[mcp_servers.files]\ncommand = \"npx\""));
        assert!(out.contains("[profiles.x]\nmodel = \"y\""));
        assert!(!out.contains("old.exe"));
        assert!(!out.contains("[mcp_servers.redbeam.env]"));
        assert!(out.contains("command = \"C:\\\\Apps\\\\REDBEAM.exe\""));
        assert_eq!(out.matches("[mcp_servers.redbeam]").count(), 1);
        let removed = toml_without_server(&out);
        assert!(!removed.contains("redbeam]"));
        assert!(removed.contains("[profiles.x]"));
    }

    #[test]
    fn toml_install_into_nothing() {
        let out = toml_with_server("", "r.exe");
        assert!(out.starts_with("# Added by REDBEAM"));
        assert!(out.contains("[mcp_servers.redbeam]\ncommand = \"r.exe\"\nargs = [\"--mcp\"]\n"));
    }

    #[test]
    fn other_tables_named_like_ours_are_left_alone() {
        assert!(!is_our_header("[mcp_servers.redbeam2]"));
        assert!(is_our_header("[ mcp_servers.redbeam ]"));
        assert!(is_our_header("[mcp_servers.\"redbeam\".env]"));
    }
}
