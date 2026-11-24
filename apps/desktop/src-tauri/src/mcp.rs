//! `REDBEAM.exe --mcp`: the MCP server Claude and ChatGPT start.
//!
//! The same server as apps/mcp (Node), built into the app so that installing
//! it needs nothing but REDBEAM: the Settings page writes this exe's path and
//! `--mcp` into Claude's or ChatGPT's config (ai_apps.rs), and that app starts
//! it on demand. The tool list is apps/mcp/tools.json, compiled in, so both
//! servers list exactly the same tools.
//!
//! It speaks newline-delimited JSON-RPC on stdin/stdout and forwards each tool
//! call to the running app's bridge (bridge/mod.rs) over loopback. It never
//! opens a window or a project itself. When REDBEAM is not running and AI
//! control is on, the first call starts it and waits for the bridge.
//!
//! This runs before Tauri is built (main.rs), so the single-instance plugin
//! never sees it: an MCP server that handed its arguments to the running copy
//! and exited would look, to Claude, like a server that crashed on start.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const TOOLS_JSON: &str = include_str!("../../../mcp/tools.json");

/// How long one bridge call may take. UI calls time out at 20 s in the app.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to wait for a freshly started REDBEAM to bring its bridge up.
const LAUNCH_WAIT: Duration = Duration::from_secs(30);

struct Spec {
    tools: Value,
    method_of: Value,
    action_of: Value,
}

fn spec() -> Spec {
    let v: Value = serde_json::from_str(TOOLS_JSON).expect("tools.json is valid JSON");
    Spec {
        tools: v["tools"].clone(),
        method_of: v["methodOf"].clone(),
        action_of: v["actionOf"].clone(),
    }
}

const OFF: &str = "AI control is off in REDBEAM. Open REDBEAM, go to Settings > Claude and \
ChatGPT, and turn on \"Let AI apps use REDBEAM\".";

fn discovery() -> Option<(u16, String)> {
    let text = std::fs::read_to_string(crate::bridge::discovery_path()).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let port = u16::try_from(v.get("port")?.as_u64()?).ok()?;
    let token = v.get("token")?.as_str()?.to_string();
    Some((port, token))
}

fn connect(port: u16) -> std::io::Result<TcpStream> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_secs(2))
}

/// Start REDBEAM once per server process. A copy that is already running
/// just comes forward (single instance), which is harmless.
fn launch_app() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let Ok(exe) = std::env::current_exe() else { return };
        let command = || {
            let mut c = std::process::Command::new(&exe);
            c.stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            c
        };
        // Out of the AI app's job, so quitting Claude or ChatGPT (which ends
        // this server) does not close the drawing someone is looking at.
        // A job that forbids breaking away refuses the flag; then start it
        // the plain way.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
            let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
            if command().creation_flags(base | CREATE_BREAKAWAY_FROM_JOB).spawn().is_ok() {
                return;
            }
            let _ = command().creation_flags(base).spawn();
        }
        #[cfg(not(windows))]
        {
            let _ = command().spawn();
        }
    });
}

/// A connection to the bridge, starting REDBEAM if it is not running.
fn reach() -> Result<(TcpStream, String), String> {
    if let Some((port, token)) = discovery() {
        if let Ok(s) = connect(port) {
            return Ok((s, token));
        }
    }
    // Nothing answering. Only start the app when the person has said yes in
    // Settings; otherwise say where the switch is instead of opening a window
    // that would refuse anyway.
    if !crate::ai_apps::enabled_on_disk() {
        return Err(format!("REDBEAM is not running, or {OFF}"));
    }
    launch_app();
    let started = Instant::now();
    while started.elapsed() < LAUNCH_WAIT {
        std::thread::sleep(Duration::from_millis(400));
        if let Some((port, token)) = discovery() {
            if let Ok(s) = connect(port) {
                return Ok((s, token));
            }
        }
    }
    Err("Started REDBEAM, but it did not answer within 30 seconds. If it is open, check \
Settings > Claude and ChatGPT, then try again."
        .into())
}

fn bridge_call(method: &str, params: &Value) -> Result<Value, String> {
    let (mut stream, token) = reach()?;
    let _ = stream.set_read_timeout(Some(CALL_TIMEOUT));
    let line = json!({ "id": 1, "method": method, "token": token, "params": params });
    stream
        .write_all(format!("{line}\n").as_bytes())
        .map_err(|e| format!("could not reach REDBEAM: {e}"))?;
    let mut reply = String::new();
    BufReader::new(stream)
        .read_line(&mut reply)
        .map_err(|e| format!("REDBEAM did not answer {method}: {e}"))?;
    let v: Value = serde_json::from_str(reply.trim()).map_err(|e| format!("bad reply from REDBEAM: {e}"))?;
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(v.get("error").and_then(Value::as_str).unwrap_or("REDBEAM refused the call").to_string())
    }
}

