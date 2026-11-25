//! Automation bridge (plan 11.1).
//!
//! A local, line-oriented JSON socket that lets an agent read and drive this
//! app the way the Qt build's `RedbeamAutomationBridge` did. The protocol is a
//! deliberate port of that one, because it is proven and because it lets the
//! existing MCP server shape carry over:
//!
//!   request   {"id":1,"method":"get_state","token":"…","params":{}}\n
//!   response  {"id":1,"ok":true,"result":{…}}\n
//!             {"id":1,"ok":false,"error":"…"}\n
//!
//! One connection per call. There is no multiplexing and none is wanted: call
//! volume is a handful per second from a driving agent, and a connection per
//! call means a wedged request cannot block the next one.
//!
//! # Why TCP on loopback rather than a named pipe
//!
//! The Qt build used a Windows named pipe. This uses `127.0.0.1` on an
//! ephemeral port, and the trade is worth stating plainly rather than
//! discovering later:
//!
//! * **No new dependency.** A named pipe means `tokio` (or `windows-sys`) as a
//!   direct dependency plus per-platform code. `std::net` is already there.
//! * **Drivable from anything.** A shell, a test, or an MCP server can all
//!   speak it. During development that is the point — the bridge exists to be
//!   driven, and a pipe is awkward from a POSIX shell on Windows.
//! * **The cost:** a pipe carries an OS ACL that limits it to the same user,
//!   whereas any local process can *connect* to a loopback port. The token is
//!   what actually protects both designs — an attacker who can read the
//!   discovery file can read a pipe name from it just as easily — so this is
//!   weaker only against a local process that can connect but cannot read the
//!   user's temp directory. For a single-user internal tool that is an
//!   acceptable trade; it would not be for anything shipped to third parties.
//!
//! The listener binds loopback explicitly, never `0.0.0.0`, so nothing is
//! reachable off the machine.

mod methods;
pub mod ui;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

/// Bridge protocol version. Bump when a method's shape changes incompatibly.
pub const PROTOCOL_VERSION: u32 = 1;

/// Longest request line accepted, so a client that never sends a newline
/// cannot grow the buffer until the process dies.
///
/// It was 4 MB, which a big `create_markups` batch (hundreds of traced areas
/// with curves) can pass (Aaron, 2026-11-24: no arbitrary caps). A gigabyte
/// is past any real call and still ends a runaway; only a process already
/// running on this machine can reach the socket at all.
const MAX_REQUEST_BYTES: u64 = 1024 * 1024 * 1024;

/// Discovery file name.
///
/// Deliberately NOT `redbeam-okular-bridge.json`: that is the Qt build's file,
/// and both apps are routinely running at once during the port. Colliding
/// would point an agent at whichever started last.
const DISCOVERY_FILE: &str = "redbeam-bridge.json";

#[derive(Debug, Serialize)]
pub struct Discovery {
    pub protocol_version: u32,
    pub port: u16,
    pub token: String,
    pub pid: u32,
    /// Absolute path of the open project, or "" when none is open yet.
    pub project_path: String,
}

#[derive(Debug, Deserialize)]
struct Request {
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    params: Value,
    /// Who is calling: `{id, client, label}` from the MCP server (mcp.rs).
    /// Absent from a script or an older server, which is then nobody in
    /// particular and acts on the PDF showing, as every call once did.
    #[serde(default)]
    agent: Value,
    /// The client reads `{"keepalive":true}` lines while the call is still
    /// running (apps/mcp/index.mjs, mcp.rs), so it can wait on long work by
    /// silence rather than by a fixed clock. Old clients leave it off and get
    /// one line, as before.
    #[serde(default)]
    keepalive: bool,
}

/// How often a running call tells a keepalive client it is still running.
const KEEPALIVE_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

pub fn discovery_path() -> PathBuf {
    std::env::temp_dir().join(DISCOVERY_FILE)
}

/// The listener's port and token, once it has started.
///
/// The bridge can now be switched on and off from Settings (Claude and
/// ChatGPT), not only by REDBEAM_BRIDGE at launch. A listener thread cannot
/// be stopped cleanly, so switching off keeps the socket and refuses every
/// call instead, and removes the discovery file so nothing finds it. Switching
/// back on reuses the same port and token.
static LISTENING: std::sync::OnceLock<(u16, String)> = std::sync::OnceLock::new();

