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
use std::sync::{Arc, Mutex, Once, OnceLock};
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
    instructions: Value,
}

fn spec() -> Spec {
    let v: Value = serde_json::from_str(TOOLS_JSON).expect("tools.json is valid JSON");
    Spec {
        tools: v["tools"].clone(),
        method_of: v["methodOf"].clone(),
        action_of: v["actionOf"].clone(),
        instructions: v["instructions"].clone(),
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

/// Start REDBEAM once per server process. The flag tells a copy that is
/// already running to stay where it is: it used to come forward (and out of
/// the taskbar) each time an AI app's server could not reach it within two
/// seconds, over whatever the person was working in.
fn launch_app() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let Ok(exe) = std::env::current_exe() else { return };
        let command = || {
            let mut c = std::process::Command::new(&exe);
            c.arg(crate::open_with::FROM_AI_APP);
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

// ------------------------------------------------------------- identity --

/// This server process, told apart from every other one talking to the same
/// REDBEAM: its pid and the moment it started.
fn session() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{:x}-{:x}", std::process::id(), nanos & 0xffff_ffff_ffff)
    })
}

/// The AI app on the other end, as it named itself in `initialize`.
static CLIENT: Mutex<Option<String>> = Mutex::new(None);
/// Every identity this server has called REDBEAM as, to say goodbye for.
static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The input every tool takes so several agents can share one connection.
const AGENT_ARG: &str = "agent";

/// Who a call is from: this server, or the named worker inside it.
///
/// Several agents work in REDBEAM at once, each in tabs of its own with its
/// own colour and cursor (Aaron, 2026-11-24). One AI app is one server
/// process, so the process is the agent — unless the app runs several
/// workers over one connection, which then say which one is calling.
fn identity(label: Option<&str>) -> Value {
    let label = label.map(str::trim).filter(|l| !l.is_empty());
    let id = match label {
        Some(l) => format!("{}/{}", session(), l.to_lowercase()),
        None => session().to_string(),
    };
    {
        let mut seen = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        if !seen.contains(&id) {
            seen.push(id.clone());
        }
    }
    let client = CLIENT.lock().unwrap_or_else(|e| e.into_inner()).clone();
    json!({ "id": id, "client": client, "label": label })
}

/// The tool list with the shared `agent` input added to every tool.
fn tools_with_agent(tools: &Value) -> Value {
    let mut tools = tools.clone();
    if let Some(list) = tools.as_array_mut() {
        for tool in list {
            let schema = &mut tool["inputSchema"];
            if !schema.is_object() {
                *schema = json!({ "type": "object", "properties": {} });
            }
            if !schema["properties"].is_object() {
                schema["properties"] = json!({});
            }
            if schema["properties"].get(AGENT_ARG).is_none() {
                schema["properties"][AGENT_ARG] = json!({
                    "type": "string",
                    "description": "Only when several agents share this connection (sub-agents, parallel workers): a short name of your own, the same on every call. Each name gets its own tabs, colour and cursor in REDBEAM.",
                });
            }
        }
    }
    tools
}

/// Tell REDBEAM this server's agents are gone, if it is running. Never
/// starts it: a goodbye is not a reason to open a window.
fn say_goodbye() {
    let ids = SEEN.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if ids.is_empty() {
        return;
    }
    let Some((port, token)) = discovery() else { return };
    let client = CLIENT.lock().unwrap_or_else(|e| e.into_inner()).clone();
    for id in ids {
        let Ok(mut stream) = connect(port) else { return };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
        let line = json!({ "id": 1, "method": "agent_bye", "token": token, "params": {},
            "agent": { "id": id, "client": client } });
        if stream.write_all(format!("{line}\n").as_bytes()).is_ok() {
            let mut reply = String::new();
            let _ = BufReader::new(stream).read_line(&mut reply);
        }
    }
}

fn bridge_call(method: &str, params: &Value, agent: &Value) -> Result<Value, String> {
    let (mut stream, token) = reach()?;
    let _ = stream.set_read_timeout(Some(CALL_TIMEOUT));
    let line = json!({ "id": 1, "method": method, "token": token, "params": params, "agent": agent });
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
    // Who is calling is not an input of the tool: it rides beside them.
    let label = params
        .as_object_mut()
        .and_then(|o| o.remove(AGENT_ARG))
        .and_then(|v| v.as_str().map(str::to_owned));
    if let Some(action) = spec.action_of.get(name).and_then(Value::as_str) {
        params["action"] = json!(action);
    }
    let result = bridge_call(method, &params, &identity(label.as_deref()))?;

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
        "initialize" => {
            // "claude-ai", "claude-code", "codex-mcp-client": what REDBEAM
            // names this agent after.
            if let Some(name) = params.pointer("/clientInfo/name").and_then(Value::as_str) {
                *CLIENT.lock().unwrap_or_else(|e| e.into_inner()) = Some(name.to_string());
            }
            ok(json!({
            "protocolVersion": params.get("protocolVersion").cloned().unwrap_or(json!("2024-11-05")),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "redbeam", "version": env!("CARGO_PKG_VERSION") },
            "instructions": spec.instructions,
            }))
        }
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({ "tools": tools_with_agent(&spec.tools) })),
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
    // The AI app closed the connection: its agents' tabs stay open in
    // REDBEAM, marked as finished rather than as still at work.
    say_goodbye();
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
    fn every_tool_takes_an_agent_name() {
        let s = spec();
        let r = handle(&s, &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
        for t in r["result"]["tools"].as_array().unwrap() {
            assert_eq!(t["inputSchema"]["properties"]["agent"]["type"], "string", "{}", t["name"]);
        }
        // tools.json itself stays as it was: the Node server adds its own.
        assert!(s.tools.as_array().unwrap().iter().all(|t| t["inputSchema"]["properties"].get("agent").is_none()));
    }

    #[test]
    fn a_named_worker_is_its_own_agent() {
        let whole = identity(None);
        let a = identity(Some("Framing"));
        let b = identity(Some(" framing "));
        let c = identity(Some("ceilings"));
        assert_eq!(whole["id"], session());
        assert_ne!(a["id"], whole["id"]);
        // The same worker, however it capitalized its name this time.
        assert_eq!(a["id"], b["id"]);
        assert_ne!(a["id"], c["id"]);
        assert_eq!(a["label"], "Framing");
        assert!(identity(Some("  "))["label"].is_null());
    }

    #[test]
    fn unknown_tool_is_a_tool_error_not_a_crash() {
        let s = spec();
        let r = handle(&s, &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "nope", "arguments": {} } })).unwrap();
        assert_eq!(r["result"]["isError"], true);
    }
}