/// One tools/call, as MCP content. Mirrors apps/mcp/index.mjs callTool.
fn call_tool(spec: &Spec, name: &str, args: &Value) -> Result<Value, String> {
    let method = spec.method_of.get(name).and_then(Value::as_str)
        .ok_or_else(|| format!("Unknown REDBEAM tool: {name}"))?;
    let mut params = if args.is_object() { args.clone() } else { json!({}) };
    if let Some(action) = spec.action_of.get(name).and_then(Value::as_str) {
        params["action"] = json!(action);
    }
    let result = bridge_call(method, &params)?;

    // A screenshot goes back as an image, not a 2 MB data URL in text.
    if name == "redbeam_screenshot" {
        if let Some(url) = result.get("dataUrl").and_then(Value::as_str) {
            let data = url.split_once(',').map(|(_, d)| d).unwrap_or(url);
            return Ok(json!({ "content": [{ "type": "image", "data": data, "mimeType": "image/png" }] }));
        }
    }
    let text = serde_json::to_string_pretty(&result).unwrap_or_default();
    let structured = if result.is_object() { result } else { json!({ "value": result }) };
    Ok(json!({ "content": [{ "type": "text", "text": text }], "structuredContent": structured }))
}

/// Answer one JSON-RPC message; None for a notification.
fn handle(spec: &Spec, req: &Value) -> Option<Value> {
    let id = req.get("id").cloned()?;
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(Value::Null);
    let ok = |result: Value| json!({ "jsonrpc": "2.0", "id": id, "result": result });
    Some(match method {
        "initialize" => ok(json!({
            "protocolVersion": params.get("protocolVersion").cloned().unwrap_or(json!("2024-11-05")),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "redbeam", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "REDBEAM is a PDF takeoff app: there are no projects, and each PDF holds its own takeoff. \
Open a drawing with redbeam_open_file, then poll redbeam_get_ui_state until pageCount > 0. \
Look before you draw: redbeam_screenshot shows the sheet. Writes go through \
redbeam_invoke_ui_action and land on REDBEAM's undo stack, so the person can undo them.",
        })),
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({ "tools": spec.tools })),
        "resources/list" => ok(json!({ "resources": [] })),
        "prompts/list" => ok(json!({ "prompts": [] })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match call_tool(spec, name, &args) {
                Ok(r) => ok(r),
                // A tool result, not an RPC error: the agent should read WHY.
                Err(e) => ok(json!({ "content": [{ "type": "text", "text": format!("Error: {e}") }], "isError": true })),
            }
        }
        other => json!({ "jsonrpc": "2.0", "id": id,
            "error": { "code": -32601, "message": format!("Method not found: {other}") } }),
    })
}

/// Run the server until stdin closes.
pub fn serve_stdio() {
    let spec = Arc::new(spec());
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let send = |out: &Arc<Mutex<std::io::Stdout>>, v: &Value| {
        let mut o = out.lock().unwrap_or_else(|e| e.into_inner());
        let _ = writeln!(o, "{v}");
        let _ = o.flush();
    };
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                send(&out, &json!({ "jsonrpc": "2.0", "id": null,
                    "error": { "code": -32700, "message": format!("Parse error: {e}") } }));
                continue;
            }
        };
        // Tool calls can wait on the window for seconds; a ping must not
        // queue behind them, so each request gets its own thread.
        let (spec, out) = (spec.clone(), out.clone());
        std::thread::spawn(move || {
            if let Some(reply) = handle(&spec, &req) {
                send(&out, &reply);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_the_same_tools_as_the_node_server() {
        let s = spec();
        let tools = s.tools.as_array().expect("tools array");
        assert!(tools.len() >= 14);
        for t in tools {
            let name = t["name"].as_str().unwrap();
            assert!(s.method_of.get(name).is_some(), "{name} has no bridge method");
        }
        assert!(tools.iter().any(|t| t["name"] == "redbeam_open_file"));
    }

    #[test]
    fn initialize_and_list() {
        let s = spec();
        let r = handle(&s, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18" } })).unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(r["result"]["serverInfo"]["name"], "redbeam");
        let r = handle(&s, &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
        assert!(r["result"]["tools"].as_array().unwrap().len() >= 14);
        assert!(handle(&s, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).is_none());
    }

    #[test]
    fn unknown_tool_is_a_tool_error_not_a_crash() {
        let s = spec();
        let r = handle(&s, &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "nope", "arguments": {} } })).unwrap();
        assert_eq!(r["result"]["isError"], true);
    }
}