/// Whether calls are answered. False while switched off in Settings.
static ACCEPTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Is the bridge answering calls right now?
pub fn accepting() -> bool {
    ACCEPTING.load(std::sync::atomic::Ordering::SeqCst)
}

/// Stop answering and take the discovery file away (Settings switched off,
/// or the app is exiting). Only removes a file this process wrote, so a
/// second copy started for a test cannot pull the rug from the first.
pub fn stop() {
    ACCEPTING.store(false, std::sync::atomic::Ordering::SeqCst);
    if LISTENING.get().is_none() {
        return;
    }
    let ours = std::fs::read_to_string(discovery_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("pid").and_then(|p| p.as_u64()))
        == Some(u64::from(std::process::id()));
    if ours {
        clear_discovery();
    }
}

/// Start the bridge, or return why it could not start.
///
/// A failure here must never take the app down with it: the bridge is
/// automation, and an estimator with a takeoff open does not care that a debug
/// socket could not bind. Callers log and continue.
pub fn start(app: AppHandle) -> Result<Discovery, String> {
    if let Some((port, token)) = LISTENING.get() {
        // Switched back on: same socket, same token, file written again.
        write_discovery(&Discovery {
            protocol_version: PROTOCOL_VERSION,
            port: *port,
            token: token.clone(),
            pid: std::process::id(),
            project_path: String::new(),
        })?;
        ACCEPTING.store(true, std::sync::atomic::Ordering::SeqCst);
        return Ok(Discovery {
            protocol_version: PROTOCOL_VERSION,
            port: *port,
            token: String::new(),
            pid: std::process::id(),
            project_path: String::new(),
        });
    }
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("bridge could not bind loopback: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("bridge has no local address: {e}"))?
        .port();

    let token = fresh_token();
    let discovery = Discovery {
        protocol_version: PROTOCOL_VERSION,
        port,
        token: token.clone(),
        pid: std::process::id(),
        project_path: String::new(),
    };
    write_discovery(&discovery)?;
    let _ = LISTENING.set((port, token.clone()));
    ACCEPTING.store(true, std::sync::atomic::Ordering::SeqCst);

    std::thread::Builder::new()
        .name("redbeam-bridge".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let app = app.clone();
                let token = token.clone();
                // A panic in one request must not take the listener with it,
                // and a slow method must not block the next caller.
                let _ = std::thread::Builder::new()
                    .name("redbeam-bridge-conn".into())
                    .spawn(move || {
                        let _ = serve(stream, &app, &token);
                    });
            }
        })
        .map_err(|e| format!("bridge thread would not start: {e}"))?;

    Ok(Discovery {
        protocol_version: PROTOCOL_VERSION,
        port,
        token: String::new(), // never echoed back to a caller
        pid: std::process::id(),
        project_path: String::new(),
    })
}

fn serve(stream: TcpStream, app: &AppHandle, token: &str) -> std::io::Result<()> {
    // Cap BEFORE buffering: a client that never sends a newline would
    // otherwise grow the buffer until the process died.
    let mut reader = BufReader::new(stream.try_clone()?.take(MAX_REQUEST_BYTES));
    let mut line = String::new();
    reader.read_line(&mut line)?;

    let mut out = stream;
    let response = match serde_json::from_str::<Request>(line.trim()) {
        Err(_) if line.len() as u64 >= MAX_REQUEST_BYTES && !line.ends_with('\n') => json!({
            "id": Value::Null, "ok": false,
            "error": "request is larger than 1 GB; send it in parts",
        }),
        Err(e) => json!({ "id": Value::Null, "ok": false, "error": format!("bad request: {e}") }),
        Ok(req) => {
            if !token_matches(&req.token, token) {
                // Say nothing about what was wrong with it.
                json!({ "id": req.id, "ok": false, "error": "unauthorized" })
            } else if !accepting() {
                json!({ "id": req.id, "ok": false, "error":
                    "AI control is off. Turn on Settings > Claude and ChatGPT > Let AI apps use REDBEAM." })
            } else if req.keepalive {
                // The work runs beside this thread, which says "still
                // running" to the client until the answer is in.
                let (tx, rx) = std::sync::mpsc::channel();
                let (app2, method, params) = (app.clone(), req.method.clone(), req.params.clone());
                std::thread::spawn(move || {
                    let _ = tx.send(methods::dispatch(&app2, &method, &params));
                });
                let answer = loop {
                    match rx.recv_timeout(KEEPALIVE_EVERY) {
                        Ok(a) => break a,
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            out.write_all(b"{\"keepalive\":true}\n")?;
                            out.flush()?;
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            break Err("the call stopped without an answer".to_string())
                        }
                    }
                };
                match answer {
                    Ok(result) => json!({ "id": req.id, "ok": true, "result": result }),
                    Err(e) => json!({ "id": req.id, "ok": false, "error": e }),
                }
            } else {
                // One connection, one thread, one call: whatever this call
                // asks of a window carries who asked (ui.rs).
                ui::set_caller(req.agent.clone());
                match methods::dispatch(app, &req.method, &req.params) {
                    Ok(result) => json!({ "id": req.id, "ok": true, "result": result }),
                    Err(e) => json!({ "id": req.id, "ok": false, "error": e }),
                }
            }
        }
    };

    let mut text = serde_json::to_string(&response).unwrap_or_else(|_| {
        r#"{"ok":false,"error":"response could not be serialized"}"#.to_string()
    });
    text.push('\n');
    out.write_all(text.as_bytes())?;
    out.flush()
}

/// Length-independent comparison, so a wrong token cannot be probed one byte
/// at a time by timing. Cheap insurance; the loop is a few dozen bytes.
fn token_matches(given: &str, expected: &str) -> bool {
    let a = given.as_bytes();
    let b = expected.as_bytes();
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        let x = *a.get(i).unwrap_or(&0) as usize;
        let y = *b.get(i).unwrap_or(&0) as usize;
        diff |= x ^ y;
    }
    diff == 0
}

/// A fresh per-launch token.
///
/// Built from `RandomState`, whose keys the standard library seeds from the OS
/// once per process. This is NOT a cryptographic RNG and is not claimed to be;
/// it is unpredictable enough that a local process cannot guess it, which is
/// the whole job. Adding a crypto dependency to generate one string would cost
/// more than it buys here.
fn fresh_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::with_capacity(32);
    for salt in 0u64..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(salt);
        h.write_u32(std::process::id());
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn write_discovery(d: &Discovery) -> Result<(), String> {
    let path = discovery_path();
    let text = serde_json::to_string_pretty(&json!({
        "protocolVersion": d.protocol_version,
        "port": d.port,
        "token": d.token,
        "pid": d.pid,
        "projectPath": d.project_path,
        "transport": "tcp-loopback",
    }))
    .map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Remove the discovery file.
///
/// Best effort on shutdown. A stale file is not fatal — a client that connects
/// to a dead port gets a connection error, which is a clearer failure than a
/// silent hang — but leaving one behind invites confusion about which process
/// is being driven.
pub fn clear_discovery() {
    let _ = std::fs::remove_file(discovery_path());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_comparison_is_length_independent_and_correct() {
        assert!(token_matches("abc", "abc"));
        assert!(!token_matches("abc", "abd"));
        assert!(!token_matches("ab", "abc"));
        assert!(!token_matches("abcd", "abc"));
        assert!(!token_matches("", "abc"));
        // An empty expected token must never be satisfiable by an empty guess
        // in practice, but the comparison itself is honest about equality.
        assert!(token_matches("", ""));
    }

    #[test]
    fn tokens_differ_between_launches() {
        // A fixed token would let anything that ever saw one drive every later
        // session.
        let a = fresh_token();
        let b = fresh_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn discovery_file_does_not_collide_with_the_qt_build() {
        // Both apps run at once during the port; one file would point an agent
        // at whichever started last.
        assert_ne!(DISCOVERY_FILE, "redbeam-okular-bridge.json");
        assert!(discovery_path().ends_with("redbeam-bridge.json"));
    }
}
